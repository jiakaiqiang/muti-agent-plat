import { Injectable } from '@nestjs/common';
import type {
  Agent,
  AgentMessageOutput,
  AgentRunInput,
  AgentRunResult,
  AgentStatus,
  AgentTask,
  ContextPack,
  FinalDeliveryOutput,
  PostReviewReportOutput,
  RuntimeArtifactOutput,
  SessionDetail,
  SuggestedAgentTask,
  TaskBrief,
  TaskBriefOutput,
  TaskExecutionResultOutput,
  UserMessageHandlingPlan,
  UserMessageIntent,
  UserMessageRoute
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { runtimeModeLabel } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { AgentsService } from '../agents/agents.service.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { CapabilitiesService } from '../capabilities/capabilities.service.js';
import { EventsService } from '../events/events.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { KnowledgeService } from '../rag/knowledge.service.js';
import { RuntimeService } from '../runtimes/runtime.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { agentSystemPrompt } from './agent-personas.js';

@Injectable()
export class OrchestratorService {
  private readonly briefsBySession = new Map<string, TaskBrief[]>();
  private readonly suggestedTasksByBriefId = new Map<string, SuggestedAgentTask[]>();

  constructor(
    private readonly agents: AgentsService,
    private readonly events: EventsService,
    private readonly runtime: RuntimeService,
    private readonly tasks: TasksService,
    private readonly knowledge: KnowledgeService,
    private readonly memories: MemoryService,
    private readonly artifacts: ArtifactsService,
    private readonly capabilities: CapabilitiesService,
    private readonly persistence: PersistenceService
  ) {
    const persistedBriefs = this.persistence.getCollection<Record<string, TaskBrief[]>>('briefsBySession', {});
    for (const [sessionId, briefs] of Object.entries(persistedBriefs)) {
      this.briefsBySession.set(sessionId, briefs);
    }

    const persistedSuggestedTasks = this.persistence.getCollection<Record<string, SuggestedAgentTask[]>>(
      'suggestedTasksByBriefId',
      {}
    );
    for (const [briefId, suggestedTasks] of Object.entries(persistedSuggestedTasks)) {
      this.suggestedTasksByBriefId.set(briefId, suggestedTasks);
    }
  }

  async discussAndCreateBrief(session: SessionDetail, goal?: string) {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    // 新一轮（会话结束后又来新需求）时 goal 为这条新需求；首轮省略 goal，沿用会话原始目标。
    // 上一轮的交付物/事件已通过 createContextPack 注入，保证新一轮带着历史上下文讨论。
    const roundGoal = goal?.trim() || session.originalInput;

    // 第一步：协调者理解需求。给用户一条简短进度提示；真正的团队讨论在内部进行，不往聊天区刷屏。
    const discussants = this.discussionAgents(session);
    this.emitAgentStatus(session.id, coordinator, 'thinking', {
      content: `${coordinator.name} 正在理解需求并组织团队讨论…`,
      thoughtSummary: '梳理用户目标，提出需要团队重点讨论的问题。'
    });
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      content: '收到需求，我先和团队讨论实现方案，稍后给你一份任务简报确认。',
      metadata: createMetadata('chat_message', { messageKind: 'progress' })
    });
    const kickoff = await this.runDiscussionTurn(
      session,
      coordinator,
      [
        `用户目标：${roundGoal}`,
        '请用 2-4 句中文概述你对该目标的理解，并指出希望团队（需求/架构/前后端/测试）重点讨论的问题。'
      ].join('\n')
    );
    // 协调者的理解写入 Agent 状态（agent_status_changed 不进聊天区，只驱动 Agent 卡片）。
    this.emitAgentStatus(session.id, coordinator, 'idle', {
      content: `${coordinator.name} 已梳理需求并向团队发起讨论。`,
      thoughtSummary: kickoff
    });

    // 第二步：团队成员逐一从各自专业角度参与「内部」讨论。意见写入 Agent 状态（卡片可见），
    // 不再逐条作为聊天消息推送给用户——避免多个 Agent 重复刷屏、各自反问用户。
    const contributions: { agent: Agent; content: string }[] = [];
    for (const agent of discussants) {
      this.emitAgentStatus(session.id, agent, 'thinking', {
        content: `${agent.name} 正在从「${agent.role}」角度参与讨论…`,
        thoughtSummary: `针对「${session.title}」给出专业意见与风险。`
      });
      const opinion = await this.runDiscussionTurn(
        session,
        agent,
        [
          `用户目标：${roundGoal}`,
          `协调者的理解：${kickoff}`,
          '这是团队内部讨论，发言对象是协调者与同事，不是用户：禁止向用户提问或要求用户补充信息。',
          '请从你的专业职责出发，用 2-4 句中文给出关键意见、约束或风险；信息不足时基于合理假设给出建议并说明假设。'
        ].join('\n')
      );
      contributions.push({ agent, content: opinion });
      this.emitAgentStatus(session.id, agent, 'idle', {
        content: `${agent.name} 已给出意见。`,
        actionSummary: opinion
      });
    }

    // 第三步：协调者汇总团队讨论，生成任务简报（讨论内容通过 focusMessage 注入，确保被综合）。
    this.emitAgentStatus(session.id, coordinator, 'running', {
      content: `${coordinator.name} 正在汇总团队讨论并生成任务简报…`,
      thoughtSummary: '综合各方意见，拟定范围、验收标准与建议任务。'
    });
    const discussionDigest = [
      `协调者理解：${kickoff}`,
      ...contributions.map((entry) => `${entry.agent.name}（${entry.agent.role}）：${entry.content}`)
    ].join('\n');
    const briefFocus = [
      `用户目标：${roundGoal}`,
      '请综合以下团队讨论结果，生成可供用户确认的任务简报：',
      discussionDigest
    ].join('\n');
    const result = await this.runtime.run({
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'brief_generation',
      agent: this.toRuntimeAgent(coordinator),
      contextPack: this.createContextPack(session, coordinator, undefined, undefined, briefFocus),
      expectedOutput: { kind: 'task_brief', schemaVersion: '0.1' },
      budget: {}
    });
    const output = this.completedOutput<TaskBriefOutput>(result, 'task_brief');
    const suggestedTasks = output.suggestedTasks.length ? output.suggestedTasks : this.defaultSuggestedTasks();

    const brief: TaskBrief = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      version: (this.briefsBySession.get(session.id)?.length ?? 0) + 1,
      goal: output.goal,
      scope: output.scope,
      outOfScope: output.outOfScope,
      constraints: output.constraints,
      acceptanceCriteria: output.acceptanceCriteria,
      risks: output.risks,
      openQuestions: output.openQuestions,
      confirmedByUser: false,
      createdAt: nowIso()
    };

    this.briefsBySession.set(session.id, [...(this.briefsBySession.get(session.id) ?? []), brief]);
    this.suggestedTasksByBriefId.set(brief.id, suggestedTasks);
    this.persistBriefs();

    // 协调者把讨论结果收口为一条面向用户的说明，再附上简报卡片请用户确认。
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      content: `团队已完成讨论，我据此整理出任务简报（目标：${brief.goal}）。请确认后再下发执行。`,
      metadata: createMetadata('chat_message', { messageKind: 'summary' })
    });

    this.events.create({
      sessionId: session.id,
      type: 'brief_created',
      fromAgentId: coordinator.id,
      content: '团队已生成任务简报，确认后即可开始执行。',
      metadata: createMetadata(
        'brief_card',
        {
          briefId: brief.id,
          version: brief.version,
          goal: brief.goal,
          scope: brief.scope,
          outOfScope: brief.outOfScope,
          constraints: brief.constraints,
          acceptanceCriteria: brief.acceptanceCriteria,
          risks: brief.risks,
          openQuestions: brief.openQuestions,
          suggestedTasks,
          requiresUserConfirmation: true
        },
        'Task brief'
      )
    });

    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_requested',
      fromAgentId: coordinator.id,
      content: '请确认是否执行该任务简报。',
      metadata: createMetadata('confirmation_card', {
        confirmationId: crypto.randomUUID(),
        reason: 'confirm_task_brief',
        title: '确认执行任务简报',
        description:
          '确认后，配置的 Agent 运行时将执行建议任务，并生成复盘与交付产物。',
        relatedBriefId: brief.id,
        options: [
          { key: 'approve', label: '确认执行', style: 'primary' },
          { key: 'revise', label: '修改简报', style: 'default' }
        ]
      })
    });

    this.emitAgentStatus(session.id, coordinator, 'idle', {
      content: `${coordinator.name} 已生成任务简报，等待用户确认。`
    });

    return brief;
  }

  listBriefs(sessionId: string) {
    return this.briefsBySession.get(sessionId) ?? [];
  }

  /** Clears briefs, suggested tasks, and tasks for a deleted session. */
  removeSessionData(sessionId: string) {
    for (const brief of this.briefsBySession.get(sessionId) ?? []) {
      this.suggestedTasksByBriefId.delete(brief.id);
    }
    this.briefsBySession.delete(sessionId);
    this.persistBriefs();
    this.tasks.removeSession(sessionId);
  }

  getBrief(sessionId: string, briefId: string) {
    return this.listBriefs(sessionId).find((brief) => brief.id === briefId);
  }

  async confirmBrief(session: SessionDetail, briefId: string) {
    const brief = this.getBrief(session.id, briefId);
    if (!brief) {
      throw new Error(`Brief not found: ${briefId}`);
    }

    brief.confirmedByUser = true;
    brief.confirmedAt = nowIso();
    this.persistBriefs();

    const agentIdByKey = new Map(this.agents.list().map((agent) => [agent.key, agent.id]));
    const suggestions = this.suggestedTasksByBriefId.get(brief.id) ?? this.defaultSuggestedTasks();
    const tasks = this.tasks.createFromSuggestions(session.id, suggestions, agentIdByKey);

    const event = this.events.create({
      sessionId: session.id,
      type: 'brief_confirmed',
      content: '用户已确认任务简报，开始执行配置的 Agent 运行时。',
      metadata: createMetadata('system_notice', { briefId: brief.id })
    });

    for (const task of tasks) {
      this.events.create({
        sessionId: session.id,
        type: 'task_created',
        taskId: task.id,
        content: `已创建任务：${task.title}`,
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          status: task.status,
          assigneeAgentId: task.assigneeAgentId,
          acceptanceCriteria: task.acceptanceCriteria
        })
      });
    }

    await this.executeRuntimeTasks(session, brief, tasks);
    return { brief, event, createdTasks: tasks };
  }

  private async executeRuntimeTasks(session: SessionDetail, brief: TaskBrief, tasks: AgentTask[]) {
    const backend = this.pickSessionAgent(session, ['backend'], 0);
    const review = this.pickSessionAgent(session, ['review', 'test'], 1);

    for (const task of tasks) {
      const taskAgent = task.assigneeAgentId ? this.agents.getByIdOrKey(task.assigneeAgentId) : backend;
      this.tasks.update(task, { status: 'running' });
      this.emitAgentStatus(session.id, taskAgent, 'running', {
        content: `${taskAgent.name} 正在执行任务：${task.title}`,
        currentTaskId: task.id,
        currentTaskTitle: task.title,
        thoughtSummary: `执行任务「${task.title}」`
      });
      this.events.create({
        sessionId: session.id,
        type: 'task_started',
        taskId: task.id,
        fromAgentId: taskAgent.id,
        content: `开始执行任务：${task.title}`,
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          status: 'running',
          assigneeAgentId: task.assigneeAgentId
        })
      });

      const runId = crypto.randomUUID();
      this.events.create({
        sessionId: session.id,
        type: 'runtime_started',
        taskId: task.id,
        fromAgentId: taskAgent.id,
        content: `${taskAgent.name} ${runtimeModeLabel(taskAgent.runtimeType)} started task execution.`,
        metadata: createMetadata('system_notice', {
          runtimeInvocationId: runId,
          runtimeType: taskAgent.runtimeType,
          status: 'running'
        })
      });

      const contextPack = this.createContextPack(session, taskAgent, brief, task);
      this.emitMemoryUsedEvent(session.id, task.id, taskAgent.id, contextPack);

      const result = await this.runtime.run({
        runId,
        sessionId: session.id,
        taskId: task.id,
        phase: 'task_execution',
        agent: this.toRuntimeAgent(taskAgent),
        contextPack,
        expectedOutput: { kind: 'task_execution_result', schemaVersion: '0.1' },
        budget: {}
      });

      if (result.status !== 'completed') {
        this.markTaskFailed(session.id, task, taskAgent.id, runId, result.error?.message ?? result.status, taskAgent.runtimeType);
        throw this.runtimeError(result, 'task_execution');
      }

      const output = this.completedOutput<TaskExecutionResultOutput>(result, 'task_execution_result');
      this.events.create({
        sessionId: session.id,
        type: 'rag_retrieved',
        taskId: task.id,
        fromAgentId: taskAgent.id,
        content: '已为该任务检索 Agent 知识片段。',
        metadata: createMetadata('rag_card', {
          retrievalLogId: crypto.randomUUID(),
          agentId: taskAgent.id,
          query: task.title,
          matchedChunks: this.searchAgentKnowledge(session, taskAgent, task.title)
        })
      });

      if (output.status !== 'completed') {
        this.markTaskFailed(session.id, task, taskAgent.id, runId, output.summary, taskAgent.runtimeType);
        throw new Error(`Task ${task.title} ended with ${output.status}: ${output.summary}`);
      }

      this.tasks.update(task, { status: 'completed', resultSummary: output.summary });
      const executionArtifact = this.createExecutionArtifact(session.id, task, taskAgent.id, output, result.artifacts);
      this.events.create({
        sessionId: session.id,
        type: 'artifact_created',
        taskId: task.id,
        fromAgentId: taskAgent.id,
        content: `已创建产物：${executionArtifact.title}`,
        metadata: createMetadata('artifact_card', {
          artifactId: executionArtifact.id,
          type: executionArtifact.type,
          title: executionArtifact.title,
          contentSummary: executionArtifact.contentSummary
        })
      });
      this.events.create({
        sessionId: session.id,
        type: 'runtime_completed',
        taskId: task.id,
        fromAgentId: taskAgent.id,
        content: `${taskAgent.name} ${runtimeModeLabel(taskAgent.runtimeType)} completed task execution.`,
        metadata: createMetadata('system_notice', {
          runtimeInvocationId: runId,
          runtimeType: taskAgent.runtimeType,
          status: 'completed',
          usage: result.usage
        })
      });
      this.events.create({
        sessionId: session.id,
        type: 'task_completed',
        taskId: task.id,
        fromAgentId: taskAgent.id,
        content: `已完成任务：${task.title}`,
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          status: 'completed',
          resultSummary: output.summary,
          completedItems: output.completedItems,
          risks: output.risks
        })
      });
      this.emitAgentStatus(session.id, taskAgent, 'idle', {
        content: `${taskAgent.name} 已完成任务：${task.title}`,
        actionSummary: output.summary
      });
    }

    this.events.create({
      sessionId: session.id,
      type: 'post_review_started',
      fromAgentId: review.id,
      content: '评审 Agent 开始对照已确认的任务简报检查执行结果。',
      metadata: createMetadata('review_card', { briefId: brief.id })
    });

    this.emitAgentStatus(session.id, review, 'reviewing', {
      content: `${review.name} 正在复盘执行结果是否符合任务简报。`,
      thoughtSummary: '核对执行产物与验收标准、范围一致性。'
    });

    const reviewRun = await this.runtime.run({
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'post_review',
      agent: this.toRuntimeAgent(review),
      contextPack: this.createContextPack(session, review, brief),
      expectedOutput: { kind: 'post_review_report', schemaVersion: '0.1' },
      budget: {}
    });
    const reviewOutput = this.completedOutput<PostReviewReportOutput>(reviewRun, 'post_review_report');
    const reviewArtifact = this.artifacts.create({
      sessionId: session.id,
      agentId: review.id,
      type: 'test_report',
      title: '复盘报告',
      contentSummary: reviewOutput.recommendation,
      metadata: reviewOutput as unknown as Record<string, unknown>
    });
    this.events.create({
      sessionId: session.id,
      type: 'post_review_completed',
      fromAgentId: review.id,
      content: '评审 Agent 已完成一致性复盘。',
      metadata: createMetadata('review_card', {
        ...reviewOutput,
        artifactIds: [reviewArtifact.id]
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'artifact_created',
      fromAgentId: review.id,
      content: `已创建产物：${reviewArtifact.title}`,
      metadata: createMetadata('artifact_card', {
        artifactId: reviewArtifact.id,
        type: reviewArtifact.type,
        title: reviewArtifact.title,
        contentSummary: reviewArtifact.contentSummary
      })
    });

    this.emitAgentStatus(session.id, review, 'idle', {
      content: `${review.name} 复盘完成。`
    });

    const coordinator = this.pickSessionAgent(session, ['coordinator'], 0);
    this.emitAgentStatus(session.id, coordinator, 'running', {
      content: `${coordinator.name} 正在汇总最终交付物。`,
      thoughtSummary: '整理交付摘要、完成项与风险。'
    });
    const finalRun = await this.runtime.run({
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'final_delivery',
      agent: this.toRuntimeAgent(coordinator),
      contextPack: this.createContextPack(session, review, brief),
      expectedOutput: { kind: 'final_delivery', schemaVersion: '0.1' },
      budget: {}
    });
    const finalOutput = this.completedOutput<FinalDeliveryOutput>(finalRun, 'final_delivery');
    const notification = this.pickSessionAgent(session, ['notification'], 0);
    const deliveryArtifact = this.artifacts.create({
      sessionId: session.id,
      agentId: coordinator.id,
      type: 'markdown',
      title: '最终交付摘要',
      contentSummary: finalOutput.summary,
      metadata: finalOutput as unknown as Record<string, unknown>
    });
    const notificationDraft = this.artifacts.create({
      sessionId: session.id,
      agentId: notification.id,
      type: 'feishu_draft',
      title: '飞书通知草稿',
      contentSummary: '通知草稿已生成，等待用户显式确认后发送。',
      metadata: {
        channel: 'feishu',
        mode: 'draft',
        dryRun: true,
        status: 'pending_user_confirmation',
        title: 'Agent Cluster 交付完成',
        body: {
          sessionId: session.id,
          goal: brief.goal,
          summary: finalOutput.summary,
          completedItems: finalOutput.completedItems,
          risks: finalOutput.risks
        },
        sourceArtifactId: deliveryArtifact.id
      }
    });
    const artifactRefs = [...this.artifacts.listBySession(session.id).map((artifact) => artifact.id)];
    this.events.create({
      sessionId: session.id,
      type: 'final_delivery_created',
      fromAgentId: coordinator.id,
      content: '最终交付物已生成。',
      metadata: createMetadata('delivery_card', {
        ...finalOutput,
        artifactRefs,
        notificationDraftArtifactId: notificationDraft.id
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'artifact_created',
      fromAgentId: coordinator.id,
      content: `已创建产物：${deliveryArtifact.title}`,
      metadata: createMetadata('artifact_card', {
        artifactId: deliveryArtifact.id,
        type: deliveryArtifact.type,
        title: deliveryArtifact.title,
        contentSummary: deliveryArtifact.contentSummary
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'artifact_created',
      fromAgentId: notification.id,
      content: `已创建产物：${notificationDraft.title}`,
      metadata: createMetadata('artifact_card', {
        artifactId: notificationDraft.id,
        type: notificationDraft.type,
        title: notificationDraft.title,
        contentSummary: notificationDraft.contentSummary,
        relatedCapabilityId: 'cap-feishu-draft'
      })
    });
    this.emitAgentStatus(session.id, coordinator, 'completed', {
      content: `${coordinator.name} 已完成最终交付。`
    });
  }

  async handleQuestion(session: SessionDetail, question: string) {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    this.emitAgentStatus(session.id, coordinator, 'thinking', {
      content: `${coordinator.name} 正在思考如何回答用户的问题…`,
      thoughtSummary: '理解问题背景，结合会话上下文给出回答。'
    });

    const contextPack = this.createContextPack(session, coordinator, undefined, undefined, question);
    const result = await this.runtime.run({
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'user_message_routing',
      agent: this.toRuntimeAgent(coordinator),
      contextPack,
      expectedOutput: {
        kind: 'agent_message',
        schemaVersion: '0.1',
        jsonSchema: {
          type: 'object',
          properties: {
            answer: { type: 'string', description: '对用户问题的回答' },
            references: {
              type: 'array',
              items: { type: 'string' },
              description: '引用的任务 ID 或产物 ID（可选）'
            }
          },
          required: ['answer']
        }
      },
      budget: {}
    });

    if (result.status !== 'completed' || !result.output) {
      throw this.runtimeError(result, 'question handling');
    }

    const output = result.output as unknown as { answer: string; references?: string[] };
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      content: output.answer,
      metadata: createMetadata('chat_message', {
        messageKind: 'answer',
        references: output.references
      })
    });

    this.emitAgentStatus(session.id, coordinator, 'idle', {
      content: `${coordinator.name} 已回答用户问题。`
    });
  }

  /**
   * Coordinator 对一条用户消息进行分诊，产出结构化的处理决策（route 等）。这是「单点收口」的核心：
   * 不再用正则把消息直接 fan-out 给所有 Agent，而是先由 Coordinator 决定怎么处理。LLM 调用失败时
   * 回退到传入的 fallback（正则计划），保证健壮。
   */
  async triageUserMessage(
    session: SessionDetail,
    message: string,
    fallback: UserMessageHandlingPlan
  ): Promise<UserMessageHandlingPlan> {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    this.emitAgentStatus(session.id, coordinator, 'thinking', {
      content: `${coordinator.name} 正在理解你的消息并决定如何处理…`,
      thoughtSummary: '判断意图、是否需要回到用户，以及交给哪些 Agent。'
    });

    const roster = this.participatingAgents(session)
      .filter((agent) => agent.key !== 'coordinator')
      .map((agent) => `${agent.key}（${agent.name}）`)
      .join('、');
    const hasUnconfirmedBrief = ['AGENT_DISCUSSING', 'WAIT_USER_CONFIRM', 'REVISING_BRIEF'].includes(session.status);
    const isFinished = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(session.status);

    const contextPack = this.createContextPack(session, coordinator, undefined, undefined, message);
    contextPack.systemRules = [
      ...contextPack.systemRules,
      `当前会话状态：${session.status}。`,
      roster ? `可参与/可分配的 Agent：${roster}。` : '当前没有其它可分配的 Agent。',
      '按以下规则判断 route：',
      '· 用户在提问、想了解信息（如“多久/能不能/是不是/为什么/怎么做”）→ answer：把答案直接写进 replyToUser，不要反问用户。',
      '· 用户在给出限制、约束或纠正（如“不要/必须/保持/改成/不对”）→ apply_to_agents：把要同步给执行 Agent 的确认写进 replyToUser。',
      hasUnconfirmedBrief
        ? '· 用户在补充或修改尚未确认的任务简报 → revise_brief。'
        : '· 用户提出一个全新的待办需求 → new_task。',
      isFinished
        ? '· 本对话上一轮任务已结束；只要用户提出新的需求、或要在已交付内容上继续做/修改 → new_task（系统会据此在同一对话开启新一轮：理解→讨论→简报→确认→执行）；只有当用户单纯就已交付内容提问时才用 answer。'
        : null,
      '· 仅当确实需要用户提供某个无法自行合理假设、缺了就无法继续的关键信息时，才用 ask_user；能假设就假设，不要反问。',
      `基于关键词的初步判断是 intent=${fallback.intent}、route=${fallback.route}；若无充分理由推翻，请沿用该 route。`,
      '不要因为任务简报里列了 openQuestions 就向用户反问，那些问题应由你自行假设。',
      'replyToUser 必须直接回应用户“当前这条消息”，不要引入与当前消息无关的问题。'
    ].filter((rule): rule is string => rule !== null);

    const result = await this.runtime.run({
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'user_message_routing',
      agent: this.toRuntimeAgent(coordinator),
      contextPack,
      expectedOutput: {
        kind: 'user_message_handling_plan',
        schemaVersion: '0.1',
        jsonSchema: {
          type: 'object',
          properties: {
            intent: {
              type: 'string',
              enum: ['clarification', 'constraint', 'command', 'question', 'correction', 'knowledge_input', 'preference_input'],
              description: '用户消息的意图'
            },
            route: {
              type: 'string',
              enum: ['answer', 'ask_user', 'apply_to_agents', 'revise_brief', 'new_task', 'command'],
              description: '如何处理这条消息'
            },
            needsUserInput: { type: 'boolean', description: '是否必须回到用户继续追问' },
            replyToUser: { type: 'string', description: '直接面向用户的中文话术（answer/ask_user/apply_to_agents 时必填）' },
            targetAgentKeys: {
              type: 'array',
              items: { type: 'string' },
              description: 'apply_to_agents 时相关 Agent 的 key 列表'
            },
            coordinatorInstruction: { type: 'string', description: '给团队的一句话处理说明' }
          },
          required: ['route', 'replyToUser']
        }
      },
      budget: {}
    });

    const plan = this.toHandlingPlan(result, fallback, session);
    this.emitAgentStatus(session.id, coordinator, 'idle', {
      content: `${coordinator.name} 已决定如何处理这条消息。`,
      thoughtSummary: `处理方式：${plan.route}。`
    });
    return plan;
  }

  /** route=answer：Coordinator 直接回答用户；triage 已给出回答就直接用，否则再问一次运行时。 */
  async answerUser(session: SessionDetail, message: string, plan: UserMessageHandlingPlan) {
    const reply = plan.replyToUser?.trim();
    if (!reply) {
      await this.handleQuestion(session, message);
      return;
    }
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      content: reply,
      metadata: createMetadata('chat_message', { messageKind: 'answer' })
    });
  }

  /** route=ask_user：仅由 Coordinator 发出唯一一条追问，绝不让多个角色各自追问用户。 */
  askUser(session: SessionDetail, plan: UserMessageHandlingPlan) {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    const question = plan.replyToUser?.trim() || '需要你补充一些信息才能继续，可以提供更多细节吗？';
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      content: question,
      metadata: createMetadata('chat_message', { messageKind: 'question', needsUserInput: true })
    });
  }

  /**
   * route=apply_to_agents：把用户的约束/澄清同步给相关 Agent，并由 Coordinator 收口为一条面向用户的
   * 回执。相关 Agent 只在内部消化（通过状态事件体现），不会各自向用户发言——这正是避免「一群 Agent
   * 追着用户问」的关键。
   */
  async applyConstraintToAgents(session: SessionDetail, message: string, plan: UserMessageHandlingPlan) {
    const targets = this.resolveTargetAgents(session, plan.targetAgentKeys);
    const noun = plan.intent === 'constraint' ? '约束' : '说明';
    for (const agent of targets) {
      this.emitAgentStatus(session.id, agent, 'thinking', {
        content: `${agent.name} 收到协调者同步的用户${noun}，正在纳入任务上下文。`,
        thoughtSummary: `将「${message}」纳入自己负责的工作。`
      });
      this.emitAgentStatus(session.id, agent, 'idle', {
        content: `${agent.name} 已记录该${noun}。`
      });
    }

    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    const names = targets.map((agent) => agent.name).join('、');
    const ack =
      plan.replyToUser?.trim() ||
      (plan.intent === 'constraint' ? `已将该约束同步给 ${names}，后续执行会遵循。` : `已将你的说明同步给 ${names}。`);
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      content: ack,
      metadata: createMetadata('chat_message', {
        messageKind: plan.intent === 'constraint' ? 'constraint_ack' : 'clarification_response',
        handledByAgentIds: targets.map((agent) => agent.id)
      })
    });
  }

  /** route=revise_brief：用户补充了尚未确认简报的信息，修订简报并重新请求确认。 */
  async reviseBriefFromMessage(session: SessionDetail, message: string): Promise<TaskBrief> {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    this.emitAgentStatus(session.id, coordinator, 'thinking', {
      content: `${coordinator.name} 正在根据你的补充修订任务简报…`,
      thoughtSummary: '结合补充信息更新范围、约束与验收标准。'
    });

    const previous = this.briefsBySession.get(session.id)?.at(-1);
    const contextPack = this.createContextPack(session, coordinator, previous, undefined, message);
    const result = await this.runtime.run({
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'brief_revision',
      agent: this.toRuntimeAgent(coordinator),
      contextPack,
      expectedOutput: { kind: 'task_brief', schemaVersion: '0.1' },
      budget: {}
    });
    const output = this.completedOutput<TaskBriefOutput>(result, 'task_brief');
    const suggestedTasks = output.suggestedTasks.length ? output.suggestedTasks : this.defaultSuggestedTasks();

    const brief: TaskBrief = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      version: (this.briefsBySession.get(session.id)?.length ?? 0) + 1,
      goal: output.goal,
      scope: output.scope,
      outOfScope: output.outOfScope,
      constraints: output.constraints,
      acceptanceCriteria: output.acceptanceCriteria,
      risks: output.risks,
      openQuestions: output.openQuestions,
      confirmedByUser: false,
      createdAt: nowIso()
    };
    this.briefsBySession.set(session.id, [...(this.briefsBySession.get(session.id) ?? []), brief]);
    this.suggestedTasksByBriefId.set(brief.id, suggestedTasks);
    this.persistBriefs();

    this.events.create({
      sessionId: session.id,
      type: 'brief_updated',
      fromAgentId: coordinator.id,
      content: '已根据你的补充更新任务简报，请再次确认。',
      metadata: createMetadata(
        'brief_card',
        {
          briefId: brief.id,
          version: brief.version,
          goal: brief.goal,
          scope: brief.scope,
          outOfScope: brief.outOfScope,
          constraints: brief.constraints,
          acceptanceCriteria: brief.acceptanceCriteria,
          risks: brief.risks,
          openQuestions: brief.openQuestions,
          suggestedTasks,
          requiresUserConfirmation: true
        },
        'Task brief'
      )
    });
    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_requested',
      fromAgentId: coordinator.id,
      content: '请确认是否按更新后的任务简报执行。',
      metadata: createMetadata('confirmation_card', {
        confirmationId: crypto.randomUUID(),
        reason: 'confirm_task_brief',
        title: '确认更新后的任务简报',
        description: '确认后将按更新后的简报执行建议任务，并生成复盘与交付物。',
        relatedBriefId: brief.id,
        options: [
          { key: 'approve', label: '确认执行', style: 'primary' },
          { key: 'revise', label: '继续修改', style: 'default' }
        ]
      })
    });
    this.emitAgentStatus(session.id, coordinator, 'idle', {
      content: `${coordinator.name} 已更新任务简报，等待用户确认。`
    });
    return brief;
  }

  /** Resolves which agents a constraint should sync to: triage-named keys, else executors, else all non-coordinator. */
  private resolveTargetAgents(session: SessionDetail, keys?: string[]): Agent[] {
    const agents = this.participatingAgents(session);
    if (keys?.length) {
      const matched = agents.filter((agent) => keys.includes(agent.key));
      if (matched.length) {
        return matched;
      }
    }
    const executors = agents.filter((agent) => ['backend', 'frontend', 'test', 'architect'].includes(agent.key));
    if (executors.length) {
      return executors;
    }
    const nonCoordinator = agents.filter((agent) => agent.key !== 'coordinator');
    return nonCoordinator.length ? nonCoordinator : agents;
  }

  /** Normalizes the runtime's triage output into a complete handling plan, deriving status-dependent fields. */
  private toHandlingPlan(
    result: AgentRunResult,
    fallback: UserMessageHandlingPlan,
    session: SessionDetail
  ): UserMessageHandlingPlan {
    if (result.status !== 'completed' || !result.output) {
      return fallback;
    }
    const raw = result.output as Record<string, unknown>;
    const route = this.asRoute(raw.route) ?? fallback.route;
    const intent = this.asIntent(raw.intent) ?? this.intentForRoute(route, fallback.intent);
    const isExecuting = ['EXECUTING', 'REWORKING', 'POST_REVIEW'].includes(session.status);
    const replyToUser =
      typeof raw.replyToUser === 'string' && raw.replyToUser.trim() ? raw.replyToUser.trim() : fallback.replyToUser;
    const targetAgentKeys = Array.isArray(raw.targetAgentKeys)
      ? raw.targetAgentKeys.filter((key): key is string => typeof key === 'string')
      : undefined;
    const coordinatorInstruction =
      typeof raw.coordinatorInstruction === 'string' && raw.coordinatorInstruction.trim()
        ? raw.coordinatorInstruction.trim()
        : fallback.coordinatorInstruction;
    return {
      intent,
      route,
      priority: intent === 'constraint' || intent === 'correction' ? 'high' : 'normal',
      shouldPause: isExecuting && route === 'apply_to_agents' && (intent === 'constraint' || intent === 'correction'),
      needsUserInput: route === 'ask_user' || raw.needsUserInput === true,
      replyToUser,
      targetAgentKeys: targetAgentKeys && targetAgentKeys.length ? targetAgentKeys : undefined,
      affectedTaskIds: [],
      affectedAgentIds: [],
      requiresBriefRevision: route === 'revise_brief',
      requiresUserConfirmation: route === 'ask_user',
      coordinatorInstruction
    };
  }

  private asRoute(value: unknown): UserMessageRoute | undefined {
    const routes: UserMessageRoute[] = ['answer', 'ask_user', 'apply_to_agents', 'revise_brief', 'new_task', 'command'];
    return typeof value === 'string' && routes.includes(value as UserMessageRoute) ? (value as UserMessageRoute) : undefined;
  }

  private asIntent(value: unknown): UserMessageIntent | undefined {
    const intents: UserMessageIntent[] = [
      'clarification',
      'constraint',
      'command',
      'question',
      'correction',
      'knowledge_input',
      'preference_input'
    ];
    return typeof value === 'string' && intents.includes(value as UserMessageIntent) ? (value as UserMessageIntent) : undefined;
  }

  private intentForRoute(route: UserMessageRoute, fallbackIntent: UserMessageIntent): UserMessageIntent {
    switch (route) {
      case 'answer':
        return 'question';
      case 'new_task':
        return 'correction';
      case 'command':
        return 'command';
      case 'apply_to_agents':
        return 'constraint';
      default:
        return fallbackIntent;
    }
  }

  async handleNewTaskRequest(session: SessionDetail, request: string) {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    this.emitAgentStatus(session.id, coordinator, 'thinking', {
      content: `${coordinator.name} 正在理解新任务需求…`,
      thoughtSummary: '分析用户需求，创建任务并分配给合适的 Agent。'
    });

    const contextPack = this.createContextPack(session, coordinator, undefined, undefined, request);
    const result = await this.runtime.run({
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'user_message_routing',
      agent: this.toRuntimeAgent(coordinator),
      contextPack,
      expectedOutput: {
        kind: 'agent_message',
        schemaVersion: '0.1',
        jsonSchema: {
          type: 'object',
          properties: {
            taskTitle: { type: 'string', description: '任务标题' },
            taskDescription: { type: 'string', description: '任务描述' },
            assigneeAgentId: { type: 'string', description: '负责的 Agent ID' },
            acceptanceCriteria: {
              type: 'array',
              items: { type: 'string' },
              description: '验收标准'
            }
          },
          required: ['taskTitle', 'taskDescription', 'assigneeAgentId']
        }
      },
      budget: {}
    });

    if (result.status !== 'completed' || !result.output) {
      throw this.runtimeError(result, 'new task request handling');
    }

    const output = result.output as unknown as {
      taskTitle: string;
      taskDescription: string;
      assigneeAgentId: string;
      acceptanceCriteria?: string[];
    };

    const task = this.tasks.create({
      sessionId: session.id,
      title: output.taskTitle,
      description: output.taskDescription,
      assigneeAgentId: output.assigneeAgentId,
      acceptanceCriteria: output.acceptanceCriteria ?? []
    });

    this.events.create({
      sessionId: session.id,
      type: 'task_created',
      taskId: task.id,
      fromAgentId: coordinator.id,
      content: `Created task: ${task.title}`,
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: task.status,
        assigneeAgentId: task.assigneeAgentId,
        acceptanceCriteria: task.acceptanceCriteria
      })
    });

    this.emitAgentStatus(session.id, coordinator, 'idle', {
      content: `${coordinator.name} 已创建任务并开始执行。`
    });

    // 立即执行任务
    if (!task.assigneeAgentId) {
      throw new Error(`Task ${task.id} has no assignee agent`);
    }
    const taskAgent = this.agents.getByIdOrKey(task.assigneeAgentId);
    this.tasks.update(task, { status: 'running' });
    this.emitAgentStatus(session.id, taskAgent, 'running', {
      content: `${taskAgent.name} 正在执行任务：${task.title}`,
      currentTaskId: task.id,
      currentTaskTitle: task.title,
      thoughtSummary: `执行任务「${task.title}」`
    });

    const taskContextPack = this.createContextPack(session, taskAgent, undefined, task);
    const taskResult = await this.runtime.run({
      runId: crypto.randomUUID(),
      sessionId: session.id,
      taskId: task.id,
      phase: 'task_execution',
      agent: this.toRuntimeAgent(taskAgent),
      contextPack: taskContextPack,
      expectedOutput: { kind: 'task_execution_result', schemaVersion: '0.1' },
      budget: {}
    });

    if (taskResult.status !== 'completed' || !taskResult.output) {
      this.markTaskFailed(
        session.id,
        task,
        taskAgent.id,
        taskResult.runId ?? crypto.randomUUID(),
        taskResult.error?.message ?? 'Runtime execution failed',
        taskAgent.runtimeType
      );
      throw this.runtimeError(taskResult, 'task execution');
    }

    const taskOutput = this.completedOutput<TaskExecutionResultOutput>(taskResult, 'task_execution_result');
    this.tasks.update(task, { status: 'completed' });
    this.events.create({
      sessionId: session.id,
      type: 'task_completed',
      taskId: task.id,
      fromAgentId: taskAgent.id,
      content: `任务已完成：${task.title}`,
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'completed',
        assigneeAgentId: task.assigneeAgentId,
        resultSummary: taskOutput.summary,
        completedItems: taskOutput.completedItems,
        risks: taskOutput.risks
      })
    });

    this.emitAgentStatus(session.id, taskAgent, 'idle', {
      content: `${taskAgent.name} 已完成任务：${task.title}`,
      actionSummary: taskOutput.summary
    });
  }

  private emitMemoryUsedEvent(sessionId: string, taskId: string, agentId: string, contextPack: ContextPack) {
    if (!contextPack.relevantMemories.length) {
      return;
    }
    this.events.create({
      sessionId,
      type: 'memory_used',
      taskId,
      fromAgentId: agentId,
      content: '已将相关记忆注入运行时上下文包。',
      metadata: createMetadata('system_notice', {
        agentId,
        taskId,
        memoryIds: contextPack.relevantMemories.map((memory) => memory.id),
        memories: contextPack.relevantMemories
      })
    });
  }

  private markTaskFailed(
    sessionId: string,
    task: AgentTask,
    agentId: string,
    runId: string,
    message: string,
    runtimeType: Agent['runtimeType']
  ) {
    this.tasks.update(task, { status: 'failed', resultSummary: message });
    this.events.create({
      sessionId,
      type: 'runtime_failed',
      taskId: task.id,
      fromAgentId: agentId,
      content: `运行时执行任务失败：${task.title}`,
      metadata: createMetadata('error_card', {
        runtimeInvocationId: runId,
        runtimeType,
        status: 'failed',
        message
      })
    });
    this.events.create({
      sessionId,
      type: 'task_rejected',
      taskId: task.id,
      fromAgentId: agentId,
      content: `任务失败：${task.title}`,
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'failed',
        resultSummary: message
      })
    });
  }

  private createExecutionArtifact(
    sessionId: string,
    task: AgentTask,
    agentId: string,
    output: TaskExecutionResultOutput,
    runtimeArtifacts: RuntimeArtifactOutput[]
  ) {
    const testAgent = this.agents.findByIdOrKey('test');
    return this.artifacts.create({
      sessionId,
      taskId: task.id,
      agentId,
      type: testAgent && agentId === testAgent.id ? 'test_report' : 'json',
      title: `${task.title} result`,
      contentSummary: output.summary,
      metadata: {
        phase: 'task_execution',
        status: output.status,
        output,
        runtimeArtifacts
      }
    });
  }

  private createContextPack(
    session: SessionDetail,
    agent: Agent,
    brief?: TaskBrief,
    task?: AgentTask,
    focusMessage?: string
  ): ContextPack {
    const ragSnippets = task ? this.searchAgentKnowledge(session, agent, task.title) : [];
    const relevantMemories = this.memories
      .search(session.id, [session.originalInput, brief?.goal, task?.title, task?.description].filter(Boolean).join(' '), agent.id)
      .map((memory) => this.memories.toRuntimeMemory(memory));
    return {
      systemRules: [
        'Return structured JSON that matches the expected RuntimeOutput kind.',
        'Do not perform external side effects unless a capability policy explicitly allows it.'
      ],
      sessionGoal: session.originalInput,
      focusMessage,
      taskBrief: brief
        ? {
            id: brief.id,
            sessionId: brief.sessionId,
            version: brief.version,
            goal: brief.goal,
            scope: brief.scope,
            outOfScope: brief.outOfScope,
            constraints: brief.constraints,
            acceptanceCriteria: brief.acceptanceCriteria,
            risks: brief.risks,
            openQuestions: brief.openQuestions
          }
        : undefined,
      currentTask: task,
      agentProfile: this.toRuntimeAgent(agent),
      relevantEvents: this.events.list(session.id).slice(-12).map((event) => ({
        eventId: event.id,
        type: event.type,
        summary: event.content,
        createdAt: event.createdAt
      })),
      relevantMemories,
      ragSnippets,
      artifacts: this.artifacts.listBySession(session.id).map((artifact) => ({
        artifactId: artifact.id,
        type: artifact.type,
        title: artifact.title,
        summary: artifact.contentSummary
      })),
      capabilities: this.capabilities.resolve(agent.capabilityIds),
      constraints: brief?.constraints ?? [],
      budget: {}
    };
  }

  private toRuntimeAgent(agent: Agent) {
    return {
      id: agent.id,
      key: agent.key,
      name: agent.name,
      role: agent.role,
      systemPrompt: agentSystemPrompt(agent),
      runtimeType: agent.runtimeType,
      modelId: agent.modelId,
      capabilityIds: agent.capabilityIds
    };
  }

  private participatingAgents(session: SessionDetail) {
    const agents = session.participatingAgentIds
      .map((agentId) => this.agents.findByIdOrKey(agentId))
      .filter((agent): agent is Agent => Boolean(agent));
    return agents.length ? agents : this.agents.list();
  }

  /** 参与简报讨论的角色：去掉协调者（主持人）和通知助手（不参与方案讨论），按职责顺序排列。 */
  private discussionAgents(session: SessionDetail): Agent[] {
    const order = ['requirements', 'architect', 'backend', 'frontend', 'test', 'review'];
    const agents = this.participatingAgents(session).filter(
      (agent) => agent.key !== 'coordinator' && agent.key !== 'notification'
    );
    return [...agents].sort((left, right) => {
      const leftIndex = order.indexOf(left.key);
      const rightIndex = order.indexOf(right.key);
      return (leftIndex === -1 ? order.length : leftIndex) - (rightIndex === -1 ? order.length : rightIndex);
    });
  }

  /** 单次讨论发言：以 discussion phase 运行一个 Agent，返回它面向团队的中文意见文本。 */
  private async runDiscussionTurn(session: SessionDetail, agent: Agent, focusMessage: string): Promise<string> {
    const result = await this.runtime.run({
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'discussion',
      agent: this.toRuntimeAgent(agent),
      contextPack: this.createContextPack(session, agent, undefined, undefined, focusMessage),
      expectedOutput: {
        kind: 'agent_message',
        schemaVersion: '0.1',
        jsonSchema: {
          type: 'object',
          properties: {
            messageKind: {
              type: 'string',
              enum: ['discussion', 'risk', 'summary', 'handoff', 'progress', 'answer', 'decision'],
              description: '发言类型，通常为 discussion，提示风险时用 risk'
            },
            content: { type: 'string', description: '面向团队的中文发言（2-4 句）' }
          },
          required: ['content']
        }
      },
      budget: {}
    });
    if (result.status !== 'completed' || !result.output) {
      throw this.runtimeError(result, 'discussion');
    }
    const output = result.output as Partial<AgentMessageOutput>;
    return output.content?.trim() || `${agent.name} 暂无补充意见。`;
  }

  private pickSessionAgent(session: SessionDetail, preferredKeys: string[], fallbackIndex = 0) {
    const agents = this.participatingAgents(session);
    for (const key of preferredKeys) {
      const preferred = agents.find((agent) => agent.key === key);
      if (preferred) {
        return preferred;
      }
    }
    const fallback = agents[fallbackIndex] ?? agents[0];
    if (!fallback) {
      throw new Error('No participating Agent is available for this session.');
    }
    return fallback;
  }

  private persistBriefs() {
    this.persistence.setCollection('briefsBySession', Object.fromEntries(this.briefsBySession));
    this.persistence.setCollection('suggestedTasksByBriefId', Object.fromEntries(this.suggestedTasksByBriefId));
  }

  private searchAgentKnowledge(session: SessionDetail, agent: Agent, query: string) {
    const knowledgeBaseIds = Array.from(new Set([...agent.defaultKnowledgeBaseIds, ...(session.knowledgeBaseIds ?? [])]));
    const matches = knowledgeBaseIds.flatMap((knowledgeBaseId) => this.knowledge.search(knowledgeBaseId, query));

    if (matches.length) {
      return matches.sort((left, right) => right.score - left.score).slice(0, Number(process.env.RAG_TOP_K ?? 6));
    }

    return [];
  }

  private completedOutput<TOutput extends { kind: string }>(result: AgentRunResult, expectedKind: TOutput['kind']) {
    if (result.status !== 'completed') {
      throw this.runtimeError(result, expectedKind);
    }
    const output = result.output as { kind?: string };
    if (output.kind !== expectedKind) {
      throw new Error(`Expected runtime output kind ${expectedKind}, got ${String(output.kind)}`);
    }
    return result.output as unknown as TOutput;
  }

  private runtimeError(result: AgentRunResult, phase: string) {
    return new Error(`${result.runtimeType} runtime failed during ${phase}: ${result.error?.message ?? result.status}`);
  }

  // Emits an agent_status_changed event so the UI can surface, in real time over SSE, which agent is
  // working in which phase. renderAs is left undefined so these don't clutter the chat timeline — they
  // only drive the agent cards.
  private emitAgentStatus(
    sessionId: string,
    agent: Agent,
    status: AgentStatus,
    details: {
      content?: string;
      currentTaskId?: string;
      currentTaskTitle?: string;
      thoughtSummary?: string;
      actionSummary?: string;
    } = {}
  ) {
    this.events.create({
      sessionId,
      type: 'agent_status_changed',
      fromAgentId: agent.id,
      content: details.content ?? `${agent.name} 状态更新为 ${status}`,
      metadata: createMetadata(undefined, {
        agentId: agent.id,
        status,
        currentTaskId: details.currentTaskId,
        currentTaskTitle: details.currentTaskTitle,
        thoughtSummary: details.thoughtSummary,
        actionSummary: details.actionSummary
      })
    });
  }

  private defaultSuggestedTasks(): SuggestedAgentTask[] {
    return [
      {
        title: 'Execute confirmed task brief',
        description: 'Run the configured backend agent against the confirmed task brief.',
        suggestedAgentKey: 'backend',
        acceptanceCriteria: ['Runtime returns a structured task_execution_result output.']
      },
      {
        title: 'Validate execution result',
        description: 'Run the configured test agent to validate the execution evidence.',
        suggestedAgentKey: 'test',
        acceptanceCriteria: ['Validation result is represented as a structured runtime output.']
      }
    ];
  }
}
