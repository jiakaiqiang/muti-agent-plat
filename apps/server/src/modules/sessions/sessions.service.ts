import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Agent, CollaborationEvent, SessionDetail, SessionStatus, SessionWorkingDirectory } from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { messages } from '../../common/messages.js';
import { nowIso } from '../../common/time.js';
import { AgentsService } from '../agents/agents.service.js';
import { EventsService } from '../events/events.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { ExecutionOutcome, OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { ExecutionService } from '../execution/execution.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { UserMessageRouterService } from '../user-message-router/user-message-router.service.js';

type CreateSessionInput = {
  input: string;
  agentIds?: string[];
  projectId?: string;
  tokenBudget?: number;
  knowledgeBaseIds?: string[];
  workingDirectory?: SessionWorkingDirectory;
};

@Injectable()
export class SessionsService {
  private readonly sessions = new Map<string, SessionDetail>();
  private readonly briefGenerationSeqBySession = new Map<string, number>();

  constructor(
    private readonly agents: AgentsService,
    private readonly events: EventsService,
    private readonly memories: MemoryService,
    private readonly router: UserMessageRouterService,
    private readonly orchestrator: OrchestratorService,
    private readonly execution: ExecutionService,
    private readonly tasks: TasksService,
    private readonly persistence: PersistenceService
  ) {
    const persisted = this.persistence.getCollection<SessionDetail[]>('sessions', []);
    for (const session of persisted) {
      this.sessions.set(session.id, session);
    }
  }

