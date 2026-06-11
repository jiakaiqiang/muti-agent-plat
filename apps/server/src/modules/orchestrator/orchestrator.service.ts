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
  RuntimeFileChange,
  SessionDetail,
  SuggestedAgentTask,
  TaskBrief,
  TaskBriefOutput,
  TaskExecutionResultOutput,
  WorkspaceSnapshot
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { applyServerLocalFileChanges } from '../../common/server-file-changes.js';
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
    await this.emitWorkspaceAnalyzedEvent(session, coordinator);
    this.events.create({
      sessionId: session.id,
      type: 'agent_status_changed',
      fromAgentId: coordinator.id,
      content: messages.coordinatorIntakeStatus(coordinator.name),
      metadata: createMetadata('system_notice', {
        agentId: coordinator.id,
        status: 'thinking',
        thoughtSummary: messages.coordinatorIntakeThought,
        actionSummary: messages.coordinatorIntakeAction
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      toAgentIds: this.discussionParticipants(session, coordinator).map((agent) => agent.id),
      content: `${coordinator.name} 已接收需求，将先完成需求理解与拆分，再组织其他 Agent 讨论。`,
      metadata: createMetadata('chat_message', {
        messageKind: 'decision',
        coordinatorAgentId: coordinator.id,
        phase: 'requirement_intake'
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

    const briefFileChanges = this.briefFileChanges(brief, suggestedTasks);
    const briefArtifact = this.artifacts.create({
      sessionId: session.id,
      agentId: coordinator.id,
      type: 'markdown',
      title: `任务契约 v${brief.version}`,
      contentSummary: brief.goal,
      metadata: {
        phase: 'task_brief',
        briefId: brief.id,
        fileChanges: briefFileChanges
      }
    });
    this.events.create({
      sessionId: session.id,
      type: 'artifact_created',
      fromAgentId: coordinator.id,
      content: messages.artifactCreated(briefArtifact.title),
      metadata: createMetadata('artifact_card', {
        artifactId: briefArtifact.id,
        type: briefArtifact.type,
        title: briefArtifact.title,
        contentSummary: briefArtifact.contentSummary,
        fileChanges: briefFileChanges
      })
    });
    await this.applyServerLocalArtifactChanges(session, briefFileChanges);

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

  private async emitWorkspaceAnalyzedEvent(session: SessionDetail, coordinator: Agent) {
    const snapshot = session.workspaceSnapshot;
    if (!snapshot) return;
    const focus = this.workspaceFocus(session);
    const analysis = this.workspaceAnalysis(session, snapshot, focus);
    const fileChanges = this.workspaceAnalysisFileChanges(analysis.markdown);
    const artifact = this.artifacts.create({
      sessionId: session.id,
      agentId: coordinator.id,
      type: 'markdown',
      title: '工作区架构分析',
      contentSummary: analysis.summary,
      metadata: {
        phase: 'workspace_analysis',
        workspace: analysis.payload,
        fileChanges
      }
    });
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      content: analysis.chatContent(coordinator.name),
      metadata: createMetadata('chat_message', {
        messageKind: 'decision',
        phase: 'workspace_analysis',
        workspace: analysis.payload,
        artifactId: artifact.id,
        fileChanges
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'artifact_created',
      fromAgentId: coordinator.id,
      content: messages.artifactCreated(artifact.title),
      metadata: createMetadata('artifact_card', {
        artifactId: artifact.id,
        type: artifact.type,
        title: artifact.title,
        contentSummary: artifact.contentSummary,
        fileChanges
      })
    });
    await this.applyServerLocalArtifactChanges(session, fileChanges);
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

    const agentIdByKey = new Map(this.participatingAgents(session).map((agent) => [agent.key, agent.id]));
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
    while (true) {
      if (signal?.aborted) {
        return { kind: 'cancelled', reason: messages.cancelled };
      }

      const allTasks = this.tasks.list(session.id);
      const executableTasks = allTasks.length ? allTasks : tasks;
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
    await this.applyServerLocalArtifactChanges(session, fileChanges);
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
    const reviewFileChanges = this.reviewFileChanges(reviewOutput);
    const reviewArtifact = this.artifacts.create({
      sessionId: session.id,
      agentId: review.id,
      type: 'test_report',
      title: messages.reviewReportTitle,
      contentSummary: reviewOutput.recommendation,
      metadata: {
        ...(reviewOutput as unknown as Record<string, unknown>),
        phase: 'post_review',
        fileChanges: reviewFileChanges
      }
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
        contentSummary: reviewArtifact.contentSummary,
        fileChanges: reviewFileChanges
      })
    });
    await this.applyServerLocalArtifactChanges(session, reviewFileChanges);
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
    const deliveryFileChanges = this.finalDeliveryFileChanges(session, brief, finalOutput);
    const notificationFileChanges = this.notificationDraftFileChanges(brief, finalOutput);
    const deliveryArtifact = this.artifacts.create({
      sessionId: session.id,
      agentId: coordinator.id,
      type: 'markdown',
      title: this.isArchitectureAnalysisSession(session, brief) ? '项目架构分析交付说明' : messages.finalDeliveryTitle,
      contentSummary: finalOutput.summary,
      metadata: {
        ...(finalOutput as unknown as Record<string, unknown>),
        phase: 'final_delivery',
        fileChanges: deliveryFileChanges
      }
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
        sourceArtifactId: deliveryArtifact.id,
        fileChanges: notificationFileChanges
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
        contentSummary: deliveryArtifact.contentSummary,
        fileChanges: deliveryFileChanges
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
        relatedCapabilityId: 'cap-feishu-draft',
        fileChanges: notificationFileChanges
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_requested',
      fromAgentId: notification.id,
      content: '请确认是否发送飞书通知。',
      metadata: createMetadata('confirmation_card', {
        confirmationId: crypto.randomUUID(),
        reason: 'confirm_feishu_notification',
        title: '是否发送飞书通知',
        description: '最终交付已生成飞书通知草稿。选择发送通知会记录一次通知动作；选择不通知则仅保留草稿。',
        relatedArtifactId: notificationDraft.id,
        relatedCapabilityId: 'cap-feishu-draft',
        options: [
          { key: 'send_notification', label: '发送通知', style: 'primary' },
          { key: 'skip_notification', label: '不通知', style: 'default' }
        ]
      })
    });
    await this.applyServerLocalArtifactChanges(session, deliveryFileChanges);
    await this.applyServerLocalArtifactChanges(session, notificationFileChanges);
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
          content: messages.discussionCheckingStatus(agent.name),
          metadata: createMetadata('system_notice', {
            agentId: agent.id,
            status: 'discussing',
            thoughtSummary: messages.discussionCheckingThought,
            actionSummary: messages.discussionCheckingAction,
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
                  ? messages.discussionTimedOutMessage(agent.name)
                  : messages.discussionFailedMessage(agent.name, result.error?.message ?? result.status)
              } satisfies AgentMessageOutput);
        this.events.create({
          sessionId: session.id,
          type: 'agent_status_changed',
          fromAgentId: agent.id,
          content: timedOut
            ? messages.discussionTimedOutStatus(agent.name)
            : messages.discussionCompletedStatus(agent.name),
          metadata: createMetadata('system_notice', {
            agentId: agent.id,
            status: timedOut ? 'waiting' : 'thinking',
            thoughtSummary: timedOut ? messages.discussionTimedOutThought : messages.discussionCompletedThought,
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
      content: messages.taskPausedWaiting(task.title),
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
      title: `${task.title}执行结果`,
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

  private briefFileChanges(brief: TaskBrief, suggestedTasks: SuggestedAgentTask[]): RuntimeFileChange[] {
    return [
      {
        path: `agent-output/brief-v${brief.version}.md`,
        operation: 'create',
        encoding: 'utf-8',
        content: this.briefMarkdown(brief, suggestedTasks)
      }
    ];
  }

  private reviewFileChanges(review: PostReviewReportOutput): RuntimeFileChange[] {
    return [
      {
        path: 'agent-output/review-report.md',
        operation: 'create',
        encoding: 'utf-8',
        content: this.reviewMarkdown(review)
      }
    ];
  }

  private finalDeliveryFileChanges(session: SessionDetail, brief: TaskBrief, delivery: FinalDeliveryOutput): RuntimeFileChange[] {
    if (this.isArchitectureAnalysisSession(session, brief)) {
      const report = this.projectArchitectureAnalysisFileChange(session.id);
      return [
        {
          path: 'agent-output/final-delivery.md',
          operation: 'create',
          encoding: 'utf-8',
          content: this.architectureAnalysisDeliveryMarkdown(brief, delivery, report)
        }
      ];
    }
    return [
      {
        path: 'agent-output/final-delivery.md',
        operation: 'create',
        encoding: 'utf-8',
        content: this.finalDeliveryMarkdown(brief, delivery)
      }
    ];
  }

  private architectureAnalysisDeliveryMarkdown(
    brief: TaskBrief,
    delivery: FinalDeliveryOutput,
    report: RuntimeFileChange | undefined
  ) {
    return [
      '# 项目架构分析交付说明',
      '',
      `任务契约 ID：${brief.id}`,
      '',
      '## 摘要',
      delivery.summary,
      '',
      this.markdownList('已完成项', delivery.completedItems),
      this.markdownList('未完成项', delivery.incompleteItems),
      this.markdownList('风险', delivery.risks),
      '## 主要产物',
      '- agent-output/workspace-analysis.md',
      '- agent-output/project-architecture-analysis.md',
      '',
      report?.content
        ? ['## 项目架构分析报告正文', '', report.content].join('\n')
        : '## 项目架构分析报告正文\n\n- 未在当前会话产物中找到项目架构分析报告正文，请检查任务执行阶段是否成功生成 agent-output/project-architecture-analysis.md。'
    ].join('\n');
  }

  private notificationDraftFileChanges(brief: TaskBrief, delivery: FinalDeliveryOutput): RuntimeFileChange[] {
    return [
      {
        path: 'agent-output/notification-draft.md',
        operation: 'create',
        encoding: 'utf-8',
        content: this.notificationDraftMarkdown(brief, delivery)
      }
    ];
  }

  private workspaceAnalysisFileChanges(markdown: string): RuntimeFileChange[] {
    return [
      {
        path: 'agent-output/workspace-analysis.md',
        operation: 'create',
        encoding: 'utf-8',
        content: markdown
      }
    ];
  }

  private workspaceAnalysis(
    session: SessionDetail,
    snapshot: WorkspaceSnapshot,
    focus:
      | {
          relevantFiles: string[];
          possibleEntryPoints: string[];
          detectedStack: string[];
          rationale: string;
        }
      | undefined
  ) {
    const readableFiles = snapshot.files;
    const entrypoints = snapshot.entrypoints ?? [];
    const detectedStack = snapshot.detectedStack ?? [];
    const relevantFiles = focus?.relevantFiles ?? [];
    const skippedByReason = snapshot.skipped.reduce<Record<string, number>>((acc, item) => {
      acc[item.reason] = (acc[item.reason] ?? 0) + 1;
      return acc;
    }, {});
    const topDirectories = this.workspaceTopDirectories(snapshot);
    const importantFiles = this.workspaceImportantFiles(snapshot, relevantFiles, entrypoints);
    const impactedFiles = this.workspaceImpactedFiles(snapshot, relevantFiles, entrypoints);
    const modificationPlan = impactedFiles.map((path) => this.workspaceModificationPlanItem(path, session.originalInput));
    const summary = `已分析 ${snapshot.rootName}：扫描 ${snapshot.fileCount} 个条目，识别 ${readableFiles.length} 个可读文本文件。`;
    const payload = {
      rootName: snapshot.rootName,
      fileCount: snapshot.fileCount,
      readableFileCount: readableFiles.length,
      skippedFileCount: snapshot.skipped.length,
      totalBytes: snapshot.totalBytes,
      detectedStack,
      entrypoints,
      relevantFiles,
      topDirectories,
      importantFiles,
      impactedFiles,
      modificationPlan,
      skippedByReason,
      rationale: focus?.rationale ?? '基于工作区快照、入口文件和用户需求关键词完成初步架构分析，并形成多文件影响面。'
    };
    const markdown = [
      '# 工作区架构分析',
      '',
      `会话需求：${session.originalInput}`,
      `工作区：${snapshot.rootName}`,
      `扫描时间：${snapshot.scannedAt}`,
      '',
      '## 分析结论',
      summary,
      detectedStack.length ? `识别技术栈：${detectedStack.join('、')}` : '暂未识别出明确技术栈。',
      entrypoints.length ? `入口文件：${entrypoints.join('、')}` : '暂未识别出明确入口文件。',
      '',
      this.markdownList('目录结构重点', topDirectories),
      this.markdownList('重点文件', importantFiles),
      this.markdownList('与需求相关的文件', relevantFiles),
      this.markdownList('预计影响文件', impactedFiles),
      this.markdownList('多文件修改计划', modificationPlan),
      '## 扫描统计',
      `- 扫描条目：${snapshot.fileCount}`,
      `- 可读文本文件：${readableFiles.length}`,
      `- 跳过条目：${snapshot.skipped.length}`,
      `- 总字节数：${snapshot.totalBytes}`,
      '',
      '## 跳过原因',
      ...(
        Object.keys(skippedByReason).length
          ? Object.entries(skippedByReason).map(([reason, count]) => `- ${reason}：${count}`)
          : ['- 无']
      ),
      '',
      '## 判断依据',
      payload.rationale,
      ''
    ].join('\n');

    return {
      summary,
      payload,
      markdown,
      chatContent: (agentName: string) =>
        [
          `${agentName} 已完成会话工作区架构分析，并生成阶段产物。`,
          `工作区：${snapshot.rootName}`,
          `扫描条目：${snapshot.fileCount}，可读文本文件：${readableFiles.length}，跳过：${snapshot.skipped.length}`,
          `技术栈：${detectedStack.join('、') || '未识别'}`,
          `预计影响文件：${impactedFiles.slice(0, 6).join('、') || '暂无'}`,
          `产物文件：agent-output/workspace-analysis.md`
        ].join('\n')
    };
  }

  private workspaceTopDirectories(snapshot: WorkspaceSnapshot) {
    const counts = new Map<string, number>();
    for (const node of snapshot.tree) {
      const top = node.path.split('/')[0];
      if (!top || top === node.path) continue;
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([directory, count]) => `${directory}/（${count} 个条目）`);
  }

  private workspaceImportantFiles(snapshot: WorkspaceSnapshot, relevantFiles: string[], entrypoints: string[]) {
    const preferred = new Set([...relevantFiles, ...entrypoints]);
    for (const file of snapshot.files) {
      const name = file.path.toLowerCase().split('/').at(-1) ?? file.path.toLowerCase();
      if (['agents.md', 'claude.md', 'readme.md', 'package.json', 'tsconfig.json', 'vite.config.ts'].includes(name)) {
        preferred.add(file.path);
      }
    }
    return [...preferred].slice(0, 12);
  }

  private workspaceImpactedFiles(snapshot: WorkspaceSnapshot, relevantFiles: string[], entrypoints: string[]) {
    const source = relevantFiles.length ? relevantFiles : entrypoints.length ? entrypoints : snapshot.files.map((file) => file.path);
    const snapshotPaths = new Set(snapshot.files.map((file) => file.path));
    return [...new Set(source)]
      .filter((path) => snapshotPaths.has(path))
      .filter((path) => !path.startsWith('agent-output/'))
      .slice(0, 12);
  }

  private workspaceModificationPlanItem(path: string, requirement: string) {
    const fileName = path.split('/').at(-1) ?? path;
    const lower = fileName.toLowerCase();
    const action =
      lower.endsWith('.css') || lower.endsWith('.scss')
        ? '调整样式或布局相关实现'
        : lower.endsWith('.vue') || lower.endsWith('.tsx') || lower.endsWith('.jsx')
          ? '调整页面组件、状态展示或交互逻辑'
          : lower.endsWith('.ts') || lower.endsWith('.js')
            ? '调整业务逻辑、类型或运行时处理'
            : lower.endsWith('.md')
              ? '同步更新文档和阶段说明'
              : '按需求补充或更新文件内容';
    return `${path}：${action}，确保与需求“${this.shortRequirement(requirement)}”一致。`;
  }

  private shortRequirement(requirement: string) {
    const trimmed = requirement.trim().replace(/\s+/g, ' ');
    return trimmed.length > 48 ? `${trimmed.slice(0, 45)}...` : trimmed;
  }

  private briefMarkdown(brief: TaskBrief, suggestedTasks: SuggestedAgentTask[]) {
    return [
      `# 任务契约 v${brief.version}`,
      '',
      `任务契约 ID：${brief.id}`,
      '',
      '## 目标',
      brief.goal,
      '',
      this.markdownList('范围', brief.scope),
      this.markdownList('不做范围', brief.outOfScope),
      this.markdownList('约束', brief.constraints),
      this.markdownList('验收标准', brief.acceptanceCriteria),
      this.markdownList('风险', brief.risks),
      this.markdownList('待确认问题', brief.openQuestions),
      '## 建议任务',
      ...(suggestedTasks.length
        ? suggestedTasks.flatMap((task, index) => [
            `${index + 1}. ${task.title}`,
            `   - 描述：${task.description}`,
            `   - 建议 Agent：${task.suggestedAgentKey ?? '未分配'}`,
            `   - 验收：${task.acceptanceCriteria.join('；') || '无'}`
          ])
        : ['- 暂无建议任务。']),
      ''
    ].join('\n');
  }

  private reviewMarkdown(review: PostReviewReportOutput) {
    return [
      '# 复盘检查报告',
      '',
      `复盘建议：${this.reviewRecommendationLabel(review.recommendation)}`,
      `是否符合任务契约：${review.isConsistentWithBrief ? '是' : '否'}`,
      '',
      this.markdownList('匹配项', review.matchedItems),
      this.markdownList('不匹配项', review.mismatchedItems),
      this.markdownList('缺失项', review.missingItems),
      this.markdownList('超出范围的变更', review.outOfScopeChanges),
      this.markdownList('测试结果', review.testResults)
    ].join('\n');
  }

  private finalDeliveryMarkdown(brief: TaskBrief, delivery: FinalDeliveryOutput) {
    return [
      '# 最终交付摘要',
      '',
      `任务契约 ID：${brief.id}`,
      '',
      '## 摘要',
      delivery.summary,
      '',
      this.markdownList('已完成项', delivery.completedItems),
      this.markdownList('未完成项', delivery.incompleteItems),
      this.markdownList('风险', delivery.risks),
      this.markdownList('产物引用', delivery.artifactRefs)
    ].join('\n');
  }

  private notificationDraftMarkdown(brief: TaskBrief, delivery: FinalDeliveryOutput) {
    return [
      '# 飞书通知草稿',
      '',
      `目标：${brief.goal}`,
      '',
      '## 摘要',
      delivery.summary,
      '',
      this.markdownList('已完成项', delivery.completedItems),
      this.markdownList('风险', delivery.risks)
    ].join('\n');
  }

  private markdownList(title: string, values: string[]) {
    return [`## ${title}`, ...(values.length ? values.map((value) => `- ${value}`) : ['- 无']), ''].join('\n');
  }

  private reviewRecommendationLabel(recommendation: PostReviewReportOutput['recommendation']) {
    return (
      {
        deliver: '可以交付',
        rework: '需要返工',
        ask_user: '需要询问用户'
      }[recommendation] ?? recommendation
    );
  }

  private fileChangesForArtifact(metadata: Record<string, unknown>) {
    const fileChanges = metadata.fileChanges;
    return Array.isArray(fileChanges) ? fileChanges : [];
  }

  private projectArchitectureAnalysisFileChange(sessionId: string) {
    for (const artifact of this.artifacts.listBySession(sessionId)) {
      const fileChanges = this.fileChangesForArtifact(artifact.metadata);
      const report = fileChanges.find((change) => change.path === 'agent-output/project-architecture-analysis.md');
      if (report) return report;
    }
    return undefined;
  }

  private isArchitectureAnalysisSession(session: SessionDetail, brief?: TaskBrief) {
    return /架构|结构|目录|熟悉|分析项目|项目分析|了解项目/i.test(`${session.originalInput}\n${brief?.goal ?? ''}`);
  }

  private async applyServerLocalArtifactChanges(session: SessionDetail, fileChanges: RuntimeFileChange[]) {
    if (session.workingDirectory?.kind !== 'server_local' || !session.workingDirectory.path || !fileChanges.length) {
      return;
    }
    try {
      await applyServerLocalFileChanges(session.workingDirectory.path, fileChanges);
    } catch (error) {
      this.events.create({
        sessionId: session.id,
        type: 'error_reported',
        priority: 'high',
        content: `写入本地项目资料失败：${error instanceof Error ? error.message : String(error)}`,
        metadata: createMetadata('error_card', {
          phase: 'artifact_file_write',
          message: error instanceof Error ? error.message : String(error)
        })
      });
    }
  }

  private createContextPack(session: SessionDetail, agent: Agent, brief?: TaskBrief, task?: AgentTask): ContextPack {
    const ragSnippets = task ? this.searchAgentKnowledge(session, agent, task.title) : [];
    const relevantMemories = this.memories
      .search(session.id, [session.originalInput, brief?.goal, task?.title, task?.description].filter(Boolean).join(' '), agent.id)
      .map((memory) => this.memories.toRuntimeMemory(memory));
    return {
      systemRules: [
        'Return structured JSON matching the expected RuntimeOutput kind.',
        'Do not perform external side effects unless explicitly allowed by capability policy.',
        'Analyze workspaceSnapshot before analyzing the user requirement when workspaceSnapshot is present.',
        'Use existing workspace paths from workspaceSnapshot when proposing or applying file changes.'
      ],
      sessionGoal: session.originalInput,
      workingDirectory: session.workingDirectory,
      workspaceSnapshot: session.workspaceSnapshot,
      workspaceFocus: this.workspaceFocus(session),
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

  private workspaceFocus(session: SessionDetail) {
    const snapshot = session.workspaceSnapshot;
    if (!snapshot) return undefined;
    const relevantFiles = snapshot.files
      .map((file) => ({
        path: file.path,
        score: this.workspaceFileRelevanceScore(file.path, session.originalInput)
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .map((item) => item.path)
      .slice(0, 12);
    const fallbackFiles = snapshot.files.map((file) => file.path).slice(0, 8);
    return {
      relevantFiles: relevantFiles.length ? relevantFiles : fallbackFiles,
      possibleEntryPoints: snapshot.entrypoints ?? [],
      detectedStack: snapshot.detectedStack ?? [],
      rationale: relevantFiles.length
        ? 'Matched workspace file paths against user requirement keywords and project entrypoints.'
        : 'No strong keyword match was found, so the first readable workspace files are used as context.'
    };
  }

  private isLikelyRelevantWorkspaceFile(path: string, requirement: string) {
    return this.workspaceFileRelevanceScore(path, requirement) > 0;
  }

  private workspaceFileRelevanceScore(path: string, requirement: string) {
    const lowerPath = path.toLowerCase();
    const lowerRequirement = requirement.toLowerCase();
    const fileName = lowerPath.split('/').at(-1) ?? lowerPath;
    let score = 0;
    if (lowerRequirement.includes(fileName)) score += 80;
    for (const token of lowerRequirement.split(/[^a-z0-9_\-.]+/i).filter((item) => item.length >= 4)) {
      if (lowerPath.includes(token)) score += 10;
    }
    if (lowerPath.startsWith('src/') || lowerPath.startsWith('apps/') || lowerPath.startsWith('packages/')) score += 5;
    if (['agents.md', 'claude.md', 'readme.md', 'package.json'].includes(fileName)) score += 2;
    return score;
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
        content: messages.tokenBudgetExceeded(fitted.estimatedTokens, maxInputTokens),
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
        content: messages.tokenContextTrimmed,
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
        content: messages.tokenBudgetInsufficient
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
      throw new Error(messages.noAvailableAgent);
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
