import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Agent, SessionDetail, SessionStatus } from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { AgentsService } from '../agents/agents.service.js';
import { EventsService } from '../events/events.service.js';
import { MemoryService } from '../memory/memory.service.js';
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
    private readonly memories: MemoryService,
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

    try {
      const brief = await this.orchestrator.discussAndCreateBrief(session);
      this.setStatus(session, 'WAIT_USER_CONFIRM');
      session.currentTaskBriefId = brief.id;
      this.persist();
    } catch (error) {
      this.failSession(session, error, 'brief_generation');
    }

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
      this.memories.create({
        sessionId,
        scope: 'long_term_candidate',
        content,
        sourceEventId: event.id,
        confidence: 0.72
      });
    }

    if (handlingPlan.shouldPause) {
      this.setStatus(session, 'WAIT_USER_DECISION');
      const confirmationId = crypto.randomUUID();
      this.events.create({
        sessionId,
        type: 'session_status_changed',
        priority: 'high',
        content: '用户插话影响当前执行，已暂停相关任务并等待用户决策。',
        metadata: createMetadata('system_notice', {
          status: 'WAIT_USER_DECISION',
          reason: 'executing_user_interrupt',
          handlingPlan
        })
      });
      this.events.create({
        sessionId,
        type: 'user_confirmation_requested',
        priority: 'high',
        content: '请确认如何处理执行中的新增约束。',
        metadata: createMetadata('confirmation_card', {
          confirmationId,
          reason: 'resolve_contract_conflict',
          title: '处理执行中插话',
          description:
            '新增约束可能影响已确认的任务契约。请选择继续执行或取消当前任务。',
          options: [
            { key: 'resume', label: '继续执行', style: 'primary' },
            { key: 'cancel', label: '取消任务', style: 'danger' }
          ],
          handlingPlan
        })
      });
    }

    // 根据意图触发相应的执行流程
    if (handlingPlan.intent === 'question') {
      await this.orchestrator.handleQuestion(session, content);
    } else if (handlingPlan.intent === 'clarification' || handlingPlan.intent === 'constraint') {
      await this.orchestrator.handleClarificationOrConstraint(session, content, handlingPlan.intent);
    } else if (handlingPlan.intent === 'command') {
      // 命令类消息（暂停/继续/取消）由前端直接调用对应的 API，这里不处理
    } else if (handlingPlan.intent === 'preference_input' || handlingPlan.intent === 'knowledge_input') {
      // 偏好和知识输入已在上面处理（存 memory），不需要额外执行
    } else {
      // 其他意图（correction 等）视为新任务请求
      await this.orchestrator.handleNewTaskRequest(session, content);
    }

    return { event, handlingPlan };
  }

  async confirmBrief(sessionId: string, briefId: string) {
    const session = this.get(sessionId);
    this.setStatus(session, 'EXECUTING');
    try {
      const result = await this.orchestrator.confirmBrief(session, briefId);
      if (session.status === 'EXECUTING') {
        this.setStatus(session, 'COMPLETED');
      }
      return result;
    } catch (error) {
      this.failSession(session, error, 'confirmed_execution');
      throw error;
    }
  }

  listBriefs(sessionId: string) {
    return this.orchestrator.listBriefs(sessionId);
  }

  control(sessionId: string, status: SessionStatus, reason?: string, confirmationId?: string) {
    const session = this.get(sessionId);
    this.assertControlTransition(session.status, status);
    const nextStatus = status === 'EXECUTING' && this.hasFinalDelivery(sessionId) ? 'COMPLETED' : status;
    this.setStatus(session, nextStatus);
    const event = this.events.create({
      sessionId,
      type: 'session_status_changed',
      content: reason ?? `会话状态已更新为 ${nextStatus}`,
      metadata: createMetadata('system_notice', { status: nextStatus, requestedStatus: status, reason })
    });
    const confirmationEvent = confirmationId
      ? this.events.create({
          sessionId,
          type: 'user_confirmation_resolved',
      content: `用户选择了${status === 'CANCELLED' ? '取消' : '继续'}`,
          metadata: createMetadata('system_notice', {
            confirmationId,
            status: status === 'CANCELLED' ? 'rejected' : 'approved',
            selectedOptionKey: status === 'CANCELLED' ? 'cancel' : 'resume'
          })
        })
      : undefined;
    return { session, event, confirmationEvent };
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
      content: `会话在 ${phase} 阶段失败：${message}`,
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
      throw new Error('当前会话没有可用的 Agent。');
    }
    return fallback;
  }

  private persist() {
    this.persistence.setCollection('sessions', [...this.sessions.values()]);
  }
}
