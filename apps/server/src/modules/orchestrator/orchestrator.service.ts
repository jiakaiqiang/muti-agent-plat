import { Injectable } from '@nestjs/common';
import type {
  Agent,
  AgentRunInput,
  AgentRunResult,
  AgentTask,
  ContextPack,
  FinalDeliveryOutput,
  PostReviewReportOutput,
  RuntimeArtifactOutput,
  SessionDetail,
  SuggestedAgentTask,
  TaskBrief,
  TaskBriefOutput,
  TaskExecutionResultOutput
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

  async discussAndCreateBrief(session: SessionDetail) {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    const result = await this.runtime.run({
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'brief_generation',
      agent: this.toRuntimeAgent(coordinator),
      contextPack: this.createContextPack(session, coordinator),
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
      type: 'agent_message',
      fromAgentId: this.pickSessionAgent(session, ['requirements'], 0).id,
      toAgentIds: [coordinator.id],
      content: 'Requirements Agent summarized the user goal and recommends confirming the task brief before execution.',
      metadata: createMetadata('chat_message', { messageKind: 'discussion' })
    });

    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: this.pickSessionAgent(session, ['architect', 'backend'], 0).id,
      toAgentIds: [coordinator.id],
      content: `Execution will use the configured ${runtimeModeLabel(coordinator.runtimeType)} runtime and capability policy.`,
      metadata: createMetadata('chat_message', { messageKind: 'risk' })
    });

    this.events.create({
      sessionId: session.id,
      type: 'brief_created',
      fromAgentId: coordinator.id,
      content: 'Agent team created a task brief. Confirm it to start execution.',
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
      content: 'Please confirm whether to execute the task brief.',
      metadata: createMetadata('confirmation_card', {
        confirmationId: crypto.randomUUID(),
        reason: 'confirm_task_brief',
        title: 'Confirm task brief execution',
        description:
          'After confirmation, the configured agent runtime will execute the suggested tasks and create review and delivery artifacts.',
        relatedBriefId: brief.id,
        options: [
          { key: 'approve', label: 'Approve', style: 'primary' },
          { key: 'revise', label: 'Revise', style: 'default' }
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
    const suggestions = this.suggestedTasksByBriefId.get(brief.id) ?? this.defaultSuggestedTasks();
    const tasks = this.tasks.createFromSuggestions(session.id, suggestions, agentIdByKey);

    const event = this.events.create({
      sessionId: session.id,
      type: 'brief_confirmed',
      content: 'User confirmed the task brief. Starting configured agent runtime execution.',
      metadata: createMetadata('system_notice', { briefId: brief.id })
    });

    for (const task of tasks) {
      this.events.create({
        sessionId: session.id,
        type: 'task_created',
        taskId: task.id,
        content: `Created task: ${task.title}`,
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
      this.events.create({
        sessionId: session.id,
        type: 'task_started',
        taskId: task.id,
        fromAgentId: taskAgent.id,
        content: `Started task: ${task.title}`,
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
        content: 'Retrieved agent knowledge snippets for the task.',
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
        content: `Created artifact: ${executionArtifact.title}`,
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
        content: `Completed task: ${task.title}`,
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          status: 'completed',
          resultSummary: output.summary,
          completedItems: output.completedItems,
          risks: output.risks
        })
      });
    }

    this.events.create({
      sessionId: session.id,
      type: 'post_review_started',
      fromAgentId: review.id,
      content: 'Review Agent started checking runtime results against the confirmed task brief.',
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
    const reviewOutput = this.completedOutput<PostReviewReportOutput>(reviewRun, 'post_review_report');
    const reviewArtifact = this.artifacts.create({
      sessionId: session.id,
      agentId: review.id,
      type: 'test_report',
      title: 'Post review report',
      contentSummary: reviewOutput.recommendation,
      metadata: reviewOutput as unknown as Record<string, unknown>
    });
    this.events.create({
      sessionId: session.id,
      type: 'post_review_completed',
      fromAgentId: review.id,
      content: 'Review Agent completed the consistency review.',
      metadata: createMetadata('review_card', {
        ...reviewOutput,
        artifactIds: [reviewArtifact.id]
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'artifact_created',
      fromAgentId: review.id,
      content: `Created artifact: ${reviewArtifact.title}`,
      metadata: createMetadata('artifact_card', {
        artifactId: reviewArtifact.id,
        type: reviewArtifact.type,
        title: reviewArtifact.title,
        contentSummary: reviewArtifact.contentSummary
      })
    });

    const coordinator = this.pickSessionAgent(session, ['coordinator'], 0);
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
      title: 'Final delivery summary',
      contentSummary: finalOutput.summary,
      metadata: finalOutput as unknown as Record<string, unknown>
    });
    const notificationDraft = this.artifacts.create({
      sessionId: session.id,
      agentId: notification.id,
      type: 'feishu_draft',
      title: 'Feishu notification draft',
      contentSummary: 'Notification draft created and awaiting explicit send confirmation.',
      metadata: {
        channel: 'feishu',
        mode: 'draft',
        dryRun: true,
        status: 'pending_user_confirmation',
        title: 'Agent Cluster delivery ready',
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
      content: 'Final delivery was created.',
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
      content: `Created artifact: ${deliveryArtifact.title}`,
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
      content: `Created artifact: ${notificationDraft.title}`,
      metadata: createMetadata('artifact_card', {
        artifactId: notificationDraft.id,
        type: notificationDraft.type,
        title: notificationDraft.title,
        contentSummary: notificationDraft.contentSummary,
        relatedCapabilityId: 'cap-feishu-draft'
      })
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
      content: 'Relevant memories were injected into the runtime context pack.',
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
      content: `Runtime failed while executing task: ${task.title}`,
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
      content: `Task failed: ${task.title}`,
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

  private createContextPack(session: SessionDetail, agent: Agent, brief?: TaskBrief, task?: AgentTask): ContextPack {
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
      systemPrompt: `${agent.name}: ${agent.role}`,
      runtimeType: agent.runtimeType,
      capabilityIds: agent.capabilityIds
    };
  }

  private participatingAgents(session: SessionDetail) {
    const agents = session.participatingAgentIds
      .map((agentId) => this.agents.findByIdOrKey(agentId))
      .filter((agent): agent is Agent => Boolean(agent));
    return agents.length ? agents : this.agents.list();
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
