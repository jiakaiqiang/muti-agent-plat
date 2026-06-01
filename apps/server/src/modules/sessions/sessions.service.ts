import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  Agent,
  EventPriority,
  SessionDetail,
  SessionStatus,
  UserMessageHandlingPlan,
  UserMessageIntent
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { AgentsService } from '../agents/agents.service.js';
import { EventsService } from '../events/events.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { OrchestratorService } from '../orchestrator/orchestrator.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { RuntimeService } from '../runtimes/runtime.service.js';
import { UserMessageRouterService } from '../user-message-router/user-message-router.service.js';

type CreateSessionInput = {
  input: string;
  agentIds?: string[];
  projectId?: string;
  tokenBudget?: number;
  knowledgeBaseIds?: string[];
  workspaceDir?: string;
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
    private readonly runtime: RuntimeService,
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
      tokenUsed: this.tokenUsedFor(session.id),
      agentCount: session.participatingAgentIds.length,
      requiresUserAction: ['WAIT_USER_CONFIRM', 'WAIT_USER_DECISION'].includes(session.status),
      latestEventSummary: this.events.list(session.id).at(-1)?.content,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    }));
  }

  /** Aggregates every runtime invocation's token usage for a session (the live token-used total). */
  private tokenUsedFor(sessionId: string) {
    return this.runtime
      .listInvocations(sessionId)
      .reduce((total, invocation) => total + (invocation.usage?.totalTokens ?? 0), 0);
  }

  get(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }
    return session;
  }

  /** Deletes a session and cascades to its events, tasks, and briefs. */
  remove(sessionId: string) {
    this.get(sessionId);
    this.sessions.delete(sessionId);
    this.persist();
    this.events.removeSession(sessionId);
    this.orchestrator.removeSessionData(sessionId);
    return { id: sessionId, removed: true };
  }

  // Runs the planning phase off the request path. discussAndCreateBrief already emits the agent
  // status, discussion, brief_created, and confirmation events; we add the final status event here
  // (setStatus alone doesn't emit one) so the client's SSE stream sees WAIT_USER_CONFIRM live.
  // `goal` is set for a follow-up round (a new requirement after the session already finished);
  // omitted for the first round, where discussAndCreateBrief falls back to the session's original input.
  private async generateBriefInBackground(session: SessionDetail, goal?: string) {
    try {
      const brief = await this.orchestrator.discussAndCreateBrief(session, goal);
      session.currentTaskBriefId = brief.id;
      this.setStatus(session, 'WAIT_USER_CONFIRM');
      this.events.create({
        sessionId: session.id,
        type: 'session_status_changed',
        content: '任务简报已生成，等待用户确认。',
        metadata: createMetadata('system_notice', { status: 'WAIT_USER_CONFIRM' })
      });
    } catch (error) {
      this.failSession(session, error, 'brief_generation');
    }
  }

  /** Terminal states from which a new user requirement re-opens the conversation into a fresh round. */
  private isFinished(status: SessionStatus) {
    return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status);
  }

  // A new requirement arriving in a finished conversation re-opens it as a new round: same flow as
  // create() — back to AGENT_DISCUSSING, plan the brief in the background (streamed over SSE), then
  // WAIT_USER_CONFIRM. Nothing executes until the user confirms the new (version+1) brief.
  private startNewRound(session: SessionDetail, goal: string) {
    this.setStatus(session, 'AGENT_DISCUSSING');
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      content: '收到新的需求，团队将在当前对话开启新一轮讨论。',
      metadata: createMetadata('system_notice', { status: 'AGENT_DISCUSSING', reason: 'new_round' })
    });
    void this.generateBriefInBackground(session, goal);
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
      workspaceDir: input.workspaceDir?.trim() || undefined,
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

    // Plan the brief in the background so the HTTP response returns immediately; the planning phase
    // then streams to the client over SSE in real time (see generateBriefInBackground).
    void this.generateBriefInBackground(session);

    return { session, firstEvent };
  }

  async sendMessage(sessionId: string, content: string, mentionedAgentIds: string[] = []) {
    const session = this.get(sessionId);
    const coordinator = this.pickSessionAgent(session, ['coordinator']);

    // 纯控制指令（暂停/继续/取消）由前端直接调用 control API。这里只记录消息并给出说明，
    // 不消耗一次 LLM 分诊，也不触发执行。
    if (this.router.isQuickCommand(content)) {
      const fallback = this.router.route(content, session.status);
      const event = this.recordUserMessage(sessionId, content, fallback.intent, fallback.priority, mentionedAgentIds);
      this.events.create({
        sessionId,
        type: 'agent_message',
        fromAgentId: coordinator.id,
        toAgentIds: mentionedAgentIds,
        content: '已收到控制指令，请通过暂停 / 继续 / 取消操作执行。',
        metadata: createMetadata('chat_message', { messageKind: 'decision', handlingPlan: fallback })
      });
      return { event, handlingPlan: fallback };
    }

    // Coordinator 先对消息分诊（LLM 决策），失败时回退到正则计划。决策完成后再落 user_message，
    // 这样事件上的意图就是 Coordinator 实际判定的意图。
    const fallback = this.router.route(content, session.status);
    const handlingPlan = await this.orchestrator.triageUserMessage(session, content, fallback);

    const event = this.recordUserMessage(
      sessionId,
      content,
      handlingPlan.intent,
      handlingPlan.priority,
      mentionedAgentIds
    );
    // 协调者的路由决策属于内部处理说明（routing jargon），不作为聊天气泡推送给用户，只驱动
    // Agent 卡片并保留审计（handlingPlan）。真正面向用户的回复由下方各 route 负责，避免每条
    // 用户消息都先冒出一句“将用户消息交由 Coordinator 处理”。
    this.events.create({
      sessionId,
      type: 'agent_status_changed',
      fromAgentId: coordinator.id,
      content: handlingPlan.coordinatorInstruction,
      metadata: createMetadata(undefined, {
        agentId: coordinator.id,
        status: 'thinking',
        thoughtSummary: handlingPlan.coordinatorInstruction,
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

    // 按 Coordinator 的路由决策处理。所有面向用户的发言都由 Coordinator 单点收口，
    // 不再让每个 Agent 各自追问用户。
    switch (handlingPlan.route) {
      case 'answer':
        await this.orchestrator.answerUser(session, content, handlingPlan);
        break;
      case 'ask_user':
        this.orchestrator.askUser(session, handlingPlan);
        break;
      case 'apply_to_agents':
        await this.orchestrator.applyConstraintToAgents(session, content, handlingPlan);
        if (handlingPlan.shouldPause) {
          this.pauseForUserDecision(session, handlingPlan);
        }
        break;
      case 'revise_brief': {
        const brief = await this.orchestrator.reviseBriefFromMessage(session, content);
        session.currentTaskBriefId = brief.id;
        this.setStatus(session, 'WAIT_USER_CONFIRM');
        break;
      }
      case 'new_task':
        // 会话已结束 → 把新需求当作新一轮，走完整的 理解→讨论→简报→确认→执行 流程；
        // 会话执行中 → 维持原先的单任务即时执行，避免打断正在进行的轮次。
        if (this.isFinished(session.status)) {
          this.startNewRound(session, content);
        } else {
          await this.orchestrator.handleNewTaskRequest(session, content);
        }
        break;
      case 'command':
        // 控制指令由前端直接调用 control API，这里不处理。
        break;
    }

    return { event, handlingPlan };
  }

  private recordUserMessage(
    sessionId: string,
    content: string,
    intent: UserMessageIntent,
    priority: EventPriority,
    mentionedAgentIds: string[]
  ) {
    return this.events.create({
      sessionId,
      type: 'user_message',
      userMessageIntent: intent,
      priority,
      content,
      toAgentIds: mentionedAgentIds,
      metadata: createMetadata('chat_message', { text: content, mentionedAgentIds })
    });
  }

  // Executing-time interrupt: a new constraint/correction may conflict with the confirmed contract,
  // so we pause to WAIT_USER_DECISION and ask the user whether to resume or cancel.
  private pauseForUserDecision(session: SessionDetail, handlingPlan: UserMessageHandlingPlan) {
    this.setStatus(session, 'WAIT_USER_DECISION');
    const confirmationId = crypto.randomUUID();
    this.events.create({
      sessionId: session.id,
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
      sessionId: session.id,
      type: 'user_confirmation_requested',
      priority: 'high',
      content: '请确认如何处理执行中的新增约束。',
      metadata: createMetadata('confirmation_card', {
        confirmationId,
        reason: 'resolve_contract_conflict',
        title: '处理执行中插话',
        description: '新增约束可能影响已确认的任务契约。请选择继续执行或取消当前任务。',
        options: [
          { key: 'resume', label: '继续执行', style: 'primary' },
          { key: 'cancel', label: '取消任务', style: 'danger' }
        ],
        handlingPlan
      })
    });
  }

  async confirmBrief(sessionId: string, briefId: string) {
    const session = this.get(sessionId);
    this.setStatus(session, 'EXECUTING');
    try {
      const result = await this.orchestrator.confirmBrief(session, briefId);
      this.settleAfterExecution(session, result.suspended);
      return result;
    } catch (error) {
      this.failSession(session, error, 'confirmed_execution');
      throw error;
    }
  }

  // 用户在「确认写入文件」卡上做出决策:写入或跳过这批文件,然后续跑剩余任务。
  async applyWriteConfirmation(sessionId: string, confirmationId: string, approved: boolean) {
    const session = this.get(sessionId);
    const pending = this.orchestrator.getPendingWrite(sessionId);
    if (!pending || pending.confirmationId !== confirmationId) {
      throw new BadRequestException(`No pending file-write confirmation matches: ${confirmationId}`);
    }
    if (session.status === 'WAIT_USER_DECISION') {
      this.setStatus(session, 'EXECUTING');
    }
    try {
      const result = await this.orchestrator.applyPendingWrites(session, confirmationId, approved);
      this.settleAfterExecution(session, result.suspended);
      return { sessionId, confirmationId, approved };
    } catch (error) {
      this.failSession(session, error, 'apply_file_writes');
      throw error;
    }
  }

  // 一轮执行返回后统一收尾:仍需用户确认写入时停在 WAIT_USER_DECISION,否则若仍在执行则标记完成。
  private settleAfterExecution(session: SessionDetail, suspended: boolean) {
    if (suspended) {
      if (session.status === 'EXECUTING') {
        this.setStatus(session, 'WAIT_USER_DECISION');
      }
      return;
    }
    if (session.status === 'EXECUTING') {
      this.setStatus(session, 'COMPLETED');
    }
  }

  listBriefs(sessionId: string) {
    return this.orchestrator.listBriefs(sessionId);
  }

  // 用户在交付后的飞书确认卡上选择“发送通知”：把草稿经真实 webhook 发送，并关闭对应确认卡。
  async sendFeishuNotification(sessionId: string, artifactId: string, confirmationId?: string) {
    const session = this.get(sessionId);
    const result = await this.orchestrator.sendFeishuNotification(session, artifactId);
    if (confirmationId) {
      this.events.create({
        sessionId,
        type: 'user_confirmation_resolved',
        content: result.status === 'sent' ? '用户已确认发送飞书通知' : '飞书通知发送未成功',
        metadata: createMetadata('system_notice', {
          confirmationId,
          status: result.status === 'sent' ? 'approved' : 'rejected',
          selectedOptionKey: 'approve'
        })
      });
    }
    return result;
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
