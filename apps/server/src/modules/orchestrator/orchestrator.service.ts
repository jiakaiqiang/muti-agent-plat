import { Injectable } from '@nestjs/common';
import type {
  Agent,
  AgentMessageOutput,
  AgentRunInput,
  AgentRunResult,
  AgentTask,
  ContextPack,
  FinalDeliveryOutput,
  PostReviewReportOutput,
  RuntimeArtifactOutput,
  RuntimeError,
  SessionDetail,
  SuggestedAgentTask,
  TaskBrief,
  TaskBriefOutput,
  TaskExecutionResultOutput
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { messages } from '../../common/messages.js';
import { discussionTimeoutMs, runtimeModeLabel } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { buildBudget, fitContextToBudget } from '../../common/token.js';
import { AgentsService } from '../agents/agents.service.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { CapabilitiesService } from '../capabilities/capabilities.service.js';
import { EventsService } from '../events/events.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { KnowledgeService } from '../rag/knowledge.service.js';
import { RuntimeService } from '../runtimes/runtime.service.js';
import { TasksService } from '../tasks/tasks.service.js';

export type ExecutionOutcome =
  | { kind: 'delivered' }
  | { kind: 'rework'; reason: string }
  | { kind: 'ask_user'; reason: string }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'failed'; reason: string };

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
    this.events.create({
      sessionId: session.id,
      type: 'agent_status_changed',
      fromAgentId: coordinator.id,
      content: `${coordinator.name} received the requirement and is triaging the group discussion.`,
      metadata: createMetadata('system_notice', {
        agentId: coordinator.id,
        status: 'thinking',
        thoughtSummary: 'Receiving and triaging the user requirement.',
        actionSummary: 'Preparing discussion context and asking relevant Agents to assess the requirement.'
      })
    });
    await this.runDiscussion(session, coordinator);
    const result = await this.runRuntime(session, {
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'brief_generation',
      agent: this.toRuntimeAgent(coordinator),
      contextPack: this.createContextPack(session, coordinator),
      expectedOutput: { kind: 'task_brief', schemaVersion: '0.1' },
      budget: buildBudget(session)
    });
    const output = this.normalizeTaskBriefOutput(this.completedOutput<TaskBriefOutput>(result, 'task_brief'));
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
      type: 'brief_created',
      fromAgentId: coordinator.id,
      content: messages.briefCreated,
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
        messages.briefCardTitle
      )
    });

    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_requested',
      fromAgentId: coordinator.id,
      content: messages.confirmBrief,
      metadata: createMetadata('confirmation_card', {
        confirmationId: crypto.randomUUID(),
        reason: 'confirm_task_brief',
        title: messages.confirmBriefTitle,
        description: messages.confirmBriefDescription,
        relatedBriefId: brief.id,
        options: [
          { key: 'approve', label: messages.approve, style: 'primary' },
          { key: 'revise', label: messages.revise, style: 'default' }
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

  deleteSession(sessionId: string) {
    const briefs = this.briefsBySession.get(sessionId) ?? [];
    for (const brief of briefs) {
      this.suggestedTasksByBriefId.delete(brief.id);
    }
    this.briefsBySession.delete(sessionId);
    this.persistBriefs();
  }

  prepareExecution(session: SessionDetail, briefId: string): { brief: TaskBrief; tasks: AgentTask[] } {
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

    this.events.create({
      sessionId: session.id,
      type: 'brief_confirmed',
      content: messages.briefConfirmed,
      metadata: createMetadata('system_notice', { briefId: brief.id })
    });

    for (const task of tasks) {
      this.events.create({
        sessionId: session.id,
        type: 'task_created',
        taskId: task.id,
        content: messages.taskCreated(task.title),
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          status: task.status,
          assigneeAgentId: task.assigneeAgentId,
          acceptanceCriteria: task.acceptanceCriteria
        })
      });
    }

    return { brief, tasks };
  }

  async runPipeline(
    session: SessionDetail,
    brief: TaskBrief,
    tasks: AgentTask[],
    signal?: AbortSignal
  ): Promise<ExecutionOutcome> {
    const allTasks = this.tasks.list(session.id);
    const executableTasks = allTasks.length ? allTasks : tasks;
    while (true) {
      if (signal?.aborted) {
        return { kind: 'cancelled', reason: messages.cancelled };
      }

      const remaining = executableTasks.filter((task) => !this.isTerminalTask(task));
      if (!remaining.length) {
        break;
      }

      const readyTask = remaining.find((task) => this.isTaskReady(task, executableTasks));
      if (!readyTask) {
        return {
          kind: 'ask_user',
          reason: messages.dependencyBlocked
        };
      }

      const taskResult = await this.runOneTask(session, brief, readyTask, signal);
      if (signal?.aborted) {
        return { kind: 'cancelled', reason: messages.cancelled };
      }
      if (!taskResult.ok) {
        return { kind: 'ask_user', reason: `${messages.taskFailed(readyTask.title)}: ${taskResult.message}` };
      }
    }

    if (signal?.aborted) {
      return { kind: 'cancelled', reason: messages.cancelled };
    }

    let review: PostReviewReportOutput;
    try {
      review = await this.runPostReview(session, brief, signal);
    } catch (error) {
      if (signal?.aborted) {
        return { kind: 'cancelled', reason: messages.cancelled };
      }
      throw error;
    }
    if (review.recommendation === 'rework') {
      return { kind: 'rework', reason: review.mismatchedItems.join('; ') || messages.reviewRework };
    }
    if (review.recommendation === 'ask_user') {
      return { kind: 'ask_user', reason: review.mismatchedItems.join('; ') || messages.reviewAskUser };
    }

    const alreadyDelivered = this.events.list(session.id).some((event) => event.type === 'final_delivery_created');
    if (!alreadyDelivered) {
      try {
        await this.runFinalDelivery(session, brief, signal);
      } catch (error) {
        if (signal?.aborted) {
          return { kind: 'cancelled', reason: messages.cancelled };
        }
        throw error;
      }
    }
    return { kind: 'delivered' };
  }

  private async runOneTask(
    session: SessionDetail,
    brief: TaskBrief,
    task: AgentTask,
    signal?: AbortSignal
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const backend = this.pickSessionAgent(session, ['backend'], 0);
    const taskAgent = task.assigneeAgentId ? this.agents.getByIdOrKey(task.assigneeAgentId) : backend;
    this.tasks.update(task, { status: 'running' });
    this.events.create({
      sessionId: session.id,
      type: 'task_started',
      taskId: task.id,
      fromAgentId: taskAgent.id,
      content: messages.taskStarted(task.title),
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
      content: messages.runtimeStarted(taskAgent.name, runtimeModeLabel(taskAgent.runtimeType)),
      metadata: createMetadata('system_notice', {
        runtimeInvocationId: runId,
        runtimeType: taskAgent.runtimeType,
        status: 'running'
      })
    });

    const contextPack = this.createContextPack(session, taskAgent, brief, task);
    this.emitMemoryUsedEvent(session.id, task.id, taskAgent.id, contextPack);

    const result = await this.runRuntime(session, {
      runId,
      sessionId: session.id,
      taskId: task.id,
      phase: 'task_execution',
      agent: this.toRuntimeAgent(taskAgent),
      contextPack,
      expectedOutput: { kind: 'task_execution_result', schemaVersion: '0.1' },
      budget: contextPack.budget
    }, signal);

    if (signal?.aborted) {
      const message = messages.cancelled;
      this.markTaskCancelled(session.id, task, taskAgent.id, runId, message, taskAgent.runtimeType);
      return { ok: false, message };
    }

    if (result.status !== 'completed') {
      const message = result.error?.message ?? result.status;
      this.markTaskFailed(session.id, task, taskAgent.id, runId, message, taskAgent.runtimeType, result.error?.code);
      return { ok: false, message };
    }

    const output = this.completedOutput<TaskExecutionResultOutput>(result, 'task_execution_result');
    this.events.create({
      sessionId: session.id,
      type: 'rag_retrieved',
      taskId: task.id,
      fromAgentId: taskAgent.id,
      content: messages.ragRetrieved,
      metadata: createMetadata('rag_card', {
        retrievalLogId: crypto.randomUUID(),
        agentId: taskAgent.id,
        query: task.title,
        matchedChunks: this.searchAgentKnowledge(session, taskAgent, task.title)
      })
    });

    if (output.status !== 'completed') {
      this.markTaskFailed(session.id, task, taskAgent.id, runId, output.summary, taskAgent.runtimeType);
      return { ok: false, message: output.summary };
    }

    this.tasks.update(task, { status: 'completed', resultSummary: output.summary });
    const executionArtifact = this.createExecutionArtifact(session.id, task, taskAgent.id, output, result.artifacts);
    const fileChanges = this.fileChangesForArtifact(executionArtifact.metadata);
    this.events.create({
      sessionId: session.id,
      type: 'artifact_created',
      taskId: task.id,
      fromAgentId: taskAgent.id,
      content: messages.artifactCreated(executionArtifact.title),
      metadata: createMetadata('artifact_card', {
        artifactId: executionArtifact.id,
        type: executionArtifact.type,
        title: executionArtifact.title,
        contentSummary: executionArtifact.contentSummary,
        fileChanges
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'runtime_completed',
      taskId: task.id,
      fromAgentId: taskAgent.id,
      content: messages.runtimeCompleted(taskAgent.name, runtimeModeLabel(taskAgent.runtimeType)),
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
      content: messages.taskCompleted(task.title),
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'completed',
        resultSummary: output.summary,
        completedItems: output.completedItems,
        risks: output.risks
      })
    });
    return { ok: true };
  }

  private async runPostReview(session: SessionDetail, brief: TaskBrief, signal?: AbortSignal): Promise<PostReviewReportOutput> {
    const review = this.pickSessionAgent(session, ['review', 'test'], 1);
    this.events.create({
      sessionId: session.id,
      type: 'post_review_started',
      fromAgentId: review.id,
      content: messages.reviewStarted,
      metadata: createMetadata('review_card', { briefId: brief.id })
    });

    const reviewContextPack = this.createContextPack(session, review, brief);
    const reviewRun = await this.runRuntime(session, {
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'post_review',
      agent: this.toRuntimeAgent(review),
      contextPack: reviewContextPack,
      expectedOutput: { kind: 'post_review_report', schemaVersion: '0.1' },
      budget: reviewContextPack.budget
    }, signal);
    if (signal?.aborted) {
      throw new Error(messages.cancelled);
    }
    const reviewOutput = this.completedOutput<PostReviewReportOutput>(reviewRun, 'post_review_report');
    const reviewArtifact = this.artifacts.create({
      sessionId: session.id,
      agentId: review.id,
      type: 'test_report',
      title: messages.reviewReportTitle,
      contentSummary: reviewOutput.recommendation,
      metadata: reviewOutput as unknown as Record<string, unknown>
    });
    this.events.create({
      sessionId: session.id,
      type: 'post_review_completed',
      fromAgentId: review.id,
      content: messages.reviewCompleted,
      metadata: createMetadata('review_card', {
        ...reviewOutput,
        artifactIds: [reviewArtifact.id]
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'artifact_created',
      fromAgentId: review.id,
      content: messages.artifactCreated(reviewArtifact.title),
      metadata: createMetadata('artifact_card', {
        artifactId: reviewArtifact.id,
        type: reviewArtifact.type,
        title: reviewArtifact.title,
        contentSummary: reviewArtifact.contentSummary
      })
    });
    return reviewOutput;
  }

  private async runFinalDelivery(session: SessionDetail, brief: TaskBrief, signal?: AbortSignal): Promise<void> {
    const review = this.pickSessionAgent(session, ['review', 'test'], 1);
    const coordinator = this.pickSessionAgent(session, ['coordinator'], 0);
    const finalContextPack = this.createContextPack(session, review, brief);
    const finalRun = await this.runRuntime(session, {
      runId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'final_delivery',
      agent: this.toRuntimeAgent(coordinator),
      contextPack: finalContextPack,
      expectedOutput: { kind: 'final_delivery', schemaVersion: '0.1' },
      budget: finalContextPack.budget
    }, signal);
    if (signal?.aborted) {
      throw new Error(messages.cancelled);
    }
    const finalOutput = this.completedOutput<FinalDeliveryOutput>(finalRun, 'final_delivery');
    const notification = this.pickSessionAgent(session, ['notification'], 0);
    const deliveryArtifact = this.artifacts.create({
      sessionId: session.id,
      agentId: coordinator.id,
      type: 'markdown',
      title: messages.finalDeliveryTitle,
      contentSummary: finalOutput.summary,
      metadata: finalOutput as unknown as Record<string, unknown>
    });
    const notificationDraft = this.artifacts.create({
      sessionId: session.id,
      agentId: notification.id,
      type: 'feishu_draft',
      title: messages.notificationDraftTitle,
      contentSummary: messages.notificationDraftSummary,
      metadata: {
        channel: 'feishu',
        mode: 'draft',
        dryRun: true,
        status: 'pending_user_confirmation',
        title: messages.notificationDraftMetadataTitle,
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
      content: messages.finalDeliveryCreated,
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
      content: messages.artifactCreated(deliveryArtifact.title),
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
      content: messages.artifactCreated(notificationDraft.title),
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
      content: messages.memoryUsed,
      metadata: createMetadata('system_notice', {
        agentId,
        taskId,
        memoryIds: contextPack.relevantMemories.map((memory) => memory.id),
        memories: contextPack.relevantMemories
      })
    });
  }

  private async runDiscussion(session: SessionDetail, coordinator: Agent) {
    const participants = this.discussionParticipants(session, coordinator);
    const rounds = this.discussionMaxRounds();
    const timeoutMs = discussionTimeoutMs();
    for (let round = 1; round <= rounds; round += 1) {
      for (const agent of participants) {
        const runId = crypto.randomUUID();
        const contextPack = this.createContextPack(session, agent);
        this.events.create({
          sessionId: session.id,
          type: 'agent_status_changed',
          fromAgentId: agent.id,
          content: `${agent.name} is checking whether the requirement is relevant to its responsibilities.`,
          metadata: createMetadata('system_notice', {
            agentId: agent.id,
            status: 'discussing',
            thoughtSummary: 'Checking requirement relevance.',
            actionSummary: 'Reviewing the user requirement before brief creation.',
            waitingFor: [coordinator.id]
          })
        });
        const result = await this.runDiscussionRuntime(session, agent, runId, contextPack, timeoutMs);
        const timedOut = result.error?.code === 'RUNTIME_TIMEOUT';
        const output =
          result.status === 'completed' && (result.output as { kind?: string }).kind === 'agent_message'
            ? (result.output as AgentMessageOutput)
            : ({
                kind: 'agent_message',
                messageKind: 'risk',
                content: timedOut
                  ? `${agent.name} discussion timed out; Coordinator will continue with the available context.`
                  : `${agent.name} could not complete discussion: ${result.error?.message ?? result.status}`
              } satisfies AgentMessageOutput);
        this.events.create({
          sessionId: session.id,
          type: 'agent_status_changed',
          fromAgentId: agent.id,
          content: timedOut
            ? `${agent.name} did not respond before the discussion timeout.`
            : `${agent.name} completed requirement relevance assessment.`,
          metadata: createMetadata('system_notice', {
            agentId: agent.id,
            status: timedOut ? 'waiting' : 'thinking',
            thoughtSummary: timedOut
              ? 'Discussion timed out; waiting for a later turn or user clarification.'
              : 'Requirement relevance assessment completed.',
            actionSummary: output.content,
            waitingFor: timedOut ? [coordinator.id] : []
          })
        });
        this.events.create({
          sessionId: session.id,
          type: 'agent_message',
          fromAgentId: agent.id,
          toAgentIds: [coordinator.id],
          content: output.content,
          metadata: createMetadata('chat_message', {
            messageKind: output.messageKind,
            mentionedAgentIds: output.mentionedAgentIds ?? [],
            relatedTaskIds: output.relatedTaskIds ?? [],
            runtimeInvocationId: runId,
            round
          })
        });
      }
    }
  }
  private async runDiscussionRuntime(
    session: SessionDetail,
    agent: Agent,
    runId: string,
    contextPack: ContextPack,
    timeoutMs: number
  ) {
    if (timeoutMs <= 0) {
      return this.runRuntime(session, {
        runId,
        sessionId: session.id,
        phase: 'discussion',
        agent: this.toRuntimeAgent(agent),
        contextPack,
        expectedOutput: { kind: 'agent_message', schemaVersion: '0.1' },
        budget: contextPack.budget
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(`Discussion runtime timed out after ${timeoutMs}ms during ${agent.name} discussion.`);
    }, timeoutMs);

    try {
      return await this.runRuntime(
        session,
        {
          runId,
          sessionId: session.id,
          phase: 'discussion',
          agent: this.toRuntimeAgent(agent),
          contextPack,
          expectedOutput: { kind: 'agent_message', schemaVersion: '0.1' },
          budget: contextPack.budget
        },
        controller.signal
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private discussionParticipants(session: SessionDetail, coordinator: Agent) {
    const configuredKeys = (process.env.DISCUSSION_AGENT_KEYS ?? 'requirements,architect,backend,test')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
    const participants = configuredKeys
      .map((key) => this.participatingAgents(session).find((agent) => agent.key === key))
      .filter((agent): agent is Agent => Boolean(agent))
      .filter((agent) => agent.id !== coordinator.id);

    if (participants.length) {
      return Array.from(new Map(participants.map((agent) => [agent.id, agent])).values());
    }

    return this.participatingAgents(session)
      .filter((agent) => agent.id !== coordinator.id)
      .slice(0, 3);
  }

  private discussionMaxRounds() {
    const parsed = Number(process.env.DISCUSSION_MAX_ROUNDS ?? 1);
    if (!Number.isFinite(parsed)) {
      return 1;
    }
    return Math.max(0, Math.min(3, Math.floor(parsed)));
  }

  private isTerminalTask(task: AgentTask) {
    return ['completed', 'cancelled', 'failed', 'rejected'].includes(task.status);
  }

  private isTaskReady(task: AgentTask, tasks: AgentTask[]) {
    if (!task.dependsOnTaskIds.length) {
      return true;
    }
    const taskById = new Map(tasks.map((item) => [item.id, item]));
    return task.dependsOnTaskIds.every((dependencyId) => taskById.get(dependencyId)?.status === 'completed');
  }

  private markTaskFailed(
    sessionId: string,
    task: AgentTask,
    agentId: string,
    runId: string,
    message: string,
    runtimeType: Agent['runtimeType'],
    code: RuntimeError['code'] = 'MODEL_ERROR'
  ) {
    this.tasks.update(task, { status: 'failed', resultSummary: message });
    this.events.create({
      sessionId,
      type: 'runtime_failed',
      taskId: task.id,
      fromAgentId: agentId,
      content: messages.runtimeFailed(task.title),
      metadata: createMetadata('error_card', {
        runtimeInvocationId: runId,
        runtimeType,
        status: 'failed',
        code,
        message
      })
    });
    this.events.create({
      sessionId,
      type: 'task_rejected',
      taskId: task.id,
      fromAgentId: agentId,
      content: messages.taskFailed(task.title),
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'failed',
        resultSummary: message
      })
    });
  }

  private markTaskCancelled(
    sessionId: string,
    task: AgentTask,
    agentId: string,
    runId: string,
    message: string,
    runtimeType: Agent['runtimeType']
  ) {
    this.tasks.update(task, { status: 'waiting', resultSummary: message });
    this.events.create({
      sessionId,
      type: 'runtime_failed',
      taskId: task.id,
      fromAgentId: agentId,
      content: messages.runtimeFailed(task.title),
      metadata: createMetadata('error_card', {
        runtimeInvocationId: runId,
        runtimeType,
        status: 'cancelled',
        code: 'RUNTIME_CANCELLED',
        message
      })
    });
    this.events.create({
      sessionId,
      type: 'task_waiting',
      taskId: task.id,
      fromAgentId: agentId,
      content: `Task paused and waiting to resume: ${task.title}`,
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'waiting',
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
    const fileChanges = this.fileChangesFromRuntimeArtifacts([...output.changedArtifacts, ...runtimeArtifacts]);
    return this.artifacts.create({
      sessionId,
      taskId: task.id,
      agentId,
      type: testAgent && agentId === testAgent.id ? 'test_report' : 'json',
      title: `${task.title} execution result`,
      contentSummary: output.summary,
      metadata: {
        phase: 'task_execution',
        status: output.status,
        output,
        runtimeArtifacts,
        fileChanges
      }
    });
  }

  private fileChangesFromRuntimeArtifacts(artifacts: RuntimeArtifactOutput[]) {
    return artifacts.flatMap((artifact) => artifact.metadata?.fileChanges ?? []);
  }

  private fileChangesForArtifact(metadata: Record<string, unknown>) {
    const fileChanges = metadata.fileChanges;
    return Array.isArray(fileChanges) ? fileChanges : [];
  }

  private createContextPack(session: SessionDetail, agent: Agent, brief?: TaskBrief, task?: AgentTask): ContextPack {
    const ragSnippets = task ? this.searchAgentKnowledge(session, agent, task.title) : [];
    const relevantMemories = this.memories
      .search(session.id, [session.originalInput, brief?.goal, task?.title, task?.description].filter(Boolean).join(' '), agent.id)
      .map((memory) => this.memories.toRuntimeMemory(memory));
    return {
      systemRules: [
        'Return structured JSON matching the expected RuntimeOutput kind.',
        'Do not perform external side effects unless explicitly allowed by capability policy.'
      ],
      sessionGoal: session.originalInput,
      workingDirectory: session.workingDirectory,
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
      budget: buildBudget(session)
    };
  }

  private async runRuntime(inputSession: SessionDetail, input: AgentRunInput, signal?: AbortSignal) {
    const contextPack = {
      ...input.contextPack,
      budget: input.budget
    };
    const fitted = fitContextToBudget(contextPack);
    const maxInputTokens = fitted.contextPack.budget.maxInputTokens;
    if (maxInputTokens && fitted.estimatedTokens > maxInputTokens) {
      const result = this.tokenBudgetExceededResult(input, fitted.estimatedTokens, maxInputTokens);
      this.events.create({
        sessionId: input.sessionId,
        type: 'error_reported',
        priority: 'high',
        content: `Token budget exceeded: estimated ${fitted.estimatedTokens} tokens, max ${maxInputTokens} tokens.`,
        metadata: createMetadata('error_card', {
          code: 'TOKEN_BUDGET_EXCEEDED',
          estimatedTokens: fitted.estimatedTokens,
          maxInputTokens
        })
      });
      return result;
    }

    if (fitted.trimmed) {
      this.events.create({
        sessionId: input.sessionId,
        type: 'runtime_progress',
        taskId: input.taskId,
        fromAgentId: input.agent.id,
        content: 'Context was trimmed to fit the token budget.',
        metadata: createMetadata('system_notice', {
          runtimeInvocationId: input.runId,
          code: 'TOKEN_CONTEXT_TRIMMED',
          estimatedTokens: fitted.estimatedTokens
        })
      });
    }

    const result = await this.runtime.run(
      {
        ...input,
        contextPack: fitted.contextPack,
        budget: fitted.contextPack.budget
      },
      signal
    );
    this.recordTokenUsage(inputSession, result);
    return result;
  }

  private recordTokenUsage(session: SessionDetail, result: AgentRunResult) {
    const used = result.usage?.totalTokens ?? 0;
    if (!used) {
      return;
    }
    session.tokenUsed += used;
    const updatedAt = nowIso();
    session.updatedAt = updatedAt;
    const sessions = this.persistence.getCollection<SessionDetail[]>('sessions', []);
    this.persistence.setCollection(
      'sessions',
      sessions.map((item) => (item.id === session.id ? { ...item, tokenUsed: session.tokenUsed, updatedAt } : item))
    );
  }

  private tokenBudgetExceededResult(input: AgentRunInput, estimatedTokens: number, maxInputTokens: number): AgentRunResult {
    return {
      runId: input.runId,
      runtimeType: input.agent.runtimeType,
      status: 'failed',
      output: {
        kind: 'agent_message',
        messageKind: 'risk',
        content: 'Token budget is insufficient; runtime invocation was not started.'
      } satisfies AgentMessageOutput,
      events: [],
      artifacts: [],
      usage: {
        inputTokens: estimatedTokens,
        outputTokens: 0,
        totalTokens: estimatedTokens,
        model: input.agent.runtimeType
      },
      error: {
        code: 'TOKEN_BUDGET_EXCEEDED',
        message: `Estimated input tokens ${estimatedTokens} exceed budget ${maxInputTokens}.`,
        retryable: false,
        details: {
          estimatedTokens,
          maxInputTokens
        }
      }
    };
  }

  private toRuntimeAgent(agent: Agent) {
    return {
      id: agent.id,
      key: agent.key,
      name: agent.name,
      role: agent.role,
      profileMarkdown: agent.profileMarkdown,
      systemPrompt: agent.profileMarkdown?.trim() || `${agent.name}: ${agent.role}`,
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
      throw new Error('Current session has no available Agent.');
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
      throw new Error(`Expected runtime output kind=${expectedKind}, got ${String(output.kind)}`);
    }
    return result.output as unknown as TOutput;
  }

  private normalizeTaskBriefOutput(output: TaskBriefOutput): TaskBriefOutput {
    return {
      ...output,
      goal: output.goal || 'Pending confirmed task goal',
      scope: this.stringList(output.scope),
      outOfScope: this.stringList(output.outOfScope),
      constraints: this.stringList(output.constraints),
      acceptanceCriteria: this.stringList(output.acceptanceCriteria),
      risks: this.stringList(output.risks),
      openQuestions: this.stringList(output.openQuestions),
      suggestedTasks: Array.isArray(output.suggestedTasks)
        ? output.suggestedTasks.map((task) => ({
            ...task,
            acceptanceCriteria: this.stringList(task.acceptanceCriteria)
          }))
        : []
    };
  }

  private stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
  }

  private runtimeError(result: AgentRunResult, phase: string) {
    return Object.assign(new Error(messages.runtimeError(result.runtimeType, phase, result.error?.message ?? result.status)), {
      cause: result.error
    });
  }

  private defaultSuggestedTasks(): SuggestedAgentTask[] {
    return [
      {
        title: messages.defaultTaskExecuteTitle,
        description: messages.defaultTaskExecuteDescription,
        suggestedAgentKey: 'backend',
        acceptanceCriteria: [messages.defaultTaskExecuteAcceptance]
      },
      {
        title: messages.defaultTaskValidateTitle,
        description: messages.defaultTaskValidateDescription,
        suggestedAgentKey: 'test',
        acceptanceCriteria: [messages.defaultTaskValidateAcceptance]
      }
    ];
  }
}
