import { Injectable } from '@nestjs/common';
import type {
  Agent,
  AgentRunInput,
  AgentTask,
  ContextPack,
  SessionDetail,
  TaskBrief,
  TaskBriefOutput
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { AgentsService } from '../agents/agents.service.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { CapabilitiesService } from '../capabilities/capabilities.service.js';
import { EventsService } from '../events/events.service.js';
import { KnowledgeService } from '../rag/knowledge.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { RuntimeService } from '../runtimes/runtime.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { nowIso } from '../../common/time.js';

@Injectable()
export class OrchestratorService {
  private readonly briefsBySession = new Map<string, TaskBrief[]>();

  constructor(
    private readonly agents: AgentsService,
    private readonly events: EventsService,
    private readonly runtime: RuntimeService,
    private readonly tasks: TasksService,
    private readonly knowledge: KnowledgeService,
    private readonly artifacts: ArtifactsService,
    private readonly capabilities: CapabilitiesService,
    private readonly persistence: PersistenceService
  ) {
    const persisted = this.persistence.getCollection<Record<string, TaskBrief[]>>('briefsBySession', {});
    for (const [sessionId, briefs] of Object.entries(persisted)) {
      this.briefsBySession.set(sessionId, briefs);
    }
  }

  async discussAndCreateBrief(session: SessionDetail) {
    const coordinator = this.agents.getByIdOrKey('coordinator');
    const contextPack = this.createContextPack(session, coordinator);
    const result = await this.runtime.run({
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'brief_generation',
      agent: this.toRuntimeAgent(coordinator),
      contextPack,
      expectedOutput: { kind: 'task_brief', schemaVersion: '0.1' },
      budget: {}
    });

    const output = result.output as TaskBriefOutput;
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
    this.persistBriefs();

    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: this.agents.getByIdOrKey('requirements').id,
      toAgentIds: [coordinator.id],
      content: '我已梳理用户目标，并建议先确认任务契约再执行。',
      metadata: createMetadata('chat_message', { messageKind: 'discussion' })
    });

    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: this.agents.getByIdOrKey('architect').id,
      toAgentIds: [coordinator.id],
      content: '本阶段保持 dry-run，避免真实代码修改和外部通知。',
      metadata: createMetadata('chat_message', { messageKind: 'risk' })
    });

    this.events.create({
      sessionId: session.id,
      type: 'brief_created',
      fromAgentId: coordinator.id,
      content: 'Agent 团队已形成任务契约，请确认后执行。',
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
          requiresUserConfirmation: true
        },
        '任务契约'
      )
    });

    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_requested',
      fromAgentId: coordinator.id,
      content: '请确认是否按任务契约执行。',
      metadata: createMetadata('confirmation_card', {
        confirmationId: crypto.randomUUID(),
        reason: 'confirm_task_brief',
        title: '确认执行任务契约',
        description: '确认后将进入 dry-run 执行、测试验证、复盘和最终交付。',
        relatedBriefId: brief.id,
        options: [
          { key: 'approve', label: '确认执行', style: 'primary' },
          { key: 'revise', label: '继续沟通', style: 'default' }
        ]
      })
    });

    return brief;
  }

  listBriefs(sessionId: string) {
    return this.briefsBySession.get(sessionId) ?? [];
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
    const tasks = this.tasks.createFromSuggestions(
      session.id,
      [
        {
          title: '执行 dry-run 实现任务',
          description: '模拟后端 Agent 执行已确认任务契约。',
          suggestedAgentKey: 'backend',
          acceptanceCriteria: ['生成 runtime_started 和 runtime_completed 事件']
        },
        {
          title: '验证 dry-run 结果',
          description: '模拟测试 Agent 验证任务结果。',
          suggestedAgentKey: 'test',
          acceptanceCriteria: ['生成测试结果摘要']
        }
      ],
      agentIdByKey
    );

    const event = this.events.create({
      sessionId: session.id,
      type: 'brief_confirmed',
      content: '用户已确认任务契约，开始 dry-run 执行。',
      metadata: createMetadata('system_notice', { briefId: brief.id })
    });

    for (const task of tasks) {
      this.events.create({
        sessionId: session.id,
        type: 'task_created',
        taskId: task.id,
        content: `创建任务：${task.title}`,
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          status: task.status,
          assigneeAgentId: task.assigneeAgentId,
          acceptanceCriteria: task.acceptanceCriteria
        })
      });
    }

    await this.executeDryRun(session, brief, tasks);
    return { brief, event, createdTasks: tasks };
  }

  private async executeDryRun(session: SessionDetail, brief: TaskBrief, tasks: AgentTask[]) {
    const backend = this.agents.getByIdOrKey('backend');
    const review = this.agents.getByIdOrKey('review');

    for (const task of tasks) {
      const taskAgent = task.assigneeAgentId ? this.agents.getByIdOrKey(task.assigneeAgentId) : backend;
      this.tasks.update(task, { status: 'running' });
      this.events.create({
        sessionId: session.id,
        type: 'task_started',
        taskId: task.id,
        fromAgentId: task.assigneeAgentId,
        content: `开始执行：${task.title}`,
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
        content: 'MockRuntime started dry-run task execution.',
        metadata: createMetadata('system_notice', {
          runtimeInvocationId: runId,
          runtimeType: taskAgent.runtimeType,
          status: 'running'
        })
      });

      await this.runtime.run({
        runId,
        sessionId: session.id,
        taskId: task.id,
        phase: 'task_execution',
        agent: this.toRuntimeAgent(taskAgent),
        contextPack: this.createContextPack(session, taskAgent, brief, task),
        expectedOutput: { kind: 'task_execution_result', schemaVersion: '0.1' },
        budget: {}
      });

      this.events.create({
        sessionId: session.id,
        type: 'rag_retrieved',
        taskId: task.id,
        fromAgentId: taskAgent.id,
        content: '已检索 Agent 专属 RAG 知识片段。',
        metadata: createMetadata('rag_card', {
          retrievalLogId: crypto.randomUUID(),
          agentId: taskAgent.id,
          query: task.title,
          matchedChunks: this.searchAgentKnowledge(session, taskAgent, task.title)
        })
      });

      this.tasks.update(task, { status: 'completed', resultSummary: 'dry-run completed' });
      const executionArtifact = this.artifacts.create({
        sessionId: session.id,
        taskId: task.id,
        agentId: taskAgent.id,
        type: task.assigneeAgentId === this.agents.getByIdOrKey('test').id ? 'test_report' : 'json',
        title: `${task.title} artifact`,
        contentSummary: 'dry-run completed',
        metadata: {
          phase: 'task_execution',
          status: 'completed',
          resultSummary: 'dry-run completed'
        }
      });
      this.events.create({
        sessionId: session.id,
        type: 'artifact_created',
        taskId: task.id,
        fromAgentId: taskAgent.id,
        content: `生成产物：${executionArtifact.title}`,
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
        content: 'MockRuntime completed dry-run task execution.',
        metadata: createMetadata('system_notice', {
          runtimeInvocationId: runId,
          runtimeType: taskAgent.runtimeType,
          status: 'completed'
        })
      });
      this.events.create({
        sessionId: session.id,
        type: 'task_completed',
        taskId: task.id,
        fromAgentId: task.assigneeAgentId,
        content: `完成任务：${task.title}`,
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          status: 'completed',
          resultSummary: 'dry-run completed'
        })
      });
    }

    this.events.create({
      sessionId: session.id,
      type: 'post_review_started',
      fromAgentId: review.id,
      content: 'Review Agent 开始对比任务契约和 dry-run 结果。',
      metadata: createMetadata('review_card', { briefId: brief.id })
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
    const reviewArtifact = this.artifacts.create({
      sessionId: session.id,
      agentId: review.id,
      type: 'test_report',
      title: 'Post review report',
      contentSummary: '复盘完成：dry-run 结果与任务契约一致。',
      metadata: reviewRun.output as unknown as Record<string, unknown>
    });

    this.events.create({
      sessionId: session.id,
      type: 'post_review_completed',
      fromAgentId: review.id,
      content: '复盘完成：dry-run 结果与任务契约一致。',
      metadata: createMetadata('review_card', {
        ...(reviewRun.output as unknown as Record<string, unknown>),
        artifactIds: [reviewArtifact.id]
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'artifact_created',
      fromAgentId: review.id,
      content: `生成产物：${reviewArtifact.title}`,
      metadata: createMetadata('artifact_card', {
        artifactId: reviewArtifact.id,
        type: reviewArtifact.type,
        title: reviewArtifact.title,
        contentSummary: reviewArtifact.contentSummary
      })
    });

    const finalRun = await this.runtime.run({
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'final_delivery',
      agent: this.toRuntimeAgent(this.agents.getByIdOrKey('coordinator')),
      contextPack: this.createContextPack(session, review, brief),
      expectedOutput: { kind: 'final_delivery', schemaVersion: '0.1' },
      budget: {}
    });
    const coordinator = this.agents.getByIdOrKey('coordinator');
    const notification = this.agents.getByIdOrKey('notification');
    const deliveryArtifact = this.artifacts.create({
      sessionId: session.id,
      agentId: coordinator.id,
      type: 'markdown',
      title: 'Final delivery summary',
      contentSummary: 'v1 协作闭环 dry-run 已完成。',
      metadata: finalRun.output as unknown as Record<string, unknown>
    });
    const finalOutput = finalRun.output as unknown as Record<string, unknown>;
    const notificationDraft = this.artifacts.create({
      sessionId: session.id,
      agentId: notification.id,
      type: 'feishu_draft',
      title: 'Feishu notification draft',
      contentSummary: '飞书通知草稿已生成，当前未发送外部消息。',
      metadata: {
        channel: 'feishu',
        mode: 'draft',
        dryRun: true,
        status: 'pending_user_confirmation',
        title: 'Agent Cluster dry-run delivery ready',
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
      content: '最终交付已生成。',
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
      content: `生成产物：${deliveryArtifact.title}`,
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
      content: `生成产物：${notificationDraft.title}`,
      metadata: createMetadata('artifact_card', {
        artifactId: notificationDraft.id,
        type: notificationDraft.type,
        title: notificationDraft.title,
        contentSummary: notificationDraft.contentSummary,
        relatedCapabilityId: 'cap-feishu-draft'
      })
    });
  }

  private createContextPack(session: SessionDetail, agent: Agent, brief?: TaskBrief, task?: AgentTask): ContextPack {
    const ragSnippets = task ? this.searchAgentKnowledge(session, agent, task.title) : [];
    return {
      systemRules: ['使用 v0.1 契约输出结构化结果。', 'v1 阶段仅 dry-run，禁止真实高风险操作。'],
      sessionGoal: session.originalInput,
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
      relevantEvents: [],
      relevantMemories: [],
      ragSnippets,
      artifacts: [],
      capabilities: this.capabilities.resolve(agent.capabilityIds),
      constraints: brief?.constraints ?? ['dry-run only'],
      budget: {}
    };
  }

  private toRuntimeAgent(agent: Agent) {
    return {
      id: agent.id,
      key: agent.key,
      name: agent.name,
      role: agent.role,
      systemPrompt: `${agent.name}: ${agent.role}`,
      runtimeType: agent.runtimeType,
      capabilityIds: agent.capabilityIds
    };
  }

  private persistBriefs() {
    this.persistence.setCollection('briefsBySession', Object.fromEntries(this.briefsBySession));
  }

  private searchAgentKnowledge(session: SessionDetail, agent: Agent, query: string) {
    const knowledgeBaseIds = Array.from(new Set([...agent.defaultKnowledgeBaseIds, ...(session.knowledgeBaseIds ?? [])]));
    const matches = knowledgeBaseIds.flatMap((knowledgeBaseId) => this.knowledge.search(knowledgeBaseId, query));

    if (matches.length) {
      return matches.sort((left, right) => right.score - left.score).slice(0, Number(process.env.RAG_TOP_K ?? 6));
    }

    return this.knowledge.search('mock-kb-contracts', query);
  }
}
