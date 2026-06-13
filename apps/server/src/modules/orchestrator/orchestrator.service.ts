import { Injectable } from '@nestjs/common';
import type {
  Agent,
  AgentMessageOutput,
  AgentRunPhase,
  AgentRunInput,
  AgentRunResult,
  AgentTask,
  ContextPack,
  SummaryMemory,
  SummaryMemoryCheckpoint,
  TaskContext,
  FinalDeliveryOutput,
  PostReviewReportOutput,
  RuntimeArtifactOutput,
  RuntimeContextRequest,
  RuntimeError,
  RuntimeFileChange,
  SessionDetail,
  SuggestedAgentTask,
  TaskBrief,
  TaskBriefOutput,
  TaskClaimDecisionOutput,
  TaskExecutionResultOutput,
  ValidationEvidenceReport,
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
import { CapabilityAuditService } from '../capabilities/capability-audit.service.js';
import { EventsService } from '../events/events.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { KnowledgeService } from '../rag/knowledge.service.js';
import { RuntimeService } from '../runtimes/runtime.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { ContextRouterService } from './context-router.service.js';
import { ProjectMapService } from './project-map.service.js';

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
    private readonly capabilityAudit: CapabilityAuditService,
    private readonly persistence: PersistenceService,
    private readonly contextRouter: ContextRouterService,
    private readonly projectMap: ProjectMapService
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
      contextPack: this.createContextPack(session, coordinator, undefined, undefined, 'brief_generation'),
      expectedOutput: { kind: 'task_brief', schemaVersion: '0.1' },
      budget: buildBudget(session)
    });
    const output = this.normalizeTaskBriefOutput(this.completedOutput<TaskBriefOutput>(result, 'task_brief'));
    const suggestedTasks = this.selectSuggestedTasks(session, output.suggestedTasks);

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

    this.createSummaryMemoryCheckpoint(session, coordinator, 'brief_generation', brief);

    return brief;
  }

  private async emitWorkspaceAnalyzedEvent(session: SessionDetail, coordinator: Agent) {
    const snapshot = session.workspaceSnapshot;
    if (!snapshot) return;
    const focus = this.projectMap.workspaceFocus(session);
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
    const suggestions = this.suggestedTasksByBriefId.get(brief.id) ?? this.defaultSuggestedTasks(session);
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

      const readyTasks = remaining.filter((task) => this.isTaskReady(task, executableTasks));
      if (!readyTasks.length) {
        return {
          kind: 'ask_user',
          reason: messages.dependencyBlocked
        };
      }

      const taskResults = await Promise.all(
        readyTasks.map(async (task) => ({
          task,
          result: await this.runOneTask(session, brief, task, signal)
        }))
      );
      if (signal?.aborted) {
        return { kind: 'cancelled', reason: messages.cancelled };
      }
      const failedTask = taskResults.find((item) => !item.result.ok);
      if (failedTask && !failedTask.result.ok) {
        return { kind: 'ask_user', reason: `${messages.taskFailed(failedTask.task.title)}: ${failedTask.result.message}` };
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
    signal?: AbortSignal,
    attemptedAgentIds = new Set<string>(),
    contextRetryCount = 0
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const backend = this.pickSessionAgent(session, ['backend'], 0);
    const coordinator = this.pickSessionAgent(session, ['coordinator'], 0);
    const taskAgent = task.assigneeAgentId ? this.agents.getByIdOrKey(task.assigneeAgentId) : backend;
    const runtimePreflight = this.preflightCodingRuntimeSourceWrite(session, task, taskAgent);
    if (!runtimePreflight.allowed) {
      this.tasks.update(task, { status: 'waiting', resultSummary: runtimePreflight.message });
      this.events.create({
        sessionId: session.id,
        type: 'task_waiting',
        taskId: task.id,
        fromAgentId: taskAgent.id,
        content: runtimePreflight.message,
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          status: 'waiting',
          resultSummary: runtimePreflight.message,
          relatedCapabilityId: 'cap-file-write',
          requiresUserConfirmation: true
        })
      });
      return { ok: false, message: runtimePreflight.message };
    }
    const claim = await this.resolveTaskClaim(session, brief, task, taskAgent, coordinator, signal, attemptedAgentIds);
    if (!claim.ok) {
      return { ok: false, message: claim.message };
    }
    if (claim.agent.id !== taskAgent.id) {
      return this.runOneTask(session, brief, task, signal, attemptedAgentIds, contextRetryCount);
    }
    this.tasks.update(task, { status: 'claimed' });
    this.events.create({
      sessionId: session.id,
      type: 'task_claimed',
      taskId: task.id,
      fromAgentId: taskAgent.id,
      toAgentIds: [coordinator.id],
      content: `${taskAgent.name} 已接受任务：${task.title}`,
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'claimed',
        assigneeAgentId: taskAgent.id,
        dependsOnTaskIds: task.dependsOnTaskIds,
        acceptanceCriteria: task.acceptanceCriteria
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      taskId: task.id,
      fromAgentId: taskAgent.id,
      toAgentIds: [coordinator.id],
      content: claim.decision.reason,
      metadata: createMetadata('chat_message', {
        messageKind: 'decision',
        phase: 'task_acceptance',
        relatedTaskIds: [task.id],
        mentionedAgentIds: [coordinator.id],
        claimDecision: claim.decision,
        runtimeInvocationId: claim.runId
      })
    });
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

    const contextPack = this.createContextPack(session, taskAgent, brief, task, 'task_execution');
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
      const requestedContext = result.error?.requestedContext;
      const code = result.error?.code;
      this.markTaskFailed(
        session.id,
        task,
        taskAgent.id,
        runId,
        message,
        taskAgent.runtimeType,
        code,
        requestedContext
      );
      if (this.canRetryWithSupplementalContext(code, requestedContext, contextRetryCount)) {
        this.recordSupplementalContextRequest(session, task, taskAgent.id, requestedContext);
        this.tasks.update(task, { status: 'pending', resultSummary: `Retrying with supplemental context: ${message}` });
        return this.runOneTask(session, brief, task, signal, new Set<string>(), contextRetryCount + 1);
      }
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
      const code = output.requestedContext ? 'CONTEXT_INSUFFICIENT' : 'MODEL_ERROR';
      this.markTaskFailed(
        session.id,
        task,
        taskAgent.id,
        runId,
        output.summary,
        taskAgent.runtimeType,
        code,
        output.requestedContext
      );
      if (this.canRetryWithSupplementalContext(code, output.requestedContext, contextRetryCount)) {
        this.recordSupplementalContextRequest(session, task, taskAgent.id, output.requestedContext);
        this.tasks.update(task, { status: 'pending', resultSummary: `Retrying with supplemental context: ${output.summary}` });
        return this.runOneTask(session, brief, task, signal, new Set<string>(), contextRetryCount + 1);
      }
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
        runtimeArtifacts: executionArtifact.metadata.runtimeArtifacts,
        fileChanges
      })
    });
    this.emitRuntimeAgentMessages(session, task, taskAgent, output.agentMessages ?? [], runId);
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
    this.emitTaskHandoff(session, task, taskAgent, output.summary);
    this.createSummaryMemoryCheckpoint(session, taskAgent, 'task_execution', brief, task);
    await this.applyServerLocalArtifactChanges(session, fileChanges, {
      allowSourceFileChanges: this.canApplySourceFileChanges(taskAgent)
    });
    return { ok: true };
  }

  private async resolveTaskClaim(
    session: SessionDetail,
    brief: TaskBrief,
    task: AgentTask,
    candidate: Agent,
    coordinator: Agent,
    signal: AbortSignal | undefined,
    attemptedAgentIds: Set<string>
  ): Promise<
    | { ok: true; agent: Agent; decision: TaskClaimDecisionOutput; runId: string }
    | { ok: false; message: string }
  > {
    if (attemptedAgentIds.has(candidate.id)) {
      return { ok: true, agent: candidate, decision: this.fallbackClaimDecision(candidate, task), runId: crypto.randomUUID() };
    }
    attemptedAgentIds.add(candidate.id);
    const runId = crypto.randomUUID();
    const contextPack = this.createContextPack(session, candidate, brief, task, 'task_acceptance');
    const result = await this.runRuntime(
      session,
      {
        runId,
        sessionId: session.id,
        taskId: task.id,
        phase: 'task_acceptance',
        agent: this.toRuntimeAgent(candidate),
        contextPack,
        expectedOutput: { kind: 'task_claim_decision', schemaVersion: '0.1' },
        budget: contextPack.budget
      },
      signal
    );
    if (signal?.aborted) {
      return { ok: false, message: messages.cancelled };
    }
    const decision =
      result.status === 'completed' && (result.output as { kind?: string }).kind === 'task_claim_decision'
        ? (result.output as TaskClaimDecisionOutput)
        : this.fallbackClaimDecision(candidate, task, result.error?.message ?? result.status);

    this.emitTaskClaimDecisionEvent(session, task, candidate, coordinator, decision, runId);
    this.emitRuntimeAgentMessages(session, task, candidate, decision.agentMessages ?? [], runId);

    if (decision.accepted) {
      return { ok: true, agent: candidate, decision, runId };
    }

    const alternative = this.findAlternativeClaimAgent(session, decision, attemptedAgentIds);
    if (!alternative) {
      this.tasks.update(task, { status: 'waiting', resultSummary: decision.reason });
      this.events.create({
        sessionId: session.id,
        type: 'task_waiting',
        taskId: task.id,
        fromAgentId: candidate.id,
        toAgentIds: [coordinator.id],
        content: `任务等待重新分配：${task.title}`,
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          status: 'waiting',
          assigneeAgentId: candidate.id,
          resultSummary: decision.reason
        })
      });
      return { ok: false, message: decision.reason };
    }

    this.tasks.update(task, {
      status: 'pending',
      assigneeAgentId: alternative.id,
      resultSummary: `${candidate.name} declined; reassigned to ${alternative.name}. ${decision.reason}`
    });
    this.events.create({
      sessionId: session.id,
      type: 'task_waiting',
      taskId: task.id,
      fromAgentId: candidate.id,
      toAgentIds: [alternative.id, coordinator.id],
      content: `任务转派：${task.title} -> ${alternative.name}`,
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'pending',
        assigneeAgentId: alternative.id,
        previousAssigneeAgentId: candidate.id,
        resultSummary: decision.reason
      })
    });
    return { ok: true, agent: alternative, decision, runId };
  }

  private emitTaskClaimDecisionEvent(
    session: SessionDetail,
    task: AgentTask,
    candidate: Agent,
    coordinator: Agent,
    decision: TaskClaimDecisionOutput,
    runId: string
  ) {
    const alternativeAgentIds = this.claimDecisionAlternativeIds(session, decision);
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      taskId: task.id,
      fromAgentId: candidate.id,
      toAgentIds: Array.from(new Set([coordinator.id, ...alternativeAgentIds])),
      content: decision.reason,
      metadata: createMetadata('chat_message', {
        messageKind: decision.accepted ? 'decision' : 'handoff',
        phase: decision.accepted ? 'task_claim_decision' : 'task_claim_declined',
        relatedTaskIds: [task.id],
        mentionedAgentIds: alternativeAgentIds.length ? alternativeAgentIds : [coordinator.id],
        claimDecision: decision,
        runtimeInvocationId: runId
      })
    });
  }

  private fallbackClaimDecision(candidate: Agent, task: AgentTask, fallbackReason?: string): TaskClaimDecisionOutput {
    return {
      kind: 'task_claim_decision',
      accepted: true,
      reason:
        fallbackReason && fallbackReason !== 'completed'
          ? `${candidate.name} accepts "${task.title}" by fallback because claim decision failed: ${fallbackReason}`
          : `${candidate.name} accepts "${task.title}".`,
      confidence: 0.5
    };
  }

  private findAlternativeClaimAgent(
    session: SessionDetail,
    decision: TaskClaimDecisionOutput,
    attemptedAgentIds: Set<string>
  ) {
    const participants = this.participatingAgents(session);
    const hints = [...(decision.alternativeAgentIds ?? []), ...(decision.alternativeAgentKeys ?? [])];
    for (const hint of hints) {
      const agent = participants.find((candidate) => candidate.id === hint || candidate.key === hint);
      if (agent && !attemptedAgentIds.has(agent.id)) {
        return agent;
      }
    }
    return undefined;
  }

  private claimDecisionAlternativeIds(session: SessionDetail, decision: TaskClaimDecisionOutput) {
    const participants = this.participatingAgents(session);
    return [...(decision.alternativeAgentIds ?? []), ...(decision.alternativeAgentKeys ?? [])]
      .map((hint) => participants.find((agent) => agent.id === hint || agent.key === hint)?.id)
      .filter((agentId): agentId is string => Boolean(agentId));
  }

  private emitRuntimeAgentMessages(
    session: SessionDetail,
    task: AgentTask,
    fromAgent: Agent,
    messages: AgentMessageOutput[],
    runtimeInvocationId: string
  ) {
    for (const message of messages) {
      const toAgentIds = this.resolveRuntimeMessageTargetAgentIds(session, fromAgent, message);
      if (!toAgentIds.length) {
        continue;
      }
      this.events.create({
        sessionId: session.id,
        type: 'agent_message',
        taskId: task.id,
        fromAgentId: fromAgent.id,
        toAgentIds,
        content: message.content,
        metadata: createMetadata('chat_message', {
          messageKind: message.messageKind,
          phase: 'agent_runtime_communication',
          relatedTaskIds: Array.from(new Set([task.id, ...(message.relatedTaskIds ?? [])])),
          mentionedAgentIds: toAgentIds,
          runtimeInvocationId
        })
      });
    }
  }

  private resolveRuntimeMessageTargetAgentIds(session: SessionDetail, fromAgent: Agent, message: AgentMessageOutput) {
    const participants = this.participatingAgents(session);
    const targetHints = [...(message.targetAgentIds ?? []), ...(message.mentionedAgentIds ?? [])];
    for (const key of message.targetAgentKeys ?? []) {
      targetHints.push(key);
    }
    const resolved = targetHints
      .map((target) => {
        const participant = participants.find((agent) => agent.id === target || agent.key === target);
        return participant?.id;
      })
      .filter((agentId): agentId is string => Boolean(agentId) && agentId !== fromAgent.id);
    return Array.from(new Set(resolved));
  }

  private emitTaskHandoff(
    session: SessionDetail,
    completedTask: AgentTask,
    completedBy: Agent,
    resultSummary: string
  ) {
    const downstreamAgentIds = this.tasks
      .list(session.id)
      .filter((task) => task.dependsOnTaskIds.includes(completedTask.id) && !this.isTerminalTask(task))
      .map((task) => task.assigneeAgentId)
      .filter((agentId): agentId is string => Boolean(agentId));
    const coordinator = this.pickSessionAgent(session, ['coordinator'], 0);
    const toAgentIds = Array.from(new Set(downstreamAgentIds.length ? downstreamAgentIds : [coordinator.id]));
    const targetNames = toAgentIds
      .map((agentId) => this.agents.findByIdOrKey(agentId)?.name)
      .filter(Boolean)
      .join('、');
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      taskId: completedTask.id,
      fromAgentId: completedBy.id,
      toAgentIds,
      content: `${completedBy.name}：任务「${completedTask.title}」已完成，交接给 ${targetNames || 'Coordinator'}。摘要：${resultSummary}`,
      metadata: createMetadata('chat_message', {
        messageKind: 'handoff',
        phase: 'task_handoff',
        relatedTaskIds: [completedTask.id],
        mentionedAgentIds: toAgentIds,
        resultSummary
      })
    });
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

    const reviewContextPack = this.createContextPack(session, review, brief, undefined, 'post_review');
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
    this.createSummaryMemoryCheckpoint(session, review, 'post_review', brief);
    return reviewOutput;
  }

  private async runFinalDelivery(session: SessionDetail, brief: TaskBrief, signal?: AbortSignal): Promise<void> {
    const review = this.pickSessionAgent(session, ['review', 'test'], 1);
    const coordinator = this.pickSessionAgent(session, ['coordinator'], 0);
    const finalContextPack = this.createContextPack(session, coordinator, brief, undefined, 'final_delivery');
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
    this.createSummaryMemoryCheckpoint(session, coordinator, 'final_delivery', brief);
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
        const contextPack = this.createContextPack(session, agent, undefined, undefined, 'discussion');
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
    code: RuntimeError['code'] = 'MODEL_ERROR',
    requestedContext?: RuntimeContextRequest
  ) {
    const needsMoreContext = code === 'CONTEXT_INSUFFICIENT';
    const taskStatus: AgentTask['status'] = needsMoreContext ? 'waiting' : 'failed';
    this.tasks.update(task, { status: taskStatus, resultSummary: message });
    this.events.create({
      sessionId,
      type: 'runtime_failed',
      taskId: task.id,
      fromAgentId: agentId,
      content: needsMoreContext ? `Runtime requested more context for task: ${task.title}` : messages.runtimeFailed(task.title),
      metadata: createMetadata('error_card', {
        runtimeInvocationId: runId,
        runtimeType,
        status: needsMoreContext ? 'blocked' : 'failed',
        code,
        message,
        requestedContext
      })
    });
    this.events.create({
      sessionId,
      type: needsMoreContext ? 'task_waiting' : 'task_rejected',
      taskId: task.id,
      fromAgentId: agentId,
      content: needsMoreContext ? `Task is waiting for more context: ${task.title}` : messages.taskFailed(task.title),
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: taskStatus,
        resultSummary: message,
        requestedContext
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

  private preflightCodingRuntimeSourceWrite(session: SessionDetail, task: AgentTask, agent: Agent) {
    if (!['codex', 'claude_code'].includes(agent.runtimeType)) {
      return { allowed: true, message: '' };
    }
    if (!agent.capabilityIds.includes('cap-file-write')) {
      return {
        allowed: false,
        message: `${agent.name} cannot start ${agent.runtimeType} for "${task.title}" because cap-file-write is not assigned.`
      };
    }
    const input = {
      sessionId: session.id,
      agentId: agent.id,
      reason: `Start ${agent.runtimeType} for task "${task.title}" with permission to edit files inside the selected server_local workspace.`
    };
    const result = this.capabilities.checkInvocation('cap-file-write', input);
    this.capabilityAudit.recordCheck(input, result);
    if (!result.allowed) {
      return {
        allowed: false,
        message: `${agent.name} is waiting for file-write approval before starting ${agent.runtimeType} for "${task.title}".`
      };
    }
    return { allowed: true, message: '' };
  }

  private canRetryWithSupplementalContext(
    code: RuntimeError['code'] | undefined,
    requestedContext: RuntimeContextRequest | undefined,
    contextRetryCount: number
  ) {
    return code === 'CONTEXT_INSUFFICIENT' && Boolean(requestedContext) && contextRetryCount < 1;
  }

  private recordSupplementalContextRequest(
    session: SessionDetail,
    task: AgentTask,
    agentId: string,
    requestedContext: RuntimeContextRequest | undefined
  ) {
    if (!requestedContext) return;
    const requestedRefs = requestedContext.requestedRefs
      .map((ref) => `${ref.type}:${ref.ref ?? ref.label}`)
      .filter(Boolean)
      .join(', ');
    const requestedPaths = requestedContext.requestedPaths?.join(', ') || 'none';
    const requestedCommands = requestedContext.requestedCommands?.join(', ') || 'none';
    const content = [
      `Supplemental context request for task "${task.title}".`,
      `Reason: ${requestedContext.reason}`,
      `Requested refs: ${requestedRefs || 'none'}`,
      `Requested paths: ${requestedPaths}`,
      `Requested commands: ${requestedCommands}`,
      requestedContext.followUpInstruction ? `Follow-up: ${requestedContext.followUpInstruction}` : ''
    ]
      .filter(Boolean)
      .join('\n');
    const memory = this.memories.create({
      sessionId: session.id,
      agentId,
      scope: 'session',
      content,
      confidence: 0.92
    });
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      taskId: task.id,
      fromAgentId: agentId,
      content: `Supplemental context request recorded for retry: ${requestedContext.reason}`,
      metadata: createMetadata('chat_message', {
        messageKind: 'progress',
        phase: 'context_supplement',
        relatedTaskIds: [task.id],
        memoryId: memory.id,
        requestedContext
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
    const allRuntimeArtifacts = [...output.changedArtifacts, ...runtimeArtifacts];
    const fileChanges = this.fileChangesFromRuntimeArtifacts(allRuntimeArtifacts);
    const validationEvidence = this.validationEvidenceFromRuntimeArtifacts(allRuntimeArtifacts);
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
        fileChanges,
        ...(validationEvidence ? { validationEvidence } : {})
      }
    });
  }

  private validationEvidenceFromRuntimeArtifacts(artifacts: RuntimeArtifactOutput[]): ValidationEvidenceReport | undefined {
    for (const artifact of artifacts) {
      const validationEvidence = artifact.metadata?.validationEvidence;
      if (validationEvidence) {
        return validationEvidence;
      }
    }
    return undefined;
  }

  private fileChangesFromRuntimeArtifacts(artifacts: RuntimeArtifactOutput[]) {
    const seen = new Set<string>();
    return artifacts.flatMap((artifact) => artifact.metadata?.fileChanges ?? []).filter((change) => {
      const key = [
        change.path,
        change.operation,
        change.source ?? '',
        change.content ?? ''
      ].join('\u0000');
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
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

  private async applyServerLocalArtifactChanges(
    session: SessionDetail,
    fileChanges: RuntimeFileChange[],
    options: { allowSourceFileChanges?: boolean } = {}
  ) {
    if (session.workingDirectory?.kind !== 'server_local' || !session.workingDirectory.path || !fileChanges.length) {
      return;
    }
    const applicableFileChanges = fileChanges.filter(
      (change) =>
        this.isStageArtifactFileChange(change) ||
        (options.allowSourceFileChanges && this.isTrustedActualSourceFileChange(change))
    );
    if (!applicableFileChanges.length) {
      return;
    }
    try {
      await applyServerLocalFileChanges(session.workingDirectory.path, applicableFileChanges);
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

  private canApplySourceFileChanges(agent: Agent) {
    return agent.capabilityIds.includes('cap-file-write') && ['claude_code', 'codex'].includes(agent.runtimeType);
  }

  private isStageArtifactFileChange(change: RuntimeFileChange) {
    const normalizedPath = change.path.replace(/\\/g, '/').replace(/^\.\//, '');
    return normalizedPath.startsWith('agent-output/');
  }

  private isTrustedActualSourceFileChange(change: RuntimeFileChange) {
    return !this.isStageArtifactFileChange(change) && change.source === 'actual_filesystem_snapshot';
  }

  private createContextPack(
    session: SessionDetail,
    agent: Agent,
    brief?: TaskBrief,
    task?: AgentTask,
    phase: AgentRunPhase = 'discussion'
  ): ContextPack {
    const ragSnippets = task ? this.searchAgentKnowledge(session, agent, task.title) : [];
    const relevantMemories = this.memories
      .search(session.id, [session.originalInput, brief?.goal, task?.title, task?.description].filter(Boolean).join(' '), agent.id)
      .map((memory) => this.memories.toRuntimeMemory(memory));
    const workspaceFocus = this.projectMap.workspaceFocus(session);
    const projectMap = this.projectMap.buildProjectMap(session, workspaceFocus);
    const taskContext = this.contextRouter.route({
      session,
      brief,
      task,
      phase,
      projectMap,
      workspaceFocus,
      relevantMemories,
      ragSnippets,
      artifacts: this.artifacts.listBySession(session.id),
      events: this.events.list(session.id),
      participatingAgentKeys: this.participatingAgents(session).map((item) => item.key)
    });
    const summaryMemory = this.createSummaryMemory(session, brief, task, phase);
    return {
      systemRules: [
        'Return structured JSON matching the expected RuntimeOutput kind.',
        'Do not perform external side effects unless explicitly allowed by capability policy.',
        'Analyze workspaceSnapshot before analyzing the user requirement when workspaceSnapshot is present.',
        'Use existing workspace paths from workspaceSnapshot when proposing or applying file changes.'
      ],
      sessionGoal: session.originalInput,
      taskContext,
      summaryMemory,
      continuationState: this.createContinuationState(session, agent, task, phase, taskContext, summaryMemory),
      workingDirectory: session.workingDirectory,
      workspaceSnapshot: session.workspaceSnapshot,
      projectMap,
      workspaceFocus,
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

  private createTaskContext(
    session: SessionDetail,
    brief: TaskBrief | undefined,
    task: AgentTask | undefined,
    phase: AgentRunPhase,
    relevantMemories: ContextPack['relevantMemories'],
    ragSnippets: ContextPack['ragSnippets']
  ): TaskContext {
    const domain = session.taskDomain ?? (session.workspaceSnapshot ? 'mixed' : 'non_coding');
    const intent = session.taskIntent ?? (brief ? 'implementation' : 'analysis');
    const artifacts = this.artifacts.listBySession(session.id);
    const sessionEvents = this.events.list(session.id);
    const recentEvents = sessionEvents.slice(-6);
    const decisionEvents = sessionEvents
      .filter((event) => ['brief_created', 'brief_confirmed', 'post_review_completed'].includes(event.type))
      .slice(-4);
    const workspaceFocus = this.workspaceFocus(session);
    const workspaceEvidenceFiles = this.uniqueFirstStrings(
      [
        ...(workspaceFocus?.impactedFiles ?? []),
        ...(workspaceFocus?.relevantFiles ?? []),
        ...(workspaceFocus?.configFiles ?? [])
      ],
      16
    );
    const validationRules = this.createValidationRules(domain, intent);
    const candidateEvidenceRefs: TaskContext['evidenceRefs'] = [
      { type: 'user_input', label: 'session.originalInput' },
      ...(session.workspaceSnapshot
        ? [{ type: 'workspace_snapshot' as const, label: session.workspaceSnapshot.rootName, ref: session.workingDirectory?.name }]
        : []),
      ...workspaceEvidenceFiles.map((path) => ({
        type: 'workspace_file' as const,
        label: path,
        ref: path
      })),
      ...(workspaceFocus?.possibleEntryPoints ?? session.workspaceSnapshot?.entrypoints ?? []).slice(0, 6).map((entrypoint) => ({
        type: 'workspace_symbol' as const,
        label: entrypoint,
        ref: entrypoint
      })),
      ...(workspaceFocus?.testFiles ?? []).slice(0, 8).map((path) => ({
        type: 'test' as const,
        label: `test file: ${path}`,
        ref: path
      })),
      ...(workspaceFocus?.validationCommands ?? []).slice(0, 6).map((command) => ({
        type: 'test' as const,
        label: `validation command: ${command}`,
        ref: command
      })),
      ...artifacts.slice(-6).map((artifact) => ({
        type:
          artifact.type === 'test_report'
            ? ('test' as const)
            : artifact.type === 'code_diff'
              ? ('diff' as const)
              : domain === 'non_coding'
                ? ('document_fragment' as const)
                : ('artifact' as const),
        label: artifact.title,
        ref: artifact.id
      })),
      ...artifacts.flatMap((artifact) => this.artifactFileChangeEvidence(artifact.metadata)),
      ...relevantMemories.map((memory) => ({
        type: 'memory' as const,
        label: `${memory.scope}: ${this.shortText(memory.content, 96)}`,
        ref: memory.id
      })),
      ...ragSnippets.map((chunk) => ({
        type: this.ragEvidenceType(domain, chunk.sourceType),
        label: chunk.title,
        ref: chunk.chunkId
      })),
      ...(domain === 'non_coding'
        ? decisionEvents.map((event) => ({
            type: 'historical_decision' as const,
            label: event.type,
            ref: event.id
          }))
        : []),
      ...recentEvents.map((event) => ({
        type: this.eventEvidenceType(domain, event.type),
        label: event.type,
        ref: event.id
      }))
    ];
    const scopedCandidateEvidenceRefs = task
      ? [...candidateEvidenceRefs, { type: 'artifact' as const, label: task.title, ref: task.id }]
      : candidateEvidenceRefs;
    const evidenceSelection = this.createEvidenceSelection(session, domain, intent, phase, task, scopedCandidateEvidenceRefs);
    const scopedEvidenceRefs = evidenceSelection.selectedRefs;
    const taskMap = this.createTaskMap(session, domain, brief, evidenceSelection);
    return {
      domain,
      intent,
      currentStage: phase,
      taskMap,
      stagePlan: this.createStagePlan(session, domain, intent, phase, brief, task, taskMap, validationRules, scopedEvidenceRefs),
      executionMode: session.participatingAgentIds.length > 1 ? 'multi_agent' : 'single_agent',
      validationMode: domain === 'coding' || domain === 'mixed' ? 'mixed' : 'human_review',
      requiresCodeChanges: domain !== 'non_coding',
      requiresExternalEvidence: Boolean(artifacts.length || recentEvents.length || session.knowledgeBaseIds?.length),
      validationRules,
      agentResponsibilities: this.createAgentResponsibilities(session, domain),
      evidenceSelection,
      evidenceRefs: scopedEvidenceRefs
    };
  }

  private createStagePlan(
    session: SessionDetail,
    domain: TaskContext['domain'],
    intent: TaskContext['intent'],
    phase: AgentRunPhase,
    brief: TaskBrief | undefined,
    task: AgentTask | undefined,
    taskMap: TaskContext['taskMap'],
    validationRules: TaskContext['validationRules'],
    evidenceRefs: TaskContext['evidenceRefs']
  ): TaskContext['stagePlan'] {
    const read: TaskContext['stagePlan']['read'] = [
      {
        action: 'read',
        label: 'User goal and classified intent',
        refs: ['session.originalInput'],
        reason: `Classified as ${domain}/${intent}; keep the stage grounded in the user goal.`
      }
    ];

    if (brief) {
      read.push({
        action: 'read',
        label: `Task brief v${brief.version}`,
        refs: [brief.id],
        reason: 'Defines scope, constraints, acceptance criteria, risks, and open questions for this stage.'
      });
    }

    if (task) {
      read.push({
        action: 'read',
        label: `Current task: ${task.title}`,
        refs: [task.id],
        reason: 'Limits execution to the currently assigned unit of work.'
      });
    }

    const mapRefs = taskMap.items
      .slice(0, 8)
      .map((item) => item.ref ?? item.label)
      .filter((ref): ref is string => Boolean(ref));
    if (mapRefs.length) {
      read.push({
        action: 'read',
        label: taskMap.kind === 'project_map' ? 'Project Map focus' : 'Domain Map focus',
        refs: mapRefs,
        reason: taskMap.summary
      });
    }

    const evidenceRefsForRead = this.stageEvidenceRefs(domain, evidenceRefs);
    if (evidenceRefsForRead.length) {
      read.push({
        action: 'read',
        label: 'Minimum evidence set',
        refs: evidenceRefsForRead,
        reason: 'Use only the evidence needed for the current stage and cite these refs in outputs.'
      });
    }

    return {
      phase,
      read,
      do: this.createStageDoPlan(session, domain, intent, phase, brief, task, taskMap),
      validate: validationRules.map((rule) => ({
        action: 'validate',
        label: rule.label,
        refs: this.stageValidationRefs(rule.label, evidenceRefs),
        reason: rule.evidenceRequired
      }))
    };
  }

  private createStageDoPlan(
    session: SessionDetail,
    domain: TaskContext['domain'],
    intent: TaskContext['intent'],
    phase: AgentRunPhase,
    brief: TaskBrief | undefined,
    task: AgentTask | undefined,
    taskMap: TaskContext['taskMap']
  ): TaskContext['stagePlan']['do'] {
    const mapRef = taskMap.items.find((item) => item.ref)?.ref ?? taskMap.kind;
    const taskRef = task?.id ?? brief?.id ?? session.id;
    const scopedOutput =
      domain === 'non_coding'
        ? 'Produce evidence-grounded analysis, design, research, or documentation output without source-code changes.'
        : 'Produce scoped implementation or analysis output inside the selected Project Map boundary.';

    switch (phase) {
      case 'discussion':
        return [
          {
            action: 'do',
            label: 'Clarify goal, assumptions, and missing constraints',
            refs: [session.id],
            reason: 'Prepare enough shared state for brief generation without loading unrelated context.'
          }
        ];
      case 'brief_generation':
      case 'brief_revision':
        return [
          {
            action: 'do',
            label: 'Classify task domain and intent',
            refs: [session.id],
            reason: 'Choose the shared skeleton while allowing maps, evidence, and validation rules to diverge by domain.'
          },
          {
            action: 'do',
            label: 'Decompose work into execution, validation, and review tasks',
            refs: [mapRef],
            reason: 'Keep division of labor explicit before execution starts.'
          }
        ];
      case 'task_acceptance':
        return [
          {
            action: 'do',
            label: 'Decide claim, handoff, or rejection',
            refs: [taskRef],
            reason: 'Match currentTask to the agent responsibility and avoid accidental self-assignment.'
          }
        ];
      case 'task_execution':
        return [
          {
            action: 'do',
            label: task ? `Execute current task: ${task.title}` : 'Execute current stage task',
            refs: [taskRef, mapRef],
            reason: scopedOutput
          },
          {
            action: 'do',
            label: 'Record artifacts and next handoff',
            refs: [taskRef],
            reason: 'Outputs must remain traceable for Review Agent and Validation Agent.'
          }
        ];
      case 'post_review':
        return [
          {
            action: 'do',
            label: 'Review artifacts against brief, map boundary, and risks',
            refs: [brief?.id ?? session.id, mapRef],
            reason: 'Review is independent from execution and decides deliver, rework, or ask_user.'
          }
        ];
      case 'final_delivery':
        return [
          {
            action: 'do',
            label: 'Summarize outcome, artifacts, residual risks, and next steps',
            refs: [brief?.id ?? session.id],
            reason: 'Final delivery must connect user goal, completed work, validation evidence, and remaining gaps.'
          }
        ];
      case 'user_message_routing':
        return [
          {
            action: 'do',
            label: 'Route user message to continue, revise, pause, or ask for confirmation',
            refs: [session.id],
            reason: 'Keep long-running task state consistent across interruptions.'
          }
        ];
      default:
        return [
          {
            action: 'do',
            label: `Advance ${phase} for ${domain}/${intent}`,
            refs: [taskRef],
            reason: 'Follow the current phase boundary and Task Context Pack.'
          }
        ];
    }
  }

  private stageEvidenceRefs(domain: TaskContext['domain'], evidenceRefs: TaskContext['evidenceRefs']) {
    const preferredTypes =
      domain === 'non_coding'
        ? new Set<TaskContext['evidenceRefs'][number]['type']>([
            'document_fragment',
            'meeting_note',
            'data_table',
            'external_reference',
            'historical_decision',
            'memory',
            'user_input'
          ])
        : new Set<TaskContext['evidenceRefs'][number]['type']>([
            'workspace_snapshot',
            'workspace_file',
            'workspace_symbol',
            'diff',
            'test',
            'log',
            'artifact',
            'memory',
            'user_input'
          ]);
    const preferred = evidenceRefs.filter((ref) => preferredTypes.has(ref.type));
    return (preferred.length ? preferred : evidenceRefs)
      .slice(0, 8)
      .map((ref) => ref.ref ?? ref.label)
      .filter((ref): ref is string => Boolean(ref));
  }

  private stageValidationRefs(ruleLabel: string, evidenceRefs: TaskContext['evidenceRefs']) {
    const normalized = ruleLabel.toLowerCase();
    const codingTypes = new Set<TaskContext['evidenceRefs'][number]['type']>([
      'workspace_file',
      'workspace_symbol',
      'diff',
      'test',
      'log',
      'artifact'
    ]);
    const nonCodingTypes = new Set<TaskContext['evidenceRefs'][number]['type']>([
      'document_fragment',
      'meeting_note',
      'data_table',
      'external_reference',
      'historical_decision',
      'memory',
      'user_input',
      'artifact',
      'event_log'
    ]);
    const targetTypes =
      /typecheck|unit|test|build|e2e|smoke/i.test(normalized)
        ? codingTypes
        : /fact|scope|trace|delivery|reasoning/i.test(normalized)
          ? nonCodingTypes
          : new Set<TaskContext['evidenceRefs'][number]['type']>();
    const direct = targetTypes.size ? evidenceRefs.filter((ref) => targetTypes.has(ref.type)) : [];
    return (direct.length ? direct : evidenceRefs)
      .slice(0, 6)
      .map((ref) => ref.ref ?? ref.label)
      .filter((ref): ref is string => Boolean(ref));
  }

  private artifactFileChangeEvidence(metadata: Record<string, unknown>): TaskContext['evidenceRefs'] {
    const fileChanges = metadata.fileChanges;
    if (!Array.isArray(fileChanges)) {
      return [];
    }
    return fileChanges
      .filter((change): change is RuntimeFileChange => Boolean(change) && typeof (change as RuntimeFileChange).path === 'string')
      .slice(0, 12)
      .map((change) => ({
        type: 'diff' as const,
        label: `${change.operation}: ${change.path}`,
        ref: change.path
      }));
  }

  private eventEvidenceType(domain: TaskContext['domain'], type: string): TaskContext['evidenceRefs'][number]['type'] {
    if (type === 'runtime_failed' || type === 'error_reported' || type === 'tool_failed') {
      return 'log';
    }
    if (type === 'post_review_completed' || type === 'task_completed') {
      return 'test';
    }
    if (domain === 'non_coding' && (type === 'brief_created' || type === 'brief_confirmed')) {
      return 'historical_decision';
    }
    return 'event_log';
  }

  private ragEvidenceType(domain: TaskContext['domain'], sourceType?: string): TaskContext['evidenceRefs'][number]['type'] {
    if (sourceType === 'meeting_note') {
      return 'meeting_note';
    }
    if (sourceType === 'data_table') {
      return 'data_table';
    }
    if (sourceType === 'external_reference') {
      return 'external_reference';
    }
    return domain === 'non_coding' ? 'document_fragment' : 'external_reference';
  }

  private createEvidenceSelection(
    session: SessionDetail,
    domain: TaskContext['domain'],
    intent: TaskContext['intent'],
    phase: AgentRunPhase,
    task: AgentTask | undefined,
    candidateRefs: TaskContext['evidenceRefs']
  ): TaskContext['evidenceSelection'] {
    const uniqueCandidates = this.uniqueEvidenceRefs(candidateRefs);
    const maxEvidenceRefs = this.maxEvidenceRefs(domain, phase);
    const ranked = uniqueCandidates
      .map((ref, index) => ({
        ref,
        index,
        score: this.evidenceRefScore(domain, intent, phase, task, ref)
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const selected = ranked
      .slice(0, maxEvidenceRefs)
      .sort((left, right) => left.index - right.index)
      .map((item) => item.ref);
    const omitted = ranked
      .slice(maxEvidenceRefs)
      .sort((left, right) => left.index - right.index)
      .map((item) => item.ref);
    return {
      phase,
      strategy:
        domain === 'non_coding'
          ? 'non_coding_minimal'
          : domain === 'mixed'
            ? 'mixed_minimal'
            : 'coding_minimal',
      query: [session.originalInput, task?.title, task?.description].filter(Boolean).join(' | '),
      maxEvidenceRefs,
      selectedCount: selected.length,
      omittedCount: omitted.length,
      selectedTypes: this.uniqueEvidenceTypes(selected),
      omittedTypes: this.uniqueEvidenceTypes(omitted),
      selectedRefs: selected,
      omittedRefs: omitted.slice(0, 8),
      rules: this.evidenceSelectionRules(domain, intent, phase)
    };
  }

  private maxEvidenceRefs(domain: TaskContext['domain'], phase: AgentRunPhase) {
    if (phase === 'brief_generation' || phase === 'discussion') return 18;
    return domain === 'non_coding' ? 24 : 28;
  }

  private evidenceSelectionRules(
    domain: TaskContext['domain'],
    intent: TaskContext['intent'],
    phase: AgentRunPhase
  ) {
    const shared = [
      `Select only refs needed for ${phase}.`,
      'Always keep user goal, current task, prior artifacts, memory, RAG, or event refs when they ground the current output.',
      'Keep omitted refs traceable by count/type, but do not send full unrelated history.'
    ];
    if (domain === 'non_coding') {
      return [
        ...shared,
        'Prefer document fragments, meeting notes, data tables, external references, historical decisions, and memory.',
        'Use fact, scope, traceability, and delivery completeness rules instead of implementation-only evidence.'
      ];
    }
    if (domain === 'mixed') {
      return [
        ...shared,
        'Prefer workspace files/symbols, diffs, tests, artifacts, memory, and document refs that link planning to implementation.',
        'Keep both Project Map and analysis evidence when validation must bridge coding and non-coding work.'
      ];
    }
    return [
      ...shared,
      `Prefer workspace files, symbols, logs, tests, diffs, and artifacts for ${intent}.`,
      'Keep validation evidence aligned with typecheck, tests, build, and smoke/e2e paths.'
    ];
  }

  private evidenceRefScore(
    domain: TaskContext['domain'],
    intent: TaskContext['intent'],
    phase: AgentRunPhase,
    task: AgentTask | undefined,
    ref: TaskContext['evidenceRefs'][number]
  ) {
    let score =
      ref.type === 'user_input'
        ? 120
        : ref.ref && task?.id === ref.ref
          ? 115
          : 20;
    const codingPriority = new Map<TaskContext['evidenceRefs'][number]['type'], number>([
      ['workspace_snapshot', 90],
      ['workspace_file', 88],
      ['workspace_symbol', 86],
      ['diff', 84],
      ['test', 82],
      ['log', 80],
      ['artifact', 72],
      ['memory', 68],
      ['event_log', 52],
      ['external_reference', 48]
    ]);
    const nonCodingPriority = new Map<TaskContext['evidenceRefs'][number]['type'], number>([
      ['document_fragment', 92],
      ['meeting_note', 90],
      ['data_table', 88],
      ['external_reference', 84],
      ['historical_decision', 82],
      ['memory', 80],
      ['artifact', 74],
      ['event_log', 58],
      ['user_input', 120]
    ]);
    score += (domain === 'non_coding' ? nonCodingPriority : codingPriority).get(ref.type) ?? 30;
    if (domain === 'mixed' && ['document_fragment', 'external_reference', 'memory'].includes(ref.type)) {
      score += 12;
    }
    if (phase === 'task_execution' && ['workspace_file', 'document_fragment', 'memory', 'artifact'].includes(ref.type)) {
      score += 10;
    }
    if ((phase === 'post_review' || intent === 'validation') && ['test', 'diff', 'log', 'artifact', 'document_fragment'].includes(ref.type)) {
      score += 12;
    }
    if (intent === 'troubleshooting' && ['log', 'test', 'diff', 'event_log'].includes(ref.type)) {
      score += 16;
    }
    return score;
  }

  private uniqueEvidenceTypes(refs: TaskContext['evidenceRefs']) {
    return Array.from(new Set(refs.map((ref) => ref.type)));
  }

  private uniqueEvidenceRefs(refs: TaskContext['evidenceRefs']): TaskContext['evidenceRefs'] {
    const seen = new Set<string>();
    const unique: TaskContext['evidenceRefs'] = [];
    for (const ref of refs) {
      const key = `${ref.type}:${ref.label}:${ref.ref ?? ''}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(ref);
    }
    return unique;
  }

  private createTaskMap(
    session: SessionDetail,
    domain: TaskContext['domain'],
    brief?: TaskBrief,
    evidenceSelection?: TaskContext['evidenceSelection']
  ): TaskContext['taskMap'] {
    const focus = this.projectMap.workspaceFocus(session);
    if (domain === 'coding' || domain === 'mixed') {
      const moduleFiles = this.uniqueFirstStrings([...(focus?.impactedFiles ?? []), ...(focus?.relevantFiles ?? [])], 10);
      const items: TaskContext['taskMap']['items'] = [
        ...moduleFiles.map((path) => ({
          type: 'module' as const,
          label: path,
          ref: path,
          reason: 'Relevant or impacted workspace file selected from Project Map focus.'
        })),
        ...(focus?.possibleEntryPoints ?? []).slice(0, 4).map((path) => ({
          type: 'entrypoint' as const,
          label: path,
          ref: path,
          reason: 'Detected project entrypoint.'
        })),
        ...(focus?.detectedStack ?? []).slice(0, 5).map((stack) => ({
          type: 'key_material' as const,
          label: stack,
          reason: 'Detected technology stack.'
        })),
        ...(focus?.configFiles ?? []).slice(0, 6).map((path) => ({
          type: 'key_material' as const,
          label: `config: ${path}`,
          ref: path,
          reason: 'Configuration or project instruction file needed to understand the implementation boundary.'
        })),
        ...this.taskMapEvidenceItems(evidenceSelection, domain),
        {
          type: 'boundary' as const,
          label: session.workingDirectory?.name ?? session.workspaceSnapshot?.rootName ?? 'workspace snapshot',
          ref: session.workingDirectory?.path,
          reason: 'Runtime must stay within the selected workspace evidence and capability policy.'
        },
        ...(focus?.testFiles ?? []).slice(0, 6).map((path) => ({
          type: 'validation_path' as const,
          label: `test file: ${path}`,
          ref: path,
          reason: 'Detected test file that can validate or guide the implementation.'
        })),
        ...(focus?.validationCommands ?? []).slice(0, 6).map((command) => ({
          type: 'validation_path' as const,
          label: command,
          ref: command,
          reason: 'Detected package script suitable for validation.'
        })),
        ...this.createValidationRules(domain, session.taskIntent ?? 'implementation').map((rule) => ({
          type: 'validation_path' as const,
          label: rule.label,
          reason: rule.evidenceRequired
        }))
      ];
      return {
        kind: 'project_map',
        summary: focus?.rationale ?? 'Project Map built from workspace snapshot and detected entrypoints.',
        items
      };
    }

    const items: TaskContext['taskMap']['items'] = [
      {
        type: 'boundary' as const,
        label: 'non-coding task boundary',
        reason: 'No source-code edits are required unless a later user request explicitly changes scope.'
      },
      {
        type: 'entrypoint' as const,
        label: this.shortText(session.originalInput, 120),
        reason: 'User goal is the analysis entrypoint for the Domain Map.'
      },
      ...(brief?.scope ?? []).slice(0, 4).map((item) => ({
        type: 'module' as const,
        label: item,
        reason: 'Analysis scope from the current brief.'
      })),
      ...this.taskMapEvidenceItems(evidenceSelection, domain),
      ...(brief?.acceptanceCriteria ?? []).slice(0, 4).map((item) => ({
        type: 'validation_path' as const,
        label: item,
        reason: 'Acceptance criterion for non-coding delivery.'
      })),
      ...this.createValidationRules(domain, session.taskIntent ?? 'analysis').map((rule) => ({
        type: 'validation_path' as const,
        label: rule.label,
        reason: rule.evidenceRequired
      }))
    ];
    return {
      kind: 'domain_map',
      summary: 'Domain Map built from user goal, brief scope, artifacts, event decisions, and knowledge evidence.',
      items
    };
  }

  private taskMapEvidenceItems(
    evidenceSelection: TaskContext['evidenceSelection'] | undefined,
    domain: TaskContext['domain']
  ): TaskContext['taskMap']['items'] {
    if (!evidenceSelection) {
      return [];
    }
    const materialTypes =
      domain === 'non_coding'
        ? new Set<TaskContext['evidenceRefs'][number]['type']>([
            'document_fragment',
            'meeting_note',
            'data_table',
            'external_reference',
            'historical_decision',
            'memory',
            'artifact'
          ])
        : new Set<TaskContext['evidenceRefs'][number]['type']>([
            'artifact',
            'diff',
            'test',
            'log',
            'memory',
            'external_reference',
            'document_fragment'
          ]);
    return evidenceSelection.selectedRefs
      .filter((ref) => materialTypes.has(ref.type))
      .slice(0, 8)
      .map((ref) => ({
        type: 'key_material' as const,
        label: `${ref.type}: ${ref.label}`,
        ref: ref.ref,
        reason: `Selected by evidenceSelection (${evidenceSelection.strategy}) for the current ${domain} stage.`
      }));
  }

  private createValidationRules(domain: TaskContext['domain'], intent: TaskContext['intent']): TaskContext['validationRules'] {
    if (domain === 'non_coding') {
      return [
        { label: 'Fact consistency', evidenceRequired: 'Every factual conclusion links to user input, retrieved material, or a stated assumption.' },
        { label: 'Scope consistency', evidenceRequired: 'Output covers the agreed brief scope and does not add hidden implementation work.' },
        { label: 'Traceability', evidenceRequired: 'Key conclusions cite taskContext.evidenceRefs, artifacts, or event decisions.' },
        { label: 'Delivery completeness', evidenceRequired: 'Final output includes answer/plan, risks, open questions, and next steps.' }
      ];
    }

    const rules: TaskContext['validationRules'] = [
      { label: 'Typecheck', evidenceRequired: '`npm run typecheck` or equivalent typed contract evidence.' },
      { label: 'Unit or workspace tests', evidenceRequired: '`npm run test` or a scoped test command covering the changed surface.' },
      { label: 'Build', evidenceRequired: '`npm run build` or equivalent build output for user-facing/runtime changes.' }
    ];
    if (domain === 'mixed' || intent === 'validation') {
      rules.push({ label: 'E2E or smoke flow', evidenceRequired: 'A smoke/e2e run proving orchestration, UI, or runtime behavior.' });
      rules.push({ label: 'Reasoning trace', evidenceRequired: 'Planning artifact and implementation evidence refer to the same user goal.' });
    }
    return rules;
  }

  private createAgentResponsibilities(session: SessionDetail, domain: TaskContext['domain']): TaskContext['agentResponsibilities'] {
    const agents = this.participatingAgents(session);
    const choose = (preferredKeys: string[], fallback: string) =>
      agents.find((agent) => preferredKeys.includes(agent.key))?.key ?? fallback;
    const executionKey =
      domain === 'non_coding'
        ? choose(['requirements', 'product-manager', 'architect'], 'requirements')
        : choose(['backend', 'frontend', 'architect', 'requirements'], 'backend');
    const validationKey = choose(['test', 'review'], 'test');
    const reviewKey = choose(['review', 'test'], 'review');
    return [
      { role: 'execution', agentKey: executionKey },
      { role: 'validation', agentKey: validationKey, independentFrom: [executionKey] },
      { role: 'review', agentKey: reviewKey, independentFrom: Array.from(new Set([executionKey, validationKey])) }
    ];
  }

  private createContinuationState(
    session: SessionDetail,
    agent: Agent,
    task: AgentTask | undefined,
    phase: AgentRunPhase,
    taskContext: TaskContext,
    summaryMemory: SummaryMemory
  ): ContextPack['continuationState'] {
    const tasks = this.tasks.list(session.id);
    const recentEvents = this.events.list(session.id).slice(-12);
    const recentArtifacts = this.artifacts.listBySession(session.id).slice(-12);
    const checkpoint = this.latestSummaryMemoryCheckpoint(session.id);
    const pendingTaskIds = tasks
      .filter((item) => ['pending', 'claimed', 'waiting'].includes(item.status))
      .map((item) => item.id);
    const runningTaskIds = tasks
      .filter((item) => ['running', 'reviewing', 'reworking'].includes(item.status))
      .map((item) => item.id);
    const completedTaskIds = tasks.filter((item) => item.status === 'completed').map((item) => item.id);
    const blockedTaskIds = tasks
      .filter((item) => ['waiting', 'rejected', 'failed'].includes(item.status))
      .map((item) => item.id);
    const handoffRefs = recentEvents
      .filter((event) =>
        ['task_claimed', 'task_completed', 'task_reworked', 'post_review_completed', 'final_delivery_created'].includes(event.type)
      )
      .map((event) => event.id);

    return {
      phase,
      sessionStatus: session.status,
      activeTaskId: task?.id,
      activeAgentKey: agent.key,
      lastCheckpointRef: checkpoint?.checkpoint.checkpointId ?? summaryMemory.checkpointRefs?.at(-1),
      pendingTaskIds,
      runningTaskIds,
      completedTaskIds,
      blockedTaskIds,
      nextAgentKeys: this.nextContinuationAgentKeys(phase, taskContext),
      handoffRefs,
      sourceEventIds: recentEvents.map((event) => event.id),
      sourceArtifactIds: recentArtifacts.map((artifact) => artifact.id),
      resumeHints: this.continuationResumeHints(session, phase, task, taskContext, summaryMemory, {
        pendingTaskIds,
        runningTaskIds,
        completedTaskIds,
        blockedTaskIds
      })
    };
  }

  private nextContinuationAgentKeys(phase: AgentRunPhase, taskContext: TaskContext) {
    const byRole = new Map(taskContext.agentResponsibilities.map((item) => [item.role, item.agentKey]));
    const keys =
      phase === 'task_execution'
        ? [byRole.get('validation'), byRole.get('review')]
        : phase === 'post_review'
          ? [byRole.get('review'), byRole.get('execution')]
          : phase === 'final_delivery'
            ? [byRole.get('review')]
            : [byRole.get('execution'), byRole.get('validation'), byRole.get('review')];
    return this.uniqueStrings(keys.filter((key): key is string => Boolean(key)), 6);
  }

  private continuationResumeHints(
    session: SessionDetail,
    phase: AgentRunPhase,
    task: AgentTask | undefined,
    taskContext: TaskContext,
    summaryMemory: SummaryMemory,
    taskIds: Pick<
      ContextPack['continuationState'],
      'pendingTaskIds' | 'runningTaskIds' | 'completedTaskIds' | 'blockedTaskIds'
    >
  ) {
    const hints = [
      `Resume ${phase} from session status ${session.status}.`,
      task ? `Continue active task "${task.title}" (${task.status}).` : undefined,
      taskIds.blockedTaskIds.length ? `Inspect blocked tasks before advancing: ${taskIds.blockedTaskIds.join(', ')}.` : undefined,
      taskIds.runningTaskIds.length ? `Running tasks define the current execution surface: ${taskIds.runningTaskIds.join(', ')}.` : undefined,
      taskIds.pendingTaskIds.length ? `Pending tasks remain in dependency order: ${taskIds.pendingTaskIds.join(', ')}.` : undefined,
      taskIds.completedTaskIds.length ? `Completed tasks can be used as prior output evidence: ${taskIds.completedTaskIds.join(', ')}.` : undefined,
      summaryMemory.nextSteps.length ? `Summary next step: ${summaryMemory.nextSteps.at(-1)}.` : undefined,
      `Keep validation independent via ${taskContext.agentResponsibilities
        .filter((item) => item.role !== 'execution')
        .map((item) => `${item.role}:${item.agentKey}`)
        .join(', ')}.`
    ].filter((hint): hint is string => Boolean(hint));
    return this.uniqueStrings(hints, 8);
  }

  private createSummaryMemory(
    session: SessionDetail,
    brief: TaskBrief | undefined,
    task: AgentTask | undefined,
    phase: AgentRunPhase
  ): SummaryMemory {
    const prior = this.latestSummaryMemoryCheckpoint(session.id);
    const tasks = this.tasks.list(session.id);
    const completed = tasks.filter((item) => item.status === 'completed').map((item) => item.title).slice(0, 6);
    const recentEvents = this.events.list(session.id).slice(-8);
    const recentArtifactIds = this.artifacts.listBySession(session.id).slice(-8).map((artifact) => artifact.id);
    const confirmedFacts = [
      `Session status: ${session.status}`,
      `Current stage: ${phase}`,
      ...(brief ? [`Brief v${brief.version}: ${brief.goal}`] : []),
      ...(session.workspaceSnapshot ? [`Workspace snapshot: ${session.workspaceSnapshot.rootName}`] : []),
      ...(session.workspaceSnapshot?.detectedStack?.length ? [`Detected stack: ${session.workspaceSnapshot.detectedStack.join(', ')}`] : [])
    ];
    const decisions = this.events
      .list(session.id)
      .filter((event) => event.type === 'brief_created' || event.type === 'brief_confirmed' || event.type === 'post_review_completed')
      .map((event) => event.content)
      .slice(-4);
    const previous = prior?.checkpoint.summaryMemory;
    return {
      goal: brief?.goal ?? previous?.goal ?? session.originalInput,
      currentState: `${session.status} / ${phase}${task ? ` / ${task.status}: ${task.title}` : ''}`,
      confirmedFacts: this.uniqueStrings([...(previous?.confirmedFacts ?? []), ...confirmedFacts], 12),
      completed: this.uniqueStrings([...(previous?.completed ?? []), ...completed], 12),
      decisions: this.uniqueStrings([...(previous?.decisions ?? []), ...decisions], 8),
      openQuestions: this.uniqueStrings([...(previous?.openQuestions ?? []), ...(brief?.openQuestions ?? [])], 8),
      risks: this.uniqueStrings([...(previous?.risks ?? []), ...(brief?.risks ?? [])], 8),
      nextSteps: task
        ? [`Complete task: ${task.title}`]
        : session.status === 'WAIT_USER_CONFIRM'
          ? ['Wait for user confirmation of the current brief.']
          : ['Continue the next orchestration stage.'],
      checkpointRefs: this.uniqueStrings([...(previous?.checkpointRefs ?? []), ...(prior ? [prior.checkpoint.checkpointId] : [])], 8),
      sourceEventIds: this.uniqueStrings([...(previous?.sourceEventIds ?? []), ...recentEvents.map((event) => event.id)], 12),
      sourceArtifactIds: this.uniqueStrings([
        ...(previous?.sourceArtifactIds ?? []),
        ...(prior ? [prior.artifact.id] : []),
        ...recentArtifactIds
      ], 12),
      sourceMemoryIds: this.uniqueStrings(previous?.sourceMemoryIds ?? [], 12)
    };
  }

  private createSummaryMemoryCheckpoint(
    session: SessionDetail,
    agent: Agent,
    phase: AgentRunPhase,
    brief?: TaskBrief,
    task?: AgentTask
  ) {
    const checkpointId = crypto.randomUUID();
    const sourceEventIds = this.events.list(session.id).slice(-12).map((event) => event.id);
    const sourceArtifactIds = this.artifacts.listBySession(session.id).slice(-12).map((artifact) => artifact.id);
    const summaryMemory = this.createSummaryMemory(session, brief, task, phase);
    const memory = this.memories.create({
      sessionId: session.id,
      agentId: agent.id,
      scope: 'session',
      content: this.summaryMemoryCheckpointText(checkpointId, phase, summaryMemory),
      confidence: 0.94
    });
    const checkpoint: SummaryMemoryCheckpoint = {
      kind: 'summary_memory_checkpoint',
      checkpointId,
      sessionId: session.id,
      phase,
      taskId: task?.id,
      agentId: agent.id,
      summaryMemory: {
        ...summaryMemory,
        checkpointRefs: this.uniqueStrings([...(summaryMemory.checkpointRefs ?? []), checkpointId], 8),
        sourceEventIds: this.uniqueStrings([...(summaryMemory.sourceEventIds ?? []), ...sourceEventIds], 12),
        sourceArtifactIds: this.uniqueStrings([...(summaryMemory.sourceArtifactIds ?? []), ...sourceArtifactIds], 12),
        sourceMemoryIds: this.uniqueStrings([...(summaryMemory.sourceMemoryIds ?? []), memory.id], 12)
      },
      sourceEventIds,
      sourceArtifactIds,
      sourceMemoryIds: [memory.id],
      createdAt: nowIso()
    };
    const artifact = this.artifacts.create({
      sessionId: session.id,
      taskId: task?.id,
      agentId: agent.id,
      type: 'json',
      title: `Summary memory checkpoint: ${phase}`,
      contentSummary: checkpoint.summaryMemory.currentState,
      metadata: {
        phase: 'summary_memory_checkpoint',
        checkpointId,
        summaryMemoryCheckpoint: checkpoint
      }
    });
    this.events.create({
      sessionId: session.id,
      type: 'artifact_created',
      taskId: task?.id,
      fromAgentId: agent.id,
      content: messages.artifactCreated(artifact.title),
      metadata: createMetadata('artifact_card', {
        artifactId: artifact.id,
        type: artifact.type,
        title: artifact.title,
        contentSummary: artifact.contentSummary,
        checkpointId,
        memoryId: memory.id
      })
    });
    return { artifact, memory, checkpoint };
  }

  private latestSummaryMemoryCheckpoint(sessionId: string) {
    const artifacts = this.artifacts.listBySession(sessionId);
    for (let index = artifacts.length - 1; index >= 0; index -= 1) {
      const artifact = artifacts[index];
      const checkpoint = artifact.metadata.summaryMemoryCheckpoint;
      if (this.isSummaryMemoryCheckpoint(checkpoint)) {
        return { artifact, checkpoint };
      }
    }
    return undefined;
  }

  private isSummaryMemoryCheckpoint(value: unknown): value is SummaryMemoryCheckpoint {
    return (
      Boolean(value) &&
      typeof value === 'object' &&
      (value as SummaryMemoryCheckpoint).kind === 'summary_memory_checkpoint' &&
      typeof (value as SummaryMemoryCheckpoint).checkpointId === 'string' &&
      Boolean((value as SummaryMemoryCheckpoint).summaryMemory)
    );
  }

  private summaryMemoryCheckpointText(checkpointId: string, phase: AgentRunPhase, summaryMemory: SummaryMemory) {
    return [
      `summary_memory_checkpoint ${checkpointId}`,
      `phase: ${phase}`,
      `goal: ${summaryMemory.goal}`,
      `currentState: ${summaryMemory.currentState}`,
      `confirmedFacts: ${summaryMemory.confirmedFacts.join(' | ')}`,
      `completed: ${summaryMemory.completed.join(' | ')}`,
      `decisions: ${summaryMemory.decisions.join(' | ')}`,
      `openQuestions: ${summaryMemory.openQuestions.join(' | ')}`,
      `risks: ${summaryMemory.risks.join(' | ')}`,
      `nextSteps: ${summaryMemory.nextSteps.join(' | ')}`
    ].join('\n');
  }

  private uniqueStrings(values: string[], limit: number) {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const value of values) {
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      unique.push(normalized);
    }
    return unique.slice(Math.max(0, unique.length - limit));
  }

  private uniqueFirstStrings(values: string[], limit: number) {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const value of values) {
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      unique.push(normalized);
      if (unique.length >= limit) {
        break;
      }
    }
    return unique;
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
    const selectedRelevantFiles = relevantFiles.length ? relevantFiles : fallbackFiles;
    const entrypoints = snapshot.entrypoints ?? [];
    const configFiles = this.workspaceConfigFiles(snapshot);
    const testFiles = this.workspaceTestFiles(snapshot, selectedRelevantFiles);
    const impactedFiles = this.workspaceImpactedFiles(snapshot, selectedRelevantFiles, entrypoints);
    const validationCommands = this.workspaceValidationCommands(snapshot);
    return {
      relevantFiles: selectedRelevantFiles,
      impactedFiles,
      testFiles,
      configFiles,
      possibleEntryPoints: entrypoints,
      detectedStack: snapshot.detectedStack ?? [],
      validationCommands,
      rationale: relevantFiles.length
        ? 'Matched workspace file paths against user requirement keywords, then added impacted files, tests, configs, entrypoints, and validation scripts.'
        : 'No strong keyword match was found, so the first readable workspace files are used with detected tests, configs, entrypoints, and validation scripts.'
    };
  }

  private workspaceConfigFiles(snapshot: WorkspaceSnapshot) {
    const configNames = new Set([
      'agents.md',
      'claude.md',
      'readme.md',
      'package.json',
      'tsconfig.json',
      'vite.config.ts',
      'vite.config.js',
      'nest-cli.json',
      'eslint.config.js',
      'eslint.config.mjs',
      'vitest.config.ts',
      'playwright.config.ts'
    ]);
    return snapshot.files
      .map((file) => file.path)
      .filter((path) => configNames.has(path.toLowerCase().split('/').at(-1) ?? path.toLowerCase()))
      .slice(0, 12);
  }

  private workspaceTestFiles(snapshot: WorkspaceSnapshot, relevantFiles: string[]) {
    const paths = snapshot.files.map((file) => file.path);
    const relevantStems = new Set(
      relevantFiles
        .map((path) => path.split('/').at(-1) ?? path)
        .map((name) => name.replace(/\.(test|spec)\.[^.]+$/i, '').replace(/\.[^.]+$/i, '').toLowerCase())
        .filter(Boolean)
    );
    const scored = paths
      .filter((path) => this.isWorkspaceTestPath(path))
      .map((path) => {
        const lowerPath = path.toLowerCase();
        const fileName = lowerPath.split('/').at(-1) ?? lowerPath;
        const stem = fileName.replace(/\.(test|spec)\.[^.]+$/i, '').replace(/\.[^.]+$/i, '');
        return {
          path,
          score:
            (relevantStems.has(stem) ? 80 : 0) +
            (lowerPath.includes('/e2e/') || lowerPath.includes('\\e2e\\') ? 20 : 0) +
            (lowerPath.includes('/tests/') || lowerPath.startsWith('tests/') ? 10 : 0)
        };
      })
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .map((item) => item.path);
    return this.uniqueFirstStrings(scored, 12);
  }

  private isWorkspaceTestPath(path: string) {
    const lower = path.toLowerCase();
    return (
      /(^|\/)(tests?|e2e|__tests__)\//.test(lower) ||
      /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|vue)$/.test(lower)
    );
  }

  private workspaceValidationCommands(snapshot: WorkspaceSnapshot) {
    const packageFiles = snapshot.files.filter((file) => file.path.endsWith('package.json') && file.content);
    const commands: string[] = [];
    for (const file of packageFiles) {
      try {
        const parsed = JSON.parse(file.content ?? '{}') as { scripts?: Record<string, unknown> };
        const scripts = parsed.scripts ?? {};
        for (const scriptName of Object.keys(scripts)) {
          if (/^(typecheck|test|test:|build|e2e|smoke|lint)/i.test(scriptName)) {
            commands.push(`npm run ${scriptName}`);
          }
        }
      } catch {
        continue;
      }
    }
    const preferredOrder = ['npm run typecheck', 'npm run test', 'npm run build'];
    return this.uniqueFirstStrings(
      [...preferredOrder.filter((command) => commands.includes(command)), ...commands],
      8
    );
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
          maxInputTokens,
          diagnostics: fitted.diagnostics
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
          estimatedTokens: fitted.estimatedTokens,
          maxInputTokens,
          diagnostics: fitted.diagnostics
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

  private shortText(value: string, maxLength: number) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1))}…` : normalized;
  }

  private runtimeError(result: AgentRunResult, phase: string) {
    return Object.assign(new Error(messages.runtimeError(result.runtimeType, phase, result.error?.message ?? result.status)), {
      cause: result.error
    });
  }

  private defaultSuggestedTasks(session: SessionDetail): SuggestedAgentTask[] {
    if (session.taskDomain === 'non_coding') {
      const analysisTitle = '产出分析或方案建议';
      const validationTitle = '验证事实与交付完整性';
      return [
        {
          title: analysisTitle,
          description: '围绕当前目标沉淀结构化分析、方案、计划或说明。',
          suggestedAgentKey: session.taskIntent === 'planning' ? 'product-manager' : 'requirements',
          acceptanceCriteria: ['输出直接回答用户目标，并形成可复用的结构化结论。']
        },
        {
          title: validationTitle,
          description: '独立验证分析结论的事实一致性、范围一致性、可追溯性和交付完整性。',
          suggestedAgentKey: 'test',
          acceptanceCriteria: ['验证结果映射到非编程验证规则，并指出证据、缺口和风险。'],
          dependsOnTaskTitles: [analysisTitle]
        },
        {
          title: '复核结论与风险',
          description: '检查分析或方案是否覆盖范围、风险、假设和下一步建议。',
          suggestedAgentKey: 'review',
          acceptanceCriteria: ['复核结果明确指出已覆盖项、风险和未决问题。'],
          dependsOnTaskTitles: [validationTitle]
        }
      ];
    }

    if (session.taskDomain === 'mixed') {
      return [
        {
          title: '形成需求与实现计划',
          description: '先沉淀需求理解、范围、关键约束和实现路线。',
          suggestedAgentKey: session.taskIntent === 'planning' ? 'product-manager' : 'requirements',
          acceptanceCriteria: ['输出包含范围、约束、验收标准和实施建议。']
        },
        {
          title: messages.defaultTaskExecuteTitle,
          description: messages.defaultTaskExecuteDescription,
          suggestedAgentKey: 'backend',
          acceptanceCriteria: [messages.defaultTaskExecuteAcceptance],
          dependsOnTaskTitles: ['形成需求与实现计划']
        },
        {
          title: messages.defaultTaskValidateTitle,
          description: messages.defaultTaskValidateDescription,
          suggestedAgentKey: 'test',
          acceptanceCriteria: [messages.defaultTaskValidateAcceptance],
          dependsOnTaskTitles: [messages.defaultTaskExecuteTitle]
        }
      ];
    }

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

  private selectSuggestedTasks(session: SessionDetail, runtimeSuggestedTasks: SuggestedAgentTask[]) {
    if (!runtimeSuggestedTasks.length) {
      return this.defaultSuggestedTasks(session);
    }

    if (session.taskDomain === 'mixed') {
      const hasPlanningTask = runtimeSuggestedTasks.some((task) =>
        /plan|规划|需求|分析|scope|implementation path/i.test(`${task.title} ${task.description}`)
      );
      const hasImplementationTask = runtimeSuggestedTasks.some((task) =>
        /implement|执行|实现|backend|frontend/i.test(`${task.title} ${task.description}`)
      );
      const hasFrontendImplementation = runtimeSuggestedTasks.some(
        (task) => task.suggestedAgentKey === 'frontend' && /implement|frontend/i.test(`${task.title} ${task.description}`)
      );
      const hasBackendImplementation = runtimeSuggestedTasks.some(
        (task) => task.suggestedAgentKey === 'backend' && /implement|backend/i.test(`${task.title} ${task.description}`)
      );
      const hasValidationTask = runtimeSuggestedTasks.some((task) => this.isValidationSuggestedTask(task));
      const isExplicitParallelCodingPlan = hasFrontendImplementation && hasBackendImplementation && hasValidationTask;
      if (!isExplicitParallelCodingPlan && (!hasPlanningTask || !hasImplementationTask)) {
        return this.defaultSuggestedTasks(session);
      }
    }

    if (session.taskDomain === 'non_coding') {
      const allCodingAgents = runtimeSuggestedTasks.every((task) => ['backend', 'frontend', 'test'].includes(task.suggestedAgentKey ?? ''));
      const hasValidationTask = runtimeSuggestedTasks.some((task) =>
        /validate|validation|验证|事实|trace|evidence|完整性|test/i.test(`${task.title} ${task.description}`)
      );
      if (allCodingAgents || !hasValidationTask) {
        return this.defaultSuggestedTasks(session);
      }
    }

    return this.ensureValidationSuggestedTask(session, runtimeSuggestedTasks);
  }

  private ensureValidationSuggestedTask(session: SessionDetail, suggestions: SuggestedAgentTask[]) {
    const validationAgentKey = this.validationSuggestedAgentKey(session);
    const normalized = suggestions.map((task) =>
      this.isValidationSuggestedTask(task)
        ? {
            ...task,
            suggestedAgentKey: validationAgentKey
          }
        : task
    );
    if (normalized.some((task) => this.isValidationSuggestedTask(task))) {
      return normalized;
    }

    const fallbackValidation = this.defaultSuggestedTasks(session).find((task) => this.isValidationSuggestedTask(task));
    const lastTaskTitle = normalized.at(-1)?.title;
    return [
      ...normalized,
      {
        title: fallbackValidation?.title ?? 'Validate task output',
        description:
          fallbackValidation?.description ??
          'Independently validate the execution output against the Task Context Pack validation rules.',
        suggestedAgentKey: validationAgentKey,
        acceptanceCriteria: fallbackValidation?.acceptanceCriteria ?? [
          'Validation result maps rules to evidence and records gaps, risks, and remaining work.'
        ],
        dependsOnTaskTitles: lastTaskTitle ? [lastTaskTitle] : fallbackValidation?.dependsOnTaskTitles
      }
    ];
  }

  private validationSuggestedAgentKey(session: SessionDetail) {
    const keys = new Set(this.participatingAgents(session).map((agent) => agent.key));
    if (keys.has('test')) return 'test';
    if (keys.has('review')) return 'review';
    return 'test';
  }

  private isValidationSuggestedTask(task: SuggestedAgentTask) {
    const title = task.title.trim();
    const description = task.description.trim();
    return (
      task.suggestedAgentKey === 'test' ||
      /^(validate|validating|validation|verify|verification|check|test|e2e|smoke)\b/i.test(title) ||
      /^(验证|验收|校验|测试)/.test(title) ||
      /^(validate|validating|validation|verify|verification|check|test)\b/i.test(description) ||
      /^(验证|验收|校验|测试)/.test(description)
    );
  }
}