  list() {
    return [...this.sessions.values()]
      .sort((left, right) => this.compareSessionRecency(left, right))
      .map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status,
        tokenBudget: session.tokenBudget,
        tokenUsed: session.tokenUsed,
        agentCount: session.participatingAgentIds.length,
        requiresUserAction: ['WAIT_USER_CONFIRM', 'WAIT_USER_DECISION'].includes(session.status),
        latestEventSummary: this.events.list(session.id).at(-1)?.content,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }));
  }

  get(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }
    return session;
  }

  listRaw() {
    return [...this.sessions.values()];
  }

  delete(sessionId: string) {
    const session = this.get(sessionId);
    this.execution.cancel(sessionId);
    this.sessions.delete(sessionId);
    this.briefGenerationSeqBySession.delete(sessionId);
    this.tasks.deleteSession(sessionId);
    this.memories.deleteSession(sessionId);
    this.events.deleteSession(sessionId);
    this.orchestrator.deleteSession(sessionId);
    this.persist();
    return { deleted: true, sessionId: session.id };
  }

  async create(input: CreateSessionInput) {
    const now = nowIso();
    const participatingAgentIds = this.agents.resolveIds(input.agentIds);
    const session: SessionDetail = {
      id: crypto.randomUUID(),
      title: this.titleFromInput(input.input),
      originalInput: input.input,
      status: 'AGENT_DISCUSSING',
      ownerId: 'local-user',
      workspaceId: 'default-workspace',
      projectId: input.projectId,
      knowledgeBaseIds: input.knowledgeBaseIds ?? [],
      workingDirectory: input.workingDirectory,
      tokenBudget: input.tokenBudget,
      tokenUsed: 0,
      participatingAgentIds,
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(session.id, session);
    this.persist();

    const firstEvent = this.events.create({
      sessionId: session.id,
      type: 'user_message',
      userMessageIntent: 'clarification',
      priority: 'normal',
      content: input.input,
      toAgentIds: participatingAgentIds,
      metadata: createMetadata('chat_message', {
        text: input.input,
        mentionedAgentIds: participatingAgentIds
      })
    });

    this.generateBriefInBackground(session);

    return { session, firstEvent };
  }

  private generateBriefInBackground(session: SessionDetail) {
    const generationSeq = (this.briefGenerationSeqBySession.get(session.id) ?? 0) + 1;
    this.briefGenerationSeqBySession.set(session.id, generationSeq);
    void this.orchestrator
      .discussAndCreateBrief(session)
      .then((brief) => {
        if (this.briefGenerationSeqBySession.get(session.id) !== generationSeq) {
          return;
        }
        session.currentTaskBriefId = brief.id;
        this.setStatus(session, 'WAIT_USER_CONFIRM');
      })
      .catch((error) => this.failSessionWithFullError(session, error, 'brief_generation'));
  }

  async sendMessage(sessionId: string, content: string, mentionedAgentIds: string[] = []) {
    const session = this.get(sessionId);
    const handlingPlan = this.router.route(content, session.status);
    const event = this.events.create({
      sessionId,
      type: 'user_message',
      userMessageIntent: handlingPlan.intent,
      priority: handlingPlan.priority,
      content,
      toAgentIds: mentionedAgentIds,
      metadata: createMetadata('chat_message', {
        text: content,
        mentionedAgentIds
      })
    });

    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    this.events.create({
      sessionId,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      toAgentIds: mentionedAgentIds,
      content: handlingPlan.coordinatorInstruction,
      metadata: createMetadata('chat_message', {
        messageKind: 'decision',
        handlingPlan
      })
    });

    if (handlingPlan.intent === 'preference_input') {
      this.events.create({
        sessionId,
        type: 'user_confirmation_requested',
        priority: 'normal',
        content: 'Please confirm whether this preference should be saved as long-term memory.',
        metadata: createMetadata('confirmation_card', {
          confirmationId: crypto.randomUUID(),
          reason: 'confirm_memory_write',
          title: 'Confirm memory write',
          description: 'After confirmation, this preference will be stored as a long-term memory candidate.',
          candidate: {
            content,
            sourceEventId: event.id,
            scope: 'long_term_candidate',
            confidence: 0.72
          },
          options: [
            { key: 'approve', label: 'Save memory', style: 'primary' },
            { key: 'reject', label: 'Skip', style: 'default' }
          ]
        })
      });
    }

    if (handlingPlan.shouldPause) {
      this.reopenRequirementLoop(session, content, event, handlingPlan.affectedAgentIds, 'executing_user_interrupt');
    } else if (this.shouldReopenRequirementLoop(session.status, handlingPlan.requiresBriefRevision)) {
      this.reopenRequirementLoop(session, content, event, handlingPlan.affectedAgentIds, 'user_requirement_supplement');
    } else {
      this.touchSession(session);
    }


    return { event, handlingPlan };
  }

  async confirmBrief(sessionId: string, briefId: string) {
    const session = this.get(sessionId);
    if (session.currentTaskBriefId !== briefId) {
      throw new BadRequestException(`Brief is not current: ${briefId}`);
    }
    const { brief, tasks } = this.orchestrator.prepareExecution(session, briefId);
    session.currentTaskBriefId = brief.id;
    this.setStatus(session, 'EXECUTING');
    this.execution.start(session, brief, tasks, (outcome) => this.applyOutcome(session.id, outcome));
    return { accepted: true, sessionId: session.id, status: session.status, createdTasks: tasks };
  }

  /** Applied when the background execution pipeline finishes. */
  applyOutcome(sessionId: string, outcome: ExecutionOutcome) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'CANCELLED' || session.status === 'COMPLETED') {
      return;
    }
    if (outcome.kind === 'cancelled') {
      return;
    }
    if (session.status === 'WAIT_USER_DECISION' && outcome.kind !== 'ask_user') {
      return;
    }
    const nextStatus: SessionStatus =
      outcome.kind === 'delivered'
        ? 'COMPLETED'
        : outcome.kind === 'rework'
          ? 'REWORKING'
          : outcome.kind === 'ask_user'
            ? 'WAIT_USER_DECISION'
            : 'FAILED';
    this.setStatus(session, nextStatus);
    if (outcome.kind === 'delivered') {
      return;
    }
    const reason = 'reason' in outcome ? outcome.reason : '';
    this.events.create({
      sessionId,
      type: outcome.kind === 'failed' ? 'error_reported' : 'session_status_changed',
      priority: 'high',
      content:
        outcome.kind === 'rework'
          ? `Post-review requested rework: ${reason}`
          : outcome.kind === 'ask_user'
            ? `Execution paused and is waiting for user input: ${reason}`
            : `Execution failed: ${reason}`,
      metadata: createMetadata(outcome.kind === 'failed' ? 'error_card' : 'system_notice', {
        status: nextStatus,
        outcome: outcome.kind,
        reason
      })
    });
  }

  listBriefs(sessionId: string) {
    return this.orchestrator.listBriefs(sessionId);
  }

  control(sessionId: string, status: SessionStatus, reason?: string, confirmationId?: string) {
    const session = this.get(sessionId);
    this.assertControlTransition(session.status, status);
    const nextStatus = status === 'EXECUTING' && this.hasFinalDelivery(sessionId) ? 'COMPLETED' : status;
    this.setStatus(session, nextStatus);
    if (nextStatus === 'WAIT_USER_DECISION' || nextStatus === 'CANCELLED') {
      this.execution.cancel(sessionId);
    }
    const event = this.events.create({
      sessionId,
      type: 'session_status_changed',
      content: reason ?? `Session status updated to ${nextStatus}`,
      metadata: createMetadata('system_notice', { status: nextStatus, requestedStatus: status, reason })
    });
    const confirmationEvent = confirmationId
      ? this.events.create({
          sessionId,
          type: 'user_confirmation_resolved',
      content: `User selected ${status === 'CANCELLED' ? 'cancel' : 'resume'}`,
          metadata: createMetadata('system_notice', {
            confirmationId,
            status: status === 'CANCELLED' ? 'rejected' : 'approved',
            selectedOptionKey: status === 'CANCELLED' ? 'cancel' : 'resume'
          })
        })
      : undefined;
    if (nextStatus === 'EXECUTING') {
      this.resumeExecution(session);
    }
    return { session, event, confirmationEvent };
  }

  confirmMemory(
    sessionId: string,
    input: {
      content: string;
      confirmationId?: string;
      sourceEventId?: string;
      confidence?: number;
    }
  ) {
    this.get(sessionId);
    const memory = this.memories.create({
      sessionId,
      scope: 'long_term_candidate',
      content: input.content,
      sourceEventId: input.sourceEventId,
      confidence: input.confidence ?? 0.72
    });
    const event = this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: 'Long-term memory candidate has been confirmed.',
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: 'approved',
        selectedOptionKey: 'approve',
        reason: 'confirm_memory_write',
        memoryId: memory.id
      })
    });
    this.touchSession(this.get(sessionId));
    return { memory, event };
  }

  private compareSessionRecency(left: SessionDetail, right: SessionDetail) {
    return this.sessionRecencyTime(right) - this.sessionRecencyTime(left);
  }

  private sessionRecencyTime(session: SessionDetail) {
    return Date.parse(session.updatedAt || session.createdAt) || Date.parse(session.createdAt) || 0;
  }

  private touchSession(session: SessionDetail) {
    session.updatedAt = nowIso();
    this.persist();
  }

  private setStatus(session: SessionDetail, status: SessionStatus) {
    session.status = status;
    session.updatedAt = nowIso();
    this.persist();
  }

  private failSession(session: SessionDetail, error: unknown, phase: string) {
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus(session, 'FAILED');
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: `Session failed during ${phase}: ${message}`,
      metadata: createMetadata('system_notice', {
        status: 'FAILED',
        phase,
        message
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'error_reported',
      priority: 'high',
      content: message,
      metadata: createMetadata('error_card', {
        phase,
        message
      })
    });
  }

  private failSessionWithFullError(session: SessionDetail, error: unknown, phase: string) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const phaseLabel = messages.phaseLabel(phase);
    const fullMessage = `Session failed during ${phaseLabel}: ${message}`;
    this.setStatus(session, 'FAILED');
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: fullMessage,
      metadata: createMetadata('system_notice', {
        status: 'FAILED',
        phase,
        phaseLabel,
        message,
        fullMessage,
        stack
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'error_reported',
      priority: 'high',
      content: fullMessage,
      metadata: createMetadata('error_card', {
        phase,
        phaseLabel,
        message,
        fullMessage,
        stack
      })
    });
  }

  private assertControlTransition(current: SessionStatus, next: SessionStatus) {
    const allowed: Partial<Record<SessionStatus, SessionStatus[]>> = {
      AGENT_DISCUSSING: ['CANCELLED'],
      WAIT_USER_CONFIRM: ['REVISING_BRIEF', 'CANCELLED'],
      REVISING_BRIEF: ['WAIT_USER_CONFIRM', 'CANCELLED'],
      EXECUTING: ['WAIT_USER_DECISION', 'CANCELLED'],
      POST_REVIEW: ['WAIT_USER_DECISION', 'CANCELLED'],
      REWORKING: ['WAIT_USER_DECISION', 'CANCELLED'],
      WAIT_USER_DECISION: ['EXECUTING', 'CANCELLED'],
      COMPLETED: [],
      FAILED: [],
      CANCELLED: []
    };
    if (!(allowed[current] ?? []).includes(next)) {
      throw new BadRequestException(`Invalid session transition: ${current} -> ${next}`);
    }
  }

  private hasFinalDelivery(sessionId: string) {
    return this.events.list(sessionId).some((event) => event.type === 'final_delivery_created');
  }

  private shouldReopenRequirementLoop(status: SessionStatus, requiresBriefRevision: boolean) {
    return (
      requiresBriefRevision ||
      ['AGENT_DISCUSSING', 'WAIT_USER_CONFIRM', 'REVISING_BRIEF', 'WAIT_USER_DECISION'].includes(status)
    );
  }

  private reopenRequirementLoop(
    session: SessionDetail,
    content: string,
    sourceEvent: CollaborationEvent,
    affectedAgentIds: string[],
    reason: string
  ) {
    this.execution.cancel(session.id);
    this.tasks.cancelUnfinished(session.id, 'User supplied a new or updated requirement before task completion.');
    const relevantAgentIds = this.relevantAgentIds(session, content, affectedAgentIds);
    this.recordAgentRequirementContext(session, content, sourceEvent.id, relevantAgentIds);
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content:
        'User input changed the working requirement. Agents will restate understanding and request confirmation before assigning work.',
      metadata: createMetadata('system_notice', {
        status: 'AGENT_DISCUSSING',
        reason,
        sourceEventId: sourceEvent.id,
        affectedAgentIds: relevantAgentIds
      })
    });
    this.setStatus(session, 'AGENT_DISCUSSING');
    this.generateBriefInBackground(session);
  }

  private recordAgentRequirementContext(
    session: SessionDetail,
    content: string,
    sourceEventId: string,
    relevantAgentIds: string[]
  ) {
    for (const agentId of relevantAgentIds) {
      const agent = this.agents.findByIdOrKey(agentId);
      if (!agent) {
        continue;
      }
      this.memories.create({
        sessionId: session.id,
        agentId,
        scope: 'session',
        content: `User requirement update relevant to ${agent.name}: ${content}`,
        sourceEventId,
        confidence: 0.9
      });
      this.events.create({
        sessionId: session.id,
        type: 'agent_status_changed',
        fromAgentId: agentId,
        content: `${agent.name} marked the user update as relevant and added it to its session context.`,
        metadata: createMetadata('system_notice', {
          agentId,
          status: 'thinking',
          thoughtSummary: 'Relevant requirement update added to agent context.',
          actionSummary: 'Will use this update during the next understanding and execution pass.',
          sourceEventId
        })
      });
    }
  }

  private relevantAgentIds(session: SessionDetail, content: string, affectedAgentIds: string[]) {
    const agents = this.participatingAgents(session);
    const explicit = new Set(affectedAgentIds);
    for (const agent of agents) {
      if (
        content.includes(agent.id) ||
        content.includes(`@${agent.key}`) ||
        content.includes(`@${agent.name}`) ||
        new RegExp(this.escapeRegExp(agent.key), 'i').test(content) ||
        new RegExp(this.escapeRegExp(agent.name), 'i').test(content)
      ) {
        explicit.add(agent.id);
      }
    }
    return Array.from(explicit.size ? explicit : new Set(agents.map((agent) => agent.id)));
  }

  private escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private resumeExecution(session: SessionDetail) {
    if (!session.currentTaskBriefId) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: 'Cannot resume execution: current task brief not found.' });
      return;
    }
    const brief = this.orchestrator.getBrief(session.id, session.currentTaskBriefId);
    if (!brief) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: 'Cannot resume execution: task brief does not exist.' });
      return;
    }
    this.tasks.resetStaleRunning(session.id);
    const unfinishedTasks = this.tasks.unfinished(session.id);
    this.execution.start(session, brief, unfinishedTasks, (outcome) => this.applyOutcome(session.id, outcome));
  }

  private titleFromInput(input: string) {
    return input.trim().slice(0, 28) || 'New collaboration session';
  }

  private participatingAgents(session: SessionDetail) {
    const agents = session.participatingAgentIds
      .map((agentId) => this.agents.findByIdOrKey(agentId))
      .filter((agent): agent is Agent => Boolean(agent));
    return agents.length ? agents : this.agents.list();
  }

  private pickSessionAgent(session: SessionDetail, preferredKeys: string[]) {
    const agents = this.participatingAgents(session);
    for (const key of preferredKeys) {
      const preferred = agents.find((agent) => agent.key === key);
      if (preferred) {
        return preferred;
      }
    }
    const fallback = agents[0];
    if (!fallback) {
      throw new Error('Current session has no available Agent.');
    }
    return fallback;
  }

  private persist() {
    this.persistence.setCollection('sessions', [...this.sessions.values()]);
  }
}

