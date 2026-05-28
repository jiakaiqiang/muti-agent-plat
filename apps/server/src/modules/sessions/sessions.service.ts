import { Injectable, NotFoundException } from '@nestjs/common';
import type { SessionDetail, SessionStatus } from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { AgentsService } from '../agents/agents.service.js';
import { EventsService } from '../events/events.service.js';
import { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { UserMessageRouterService } from '../user-message-router/user-message-router.service.js';

type CreateSessionInput = {
  input: string;
  agentIds?: string[];
  projectId?: string;
  tokenBudget?: number;
  knowledgeBaseIds?: string[];
};

@Injectable()
export class SessionsService {
  private readonly sessions = new Map<string, SessionDetail>();

  constructor(
    private readonly agents: AgentsService,
    private readonly events: EventsService,
    private readonly router: UserMessageRouterService,
    private readonly orchestrator: OrchestratorService,
    private readonly persistence: PersistenceService
  ) {
    const persisted = this.persistence.getCollection<SessionDetail[]>('sessions', []);
    for (const session of persisted) {
      this.sessions.set(session.id, session);
    }
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
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
      metadata: createMetadata('chat_message', {
        text: input.input,
        mentionedAgentIds: []
      })
    });

    const brief = await this.orchestrator.discussAndCreateBrief(session);
    this.setStatus(session, 'WAIT_USER_CONFIRM');
    session.currentTaskBriefId = brief.id;
    this.persist();

    return { session, firstEvent };
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

    this.events.create({
      sessionId,
      type: 'agent_message',
      fromAgentId: this.agents.getByIdOrKey('coordinator').id,
      toAgentIds: mentionedAgentIds,
      content: handlingPlan.coordinatorInstruction,
      metadata: createMetadata('chat_message', {
        messageKind: 'decision',
        handlingPlan
      })
    });

    return { event, handlingPlan };
  }

  async confirmBrief(sessionId: string, briefId: string) {
    const session = this.get(sessionId);
    this.setStatus(session, 'EXECUTING');
    const result = await this.orchestrator.confirmBrief(session, briefId);
    this.setStatus(session, 'COMPLETED');
    return result;
  }

  listBriefs(sessionId: string) {
    return this.orchestrator.listBriefs(sessionId);
  }

  control(sessionId: string, status: SessionStatus, reason?: string) {
    const session = this.get(sessionId);
    this.setStatus(session, status);
    const event = this.events.create({
      sessionId,
      type: 'session_status_changed',
      content: reason ?? `Session status changed to ${status}`,
      metadata: createMetadata('system_notice', { status, reason })
    });
    return { session, event };
  }

  private setStatus(session: SessionDetail, status: SessionStatus) {
    session.status = status;
    session.updatedAt = nowIso();
    this.persist();
  }

  private titleFromInput(input: string) {
    return input.trim().slice(0, 28) || '新协作会话';
  }

  private persist() {
    this.persistence.setCollection('sessions', [...this.sessions.values()]);
  }
}
