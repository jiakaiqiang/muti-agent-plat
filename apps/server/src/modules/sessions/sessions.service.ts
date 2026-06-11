import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  Agent,
  AgentTask,
  CollaborationEvent,
  SessionDetail,
  SessionStatus,
  SessionWorkingDirectory,
  WorkspaceSnapshot
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { messages } from '../../common/messages.js';
import { reworkMaxRounds } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { extractServerWorkspacePath, scanServerWorkspace } from '../../common/workspace-scanner.js';
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
  workspaceSnapshot?: WorkspaceSnapshot;
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
    const workspaceBinding = await this.resolveWorkspaceBinding(input);
    const session: SessionDetail = {
      id: crypto.randomUUID(),
      title: this.titleFromInput(input.input),
      originalInput: input.input,
      status: 'AGENT_DISCUSSING',
      ownerId: 'local-user',
      workspaceId: 'default-workspace',
      projectId: input.projectId,
      knowledgeBaseIds: input.knowledgeBaseIds ?? [],
      workingDirectory: workspaceBinding.workingDirectory,
      workspaceSnapshot: workspaceBinding.workspaceSnapshot,
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

  private async resolveWorkspaceBinding(input: CreateSessionInput) {
    if (input.workspaceSnapshot) {
      return {
        workingDirectory: input.workingDirectory,
        workspaceSnapshot: input.workspaceSnapshot
      };
    }

    const path = extractServerWorkspacePath(input.input);
    if (!path) {
      return {
        workingDirectory: input.workingDirectory,
        workspaceSnapshot: undefined
      };
    }

    try {
      return await scanServerWorkspace(path);
    } catch (error) {
      return {
        workingDirectory: input.workingDirectory,
        workspaceSnapshot: undefined,
        scanError: error instanceof Error ? error.message : String(error)
      };
    }
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
        content: messages.confirmMemoryWrite,
        metadata: createMetadata('confirmation_card', {
          confirmationId: crypto.randomUUID(),
          reason: 'confirm_memory_write',
          title: messages.confirmMemoryWriteTitle,
          description: messages.confirmMemoryWriteDescription,
          candidate: {
            content,
            sourceEventId: event.id,
            scope: 'long_term_candidate',
            confidence: 0.72
          },
          options: [
            { key: 'approve', label: messages.saveMemory, style: 'primary' },
            { key: 'reject', label: messages.skipMemory, style: 'default' }
          ]
        })
      });
    }

    if (handlingPlan.intent === 'preference_input') {
      this.touchSession(session);
    } else if (handlingPlan.shouldPause) {
      const relevantAgentIds = this.relevantAgentIds(session, content, handlingPlan.affectedAgentIds);
      this.recordAgentRequirementContext(session, content, event.id, relevantAgentIds);

      // 创建插话任务并立即标记完成（插话内容已通过记忆分发给相关 agent）
      const assignedAgentId = relevantAgentIds[0] || this.pickSessionAgent(session, ['coordinator']).id;
      const interruptTask: AgentTask = {
        id: crypto.randomUUID(),
        sessionId: session.id,
        title: '处理用户执行中插话',
        description: content,
        status: 'completed',
        assigneeAgentId: assignedAgentId,
        dependsOnTaskIds: [],
        acceptanceCriteria: [],
        resultSummary: '已将插话内容分发给相关 Agent 作为执行上下文。',
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      this.tasks.list(session.id).push(interruptTask);

      this.events.create({
        sessionId: session.id,
        type: 'task_created',
        fromAgentId: assignedAgentId,
        content: `任务已创建：${interruptTask.title}`,
        metadata: createMetadata('system_notice', {
          taskId: interruptTask.id,
          title: interruptTask.title,
          assigneeAgentId: assignedAgentId
        })
      });

      this.events.create({
        sessionId: session.id,
        type: 'session_status_changed',
        priority: 'high',
        content: `执行中收到用户插话，已创建任务 [${interruptTask.title}] 并分发给相关 Agent。`,
        metadata: createMetadata('system_notice', {
          status: session.status,
          reason: 'executing_user_interrupt_task_created',
          sourceEventId: event.id,
          affectedAgentIds: relevantAgentIds,
          taskId: interruptTask.id
        })
      });
      this.touchSession(session);
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

  reviseBrief(
    sessionId: string,
    briefId: string,
    input: { reason?: string; userMessage?: string; confirmationId?: string } = {}
  ) {
    const session = this.get(sessionId);
    if (session.currentTaskBriefId !== briefId) {
      throw new BadRequestException(`Brief is not current: ${briefId}`);
    }
    const brief = this.orchestrator.getBrief(session.id, briefId);
    if (!brief) {
      throw new BadRequestException(`Brief not found: ${briefId}`);
    }

    const content = (input.userMessage || input.reason || '用户要求修改当前任务契约。').trim();
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    const userEvent = this.events.create({
      sessionId,
      type: 'user_message',
      userMessageIntent: 'correction',
      priority: 'high',
      content,
      toAgentIds: [coordinator.id],
      metadata: createMetadata('chat_message', {
        text: content,
        mentionedAgentIds: [coordinator.id],
        relatedBriefId: briefId,
        revisionOfBriefId: briefId
      })
    });

    this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: '用户选择修改当前任务契约。',
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: 'rejected',
        selectedOptionKey: 'revise',
        relatedBriefId: briefId
      })
    });

    this.events.create({
      sessionId,
      type: 'brief_rejected',
      fromAgentId: coordinator.id,
      content: '当前任务契约已进入修订，Coordinator 将基于用户修改重新组织讨论。',
      metadata: createMetadata('system_notice', {
        briefId,
        reason: content,
        coordinatorAgentId: coordinator.id
      })
    });

    this.reopenRequirementLoop(session, content, userEvent, [coordinator.id], 'brief_revision_requested');
    return { accepted: true, sessionId: session.id, status: session.status, event: userEvent };
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
          ? messages.outcomeRework(reason)
          : outcome.kind === 'ask_user'
            ? messages.outcomeAskUser(reason)
            : messages.outcomeFailed(reason),
      metadata: createMetadata(outcome.kind === 'failed' ? 'error_card' : 'system_notice', {
        status: nextStatus,
        outcome: outcome.kind,
        reason
      })
    });
    if (outcome.kind === 'rework') {
      this.startRework(session, reason);
    }
  }

  /**
   * Automatically re-drives execution after a post-review `rework` outcome.
   * Bounded by REWORK_MAX_ROUNDS (default 1); beyond the limit the session is
   * handed to the user instead of looping.
   */
  private startRework(session: SessionDetail, reason: string) {
    const reworkRounds = this.events
      .list(session.id)
      .filter(
        (event) =>
          event.type === 'session_status_changed' &&
          (event.metadata?.payload as { outcome?: string } | undefined)?.outcome === 'rework'
      ).length;
    const maxRounds = reworkMaxRounds();
    if (reworkRounds > maxRounds) {
      this.setStatus(session, 'WAIT_USER_DECISION');
      this.events.create({
        sessionId: session.id,
        type: 'user_confirmation_requested',
        priority: 'high',
        content: messages.reworkLimitReached(maxRounds),
        metadata: createMetadata('confirmation_card', {
          confirmationId: crypto.randomUUID(),
          reason: 'rework_limit_reached',
          title: messages.reworkLimitTitle,
          description: `${messages.reworkLimitReached(maxRounds)}${reason ? ` 复盘意见：${reason}` : ''}`,
          options: [
            { key: 'resume', label: messages.reworkResume, style: 'primary' },
            { key: 'cancel', label: messages.reworkCancel, style: 'default' }
          ]
        })
      });
      return;
    }

    const brief = session.currentTaskBriefId
      ? this.orchestrator.getBrief(session.id, session.currentTaskBriefId)
      : undefined;
    if (!brief) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: messages.reworkBriefMissing });
      return;
    }

    this.tasks.resetForRework(session.id);
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: messages.reworkStarted(reworkRounds, maxRounds),
      metadata: createMetadata('system_notice', {
        status: 'REWORKING',
        reworkRound: reworkRounds,
        maxReworkRounds: maxRounds,
        reason
      })
    });
    this.execution.start(session, brief, this.tasks.unfinished(session.id), (outcome) =>
      this.applyOutcome(session.id, outcome)
    );
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
      content: reason ?? messages.sessionStatusUpdated(nextStatus),
      metadata: createMetadata('system_notice', { status: nextStatus, requestedStatus: status, reason })
    });
    const confirmationEvent = confirmationId
      ? this.events.create({
          sessionId,
          type: 'user_confirmation_resolved',
          content: status === 'CANCELLED' ? messages.userSelectedCancel : messages.userSelectedResume,
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
      content: messages.memoryConfirmed,
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

  decideFeishuNotification(
    sessionId: string,
    input: {
      confirmationId?: string;
      notificationDraftArtifactId?: string;
      decision: 'send_notification' | 'skip_notification';
    }
  ) {
    const session = this.get(sessionId);
    const approved = input.decision === 'send_notification';
    const resolvedEvent = this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: approved ? '用户确认发送飞书通知。' : '用户选择不发送飞书通知。',
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: approved ? 'approved' : 'rejected',
        selectedOptionKey: input.decision,
        reason: 'confirm_feishu_notification',
        notificationDraftArtifactId: input.notificationDraftArtifactId
      })
    });
    const notificationEvent = approved
      ? this.events.create({
          sessionId,
          type: 'tool_completed',
          content: '飞书通知已确认发送（dry-run 记录）。',
          metadata: createMetadata('tool_card', {
            invocationId: crypto.randomUUID(),
            capabilityId: 'cap-feishu-draft',
            capabilityKey: 'notification.feishu_draft',
            capabilityName: '飞书通知',
            riskLevel: 'medium',
            status: 'completed',
            approvalKey: input.confirmationId,
            outputSummary: '用户已确认发送飞书通知；当前实现记录 dry-run 通知动作，不直接调用外部飞书接口。'
          })
        })
      : this.events.create({
          sessionId,
          type: 'agent_message',
          content: '已按用户选择跳过飞书通知，仅保留通知草稿供后续查看。',
          metadata: createMetadata('chat_message', {
            messageKind: 'decision',
            relatedArtifactIds: input.notificationDraftArtifactId ? [input.notificationDraftArtifactId] : []
          })
        });
    this.touchSession(session);
    return { session, resolvedEvent, notificationEvent };
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
      content: `会话在${messages.phaseLabel(phase)}阶段失败：${message}`,
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
    const fullMessage = `会话在${phaseLabel}阶段失败：${message}`;
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
      REWORKING: ['WAIT_USER_DECISION', 'CANCELLED', 'EXECUTING'],
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
    this.tasks.cancelUnfinished(session.id, messages.requirementChangedCancelTasks);
    const relevantAgentIds = this.relevantAgentIds(session, content, affectedAgentIds);
    this.recordAgentRequirementContext(session, content, sourceEvent.id, relevantAgentIds);
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: messages.requirementChangedNotice,
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
        content: messages.requirementUpdateForAgent(agent.name, content),
        sourceEventId,
        confidence: 0.9
      });
      this.events.create({
        sessionId: session.id,
        type: 'agent_status_changed',
        fromAgentId: agentId,
        content: messages.agentMarkedUpdateRelevant(agent.name),
        metadata: createMetadata('system_notice', {
          agentId,
          status: 'thinking',
          thoughtSummary: messages.agentUpdateThought,
          actionSummary: messages.agentUpdateAction,
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
      this.applyOutcome(session.id, { kind: 'ask_user', reason: messages.resumeBriefMissing });
      return;
    }
    const brief = this.orchestrator.getBrief(session.id, session.currentTaskBriefId);
    if (!brief) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: messages.resumeBriefMissing });
      return;
    }
    this.tasks.resetStaleRunning(session.id);
    const unfinishedTasks = this.tasks.unfinished(session.id);
    this.execution.start(session, brief, unfinishedTasks, (outcome) => this.applyOutcome(session.id, outcome));
  }

  private titleFromInput(input: string) {
    return input.trim().slice(0, 28) || '新协作会话';
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
      throw new Error(messages.noAvailableAgent);
    }
    return fallback;
  }

  private persist() {
    this.persistence.setCollection('sessions', [...this.sessions.values()]);
  }
}

