import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  type BeforeApplicationShutdown,
  type OnModuleDestroy
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import crypto from 'node:crypto';
import type {
  AgentDefinition as Agent,
  AgentMessageOutput,
  AgentTask,
  CaptureFileRevisionBaselineInput,
  CollaborationEvent,
  CreateFileRevisionRunInput,
  DecideFileRevisionInput,
  ReprocessFileRevisionInput,
  ResolveFileRevisionFailureInput,
  ResolveWorkspaceWritebackInput,
  RetryInterruptedFileRevisionInput,
  SaveFileRevisionDraftInput,
  LocalRuntimePermission,
  PendingInvocation,
  PostReviewAction,
  RuntimeError,
  SessionDetail,
  SessionFollowUpMessage,
  SessionStatus,
  RuntimePreference,
  SessionWorkingDirectory,
  SessionWorkspaceContext,
  TaskBrief,
  UserMessageHandlingPlan,
  WorkspaceWritebackRecord
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { messages } from '../../common/messages.js';
import { abortWithTermination, createExecutionTermination } from '../../common/execution-termination.js';
import { extractRuntimeError } from '../../common/runtime-error.js';
import { buildBudget } from '../../common/token.js';
import {
  isRuntimeType,
  reworkMaxRounds
} from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { AgentsService } from '../agents/agents.service.js';
import { EventsService } from '../events/events.service.js';
import { IntentRecognitionService } from '../intent-recognition/intent-recognition.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { ExecutionOutcome, OrchestratorService, usableAgentMessageOutput } from '../orchestrator/orchestrator.service.js';
import { ExecutionService } from '../execution/execution.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { assertCurrentDataEpoch } from '../persistence/data-epoch-guard.js';
import { TasksService } from '../tasks/tasks.service.js';
import { WorkflowRuntimeService, type WorkflowRuntimeUpdate } from '../workflows/workflow-runtime.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { WorktreeExecutionService } from '../worktree-execution/worktree-execution.service.js';
import { WorkdirBriefService } from '../runtimes/streaming/workdir-brief.service.js';
import { RuntimeService } from '../runtimes/runtime.service.js';
import { LocalRuntimeConnectionService } from '../local-runtime/local-runtime-connection.service.js';
import { WorkspaceProviderResolver } from '../workspaces/workspace-provider-resolver.js';
import { WorkspaceWritebackService } from '../workspaces/workspace-writeback.service.js';
import { validateServerLocalWorkspace } from '../workspaces/validate-server-local-workspace.js';
import { CapabilitiesService } from '../capabilities/capabilities.service.js';
import { FileRevisionsService } from '../file-revisions/file-revisions.service.js';

type CreateSessionInput = {
  input: string;
  agentIds?: string[];
  projectId?: string;
  tokenBudget?: number;
  knowledgeBaseIds?: string[];
  workingDirectory?: SessionWorkingDirectory;
  runtimePreference?: RuntimePreference;
  origin?: 'user' | 'autopilot';
  autopilotRunId?: string;
};

const ACTIVE_INVOCATION_SESSION_STATUSES = new Set<SessionStatus>([
  'AGENT_DISCUSSING',
  'REVISING_BRIEF',
  'EXECUTING',
  'POST_REVIEW',
  'REWORKING'
]);

@Injectable()
export class SessionsService implements BeforeApplicationShutdown, OnModuleDestroy {
  private readonly logger = new Logger(SessionsService.name);
  private readonly sessions = new Map<string, SessionDetail>();
  private readonly briefGenerationSeqBySession = new Map<string, number>();
  private readonly briefGenerationRuns = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly followUpPlanningRuns = new Map<string, Promise<void>>();
  private readonly deletingSessionIds = new Set<string>();
  private readonly fileRevisionDispatches = new Set<string>();
  private shuttingDown = false;
  private readonly runtimeInterruptingSessions = new Set<string>();
  private readonly runtimeInterruptSubscription?: Subscription;

  constructor(
    private readonly agents: AgentsService,
    private readonly events: EventsService,
    private readonly memories: MemoryService,
    private readonly intentRecognition: IntentRecognitionService,
    private readonly orchestrator: OrchestratorService,
    private readonly execution: ExecutionService,
    private readonly tasks: TasksService,
    private readonly persistence: PersistenceService,
    private readonly capabilities: CapabilitiesService,
    @Optional() private readonly workflows?: WorkflowsService,
    @Optional() private readonly workflowRuntime?: WorkflowRuntimeService,
    @Optional() private readonly worktreeExecution?: WorktreeExecutionService,
    @Optional() private readonly workdirBrief?: WorkdirBriefService,
    @Optional() private readonly runtime?: RuntimeService,
    @Optional() private readonly localRuntime?: LocalRuntimeConnectionService,
    @Optional() private readonly workspaceProviders?: WorkspaceProviderResolver,
    @Optional() private readonly fileRevisions?: FileRevisionsService,
    @Optional() private readonly workspaceWritebacks?: WorkspaceWritebackService
  ) {
    const persisted = this.persistence.getCollection<SessionDetail[]>('sessions', []);
    let recoveredWorkspaceWriteback = false;
    for (const session of persisted) {
      this.assertCurrentSchema(session);
      if (this.recoverWorkspaceWritebackState(session)) recoveredWorkspaceWriteback = true;
      this.sessions.set(session.id, session);
    }
    if (recoveredWorkspaceWriteback) this.persist();
    for (const session of this.sessions.values()) {
      this.orchestrator.ensureArchitectureReportSaveConfirmation(session);
    }
    this.orchestrator.registerSavePendingInvocationCallback((sessionId, invocation) => {
      this.savePendingInvocation(sessionId, invocation);
    });
    this.capabilities.registerApprovalListener(({ sessionId, capabilityId }) =>
      this.retryPendingApprovalTasks(sessionId, capabilityId)
    );
    this.workflowRuntime?.updates().subscribe((update) => this.applyWorkflowRuntimeUpdate(update));
    this.runtimeInterruptSubscription = this.localRuntime?.interruptions().subscribe((interruption) => {
      void this.interruptForRuntimeDisconnect(interruption).catch((error) => {
        this.logger.error(`Failed to interrupt session ${interruption.sessionId} after Runtime disconnect: ${String(error)}`);
      });
    });
  }

  onModuleDestroy() {
    this.runtimeInterruptSubscription?.unsubscribe();
  }

  beforeApplicationShutdown(signal?: string) {
    this.shuttingDown = true;
    const occurredAt = nowIso();
    for (const session of this.sessions.values()) {
      this.interruptForServiceShutdown({
        sessionId: session.id,
        occurredAt,
        graceful: true,
        diagnosticRef: signal
      });
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
        requiresUserAction: [
          'WAIT_USER_CONFIRM',
          'WAIT_WORKFLOW_SELECT',
          'WAIT_WORKFLOW_STEP_CONFIRM',
          'WAIT_WORKSPACE_CONFLICT_RESOLUTION',
          'WAIT_USER_DECISION',
          'PAUSED',
          'INTERRUPTED'
        ].includes(session.status),
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
    if (this.workspaceWritebacks) session.workspaceWritebacks = this.workspaceWritebacks.list(sessionId);
    return session;
  }

  async resolveWorkspaceWriteback(
    sessionId: string,
    writebackId: string,
    input: ResolveWorkspaceWritebackInput
  ) {
    const session = this.get(sessionId);
    if (!this.workspaceWritebacks) throw new ServiceUnavailableException('Workspace writeback service is unavailable.');
    const writeback = await this.workspaceWritebacks.resolve(session, writebackId, input);
    session.workspaceWritebacks = this.workspaceWritebacks.list(sessionId);
    this.events.create({
      sessionId,
      type: writeback.status === 'applied' ? 'runtime_progress' : 'user_confirmation_resolved',
      content: writeback.status === 'applied'
        ? 'Workspace changes were applied successfully.'
        : `Workspace writeback is now ${writeback.status}.`,
      metadata: createMetadata('system_notice', { workspaceWriteback: writeback })
    });
    if (input.action === 'resolve_with_agent') {
      const conflictPaths = writeback.changeSet.changes
        .map((change) => change.operation === 'move' ? change.toPath : change.path)
        .join(', ');
      const instruction = `请重新处理工作区写回冲突。保留当前目录中的用户修改，并针对这些路径生成新的兼容变更：${conflictPaths}`;
      this.events.create({
        sessionId,
        type: 'user_message',
        userMessageIntent: 'correction',
        priority: 'high',
        content: instruction,
        metadata: createMetadata('chat_message', { text: instruction, workspaceWritebackId: writeback.id })
      });
      if (writeback.taskId) {
        const task = this.tasks.find(sessionId, writeback.taskId);
        if (task) this.tasks.update(task, { status: 'pending', resultSummary: instruction });
        await this.worktreeExecution?.resetTaskDirectory(sessionId, writeback.taskId);
      }
      const writebackState = this.workspaceWritebackAggregate(sessionId);
      if (writebackState === 'blocking') this.setStatus(session, 'WAIT_WORKSPACE_CONFLICT_RESOLUTION');
      else if (writebackState === 'in_flight') this.setStatus(session, 'APPLYING_CHANGES');
      else {
        this.setStatus(session, 'EXECUTING');
        this.resumeExecution(session);
      }
      return writeback;
    }
    if (writeback.status === 'applied' || writeback.status === 'abandoned') {
      const resultSummary = writeback.status === 'applied'
        ? writeback.resultSummary ?? 'Workspace changes were applied after conflict resolution.'
        : 'The isolated workspace changes were abandoned by the user.';
      const writebackState = this.workspaceWritebackAggregate(sessionId);
      if (writebackState === 'blocking') this.setStatus(session, 'WAIT_WORKSPACE_CONFLICT_RESOLUTION');
      else if (writebackState === 'in_flight') this.setStatus(session, 'APPLYING_CHANGES');
      if (writebackState === 'blocking' || writebackState === 'in_flight') return writeback;
      this.setStatus(session, 'EXECUTING');
      const resolved = this.workspaceWritebacks.list(sessionId)
        .filter((item) => item.status === 'applied' || item.status === 'abandoned');
      let acceptedWorkflowOutcome = false;
      for (const item of resolved) {
        if (!item.taskId) continue;
        const task = this.tasks.find(sessionId, item.taskId);
        if (!task || task.status !== 'waiting') continue;
        const itemSummary = item.status === 'applied'
          ? item.resultSummary ?? resultSummary
          : 'The isolated workspace changes were abandoned by the user.';
        this.tasks.update(task, { status: 'completed', resultSummary: itemSummary });
        if (session.workflowRunId && this.workflowRuntime) {
          await this.workflowRuntime.acceptExecutionOutcome(sessionId, {
            kind: 'workflow_step_completed',
            taskId: item.taskId,
            resultSummary: itemSummary
          });
          acceptedWorkflowOutcome = true;
        }
      }
      if (!acceptedWorkflowOutcome) this.resumeExecution(session);
    }
    return writeback;
  }

  listRaw() {
    return [...this.sessions.values()];
  }

  fileRevisionState(sessionId: string) {
    this.get(sessionId);
    return this.requireFileRevisions().state(sessionId);
  }

  fileRevisionCandidate(sessionId: string, revisionId: string) {
    this.get(sessionId);
    return this.requireFileRevisions().getCandidate(sessionId, revisionId);
  }

  fileRevisionDraft(sessionId: string, revisionId: string) {
    this.get(sessionId);
    return this.requireFileRevisions().getDraft(sessionId, revisionId);
  }

  async saveFileRevisionDraft(sessionId: string, revisionId: string, input: SaveFileRevisionDraftInput) {
    const session = this.get(sessionId);
    const draft = await this.requireFileRevisions().saveDraft(
      sessionId,
      revisionId,
      input,
      { type: 'user', id: session.ownerId }
    );
    this.events.create({
      sessionId,
      type: 'file_revision_draft_saved',
      content: '文件修订草稿已保存。',
      metadata: createMetadata('system_notice', {
        chainId: draft.chainId,
        revisionId: draft.sourceRevisionId,
        candidateHash: draft.sourceCandidateHash,
        draftHash: draft.contentHash,
        sizeBytes: draft.sizeBytes
      })
    });
    this.touchSession(session);
    return draft;
  }

  async captureFileRevisionBaseline(sessionId: string, input: CaptureFileRevisionBaselineInput) {
    const session = this.get(sessionId);
    if (this.hasActiveSessionWork(session)) {
      throw new ConflictException('Wait for the active session work to finish before capturing a file baseline.');
    }
    const baseline = await this.requireFileRevisions().captureBaseline(session, input);
    this.events.create({
      sessionId,
      type: 'file_revision_baseline_captured',
      content: `已记录文件修订基线：${baseline.filePath}`,
      metadata: createMetadata('system_notice', {
        baselineId: baseline.id,
        filePath: baseline.filePath,
        hash: baseline.hash,
        sizeBytes: baseline.sizeBytes,
        source: baseline.source
      })
    });
    this.touchSession(session);
    return baseline;
  }

  async startFileRevision(sessionId: string, input: CreateFileRevisionRunInput) {
    const session = this.get(sessionId);
    if (this.shuttingDown) throw new ServiceUnavailableException('The server is shutting down.');
    if (this.hasActiveSessionWork(session)) {
      throw new ConflictException('Wait for the active session work to finish before processing a file revision.');
    }
    const revisions = this.requireFileRevisions();
    const unfinished = revisions.listChains(sessionId).find((chain) =>
      ['active', 'applying'].includes(chain.status)
    );
    if (unfinished) {
      throw new ConflictException(`Resolve the existing file revision first: ${unfinished.id}`);
    }
    const receiver = this.agents.findByIdOrKey('coordinator');
    if (!receiver || receiver.status !== 'active') {
      throw new BadRequestException(
        'REVISION_RECEIVER_UNAVAILABLE: the active system default Receiver is required for file revision processing.'
      );
    }
    const participantIds = new Set(session.participatingAgentIds);
    const targetAgents = [...new Set(input.targetAgentIds ?? [])].map((agentId) => {
      const agent = this.agents.getByIdOrKey(agentId);
      if (!participantIds.has(agent.id)) throw new BadRequestException(`Agent is not part of this session: ${agentId}`);
      if (agent.status !== 'active') throw new BadRequestException(`Agent is not active: ${agent.name}`);
      if (agent.key === 'coordinator') throw new BadRequestException('The receiver cannot be selected as a processing Agent.');
      return agent;
    });
    if (targetAgents.length === 0) throw new BadRequestException('Select at least one processing Agent.');
    const run = await revisions.createRun(session, {
      baselineId: input.baselineId,
      targetAgentIds: targetAgents.map((agent) => agent.id),
      instruction: input.instruction
    });
    this.events.create({
      sessionId,
      type: 'file_revision_chain_created',
      toAgentIds: run.targetAgentIds,
      content: `用户已确认处理 ${run.filePath} 的修订。`,
      metadata: createMetadata('system_notice', {
        revisionId: run.id,
        chainId: run.chainId,
        iteration: run.iteration,
        baselineId: run.baselineId,
        filePath: run.filePath,
        baseHash: run.baseHash,
        userDraftHash: run.userDraftHash,
        diffHash: run.diffHash,
        diffSummary: run.diffSummary,
        targetAgentIds: run.targetAgentIds
      })
    });
    this.setStatus(session, 'EXECUTING');
    this.dispatchFileRevisionProcessing(session, run.id);
    return run;
  }

  async reprocessFileRevision(sessionId: string, revisionId: string, input: ReprocessFileRevisionInput) {
    const session = this.get(sessionId);
    if (this.shuttingDown) throw new ServiceUnavailableException('The server is shutting down.');
    const targetAgentIds = input.targetAgentIds === undefined
      ? undefined
      : this.validateFileRevisionAgents(session, input.targetAgentIds).map((agent) => agent.id);
    const run = await this.requireFileRevisions().reprocess(sessionId, revisionId, {
      ...input,
      ...(targetAgentIds ? { targetAgentIds } : {})
    });
    const alreadyAnnounced = this.events.list(sessionId).some((event) =>
      event.type === 'file_revision_iteration_submitted' &&
      (event.metadata.payload as { revisionId?: string } | undefined)?.revisionId === run.id
    );
    if (!alreadyAnnounced) this.events.create({
      sessionId,
      type: 'file_revision_candidate_superseded',
      content: '上一轮候选已由用户修改稿取代。',
      metadata: createMetadata('system_notice', {
        chainId: run.chainId,
        revisionId: run.parentRevisionId,
        supersededByRevisionId: run.id,
        iteration: run.iteration
      })
    });
    if (!alreadyAnnounced) this.events.create({
      sessionId,
      type: 'file_revision_iteration_submitted',
      toAgentIds: run.targetAgentIds,
      content: `已提交第 ${run.iteration} 轮文件修订处理。`,
      metadata: createMetadata('system_notice', {
        chainId: run.chainId,
        revisionId: run.id,
        parentRevisionId: run.parentRevisionId,
        iteration: run.iteration,
        baseHash: run.baseHash,
        userDraftHash: run.userDraftHash,
        diffHash: run.diffHash,
        targetAgentIds: run.targetAgentIds
      })
    });
    this.setStatus(session, 'EXECUTING');
    this.dispatchFileRevisionProcessing(session, run.id);
    return run;
  }

  async resolveFileRevisionFailure(
    sessionId: string,
    revisionId: string,
    input: ResolveFileRevisionFailureInput
  ) {
    const session = this.get(sessionId);
    if (this.shuttingDown) throw new ServiceUnavailableException('The server is shutting down.');
    const resolved = await this.requireFileRevisions().resolvePartialFailure(sessionId, revisionId, input);
    this.events.create({
      sessionId,
      type: 'file_revision_failure_resolved',
      content: input.decision === 'retry_agents'
        ? '已按用户决定重新运行本轮全部 Agent。'
        : input.decision === 'continue_with_successful'
          ? '已按用户决定使用成功结果继续由 Receiver 生成候选。'
          : '已按用户决定放弃本次文件修订。',
      metadata: createMetadata('system_notice', {
        chainId: resolved.chain.id,
        revisionId,
        decision: input.decision,
        stateVersion: resolved.chain.stateVersion,
        successfulAgentCount: resolved.run.agentResults.filter((result) => result.status === 'completed').length,
        failedAgentCount: resolved.run.agentResults.filter((result) => result.status === 'failed').length
      })
    });
    if (input.decision === 'abandon_revision') {
      this.setStatus(session, 'COMPLETED');
      return resolved;
    }
    this.setStatus(session, 'EXECUTING');
    this.dispatchFileRevisionProcessing(
      session,
      revisionId,
      input.decision === 'continue_with_successful' ? 'continue_with_successful' : 'run_agents'
    );
    return resolved;
  }

  async retryInterruptedFileRevision(
    sessionId: string,
    revisionId: string,
    input: RetryInterruptedFileRevisionInput
  ) {
    const session = this.get(sessionId);
    const retried = await this.requireFileRevisions().retryInterrupted(session, revisionId, input);
    this.events.createOnce(`file-revision-retry:${revisionId}:${input.retryKey}`, {
      sessionId,
      type: 'file_revision_dispatched',
      content: retried.mode === 'apply_reconcile'
        ? '文件修订已恢复，系统已根据当前 Workspace 状态完成写回结果核对。'
        : retried.mode === 'receiver_only'
          ? '文件修订已恢复，Receiver 将基于已完成的 Agent 结果重新生成候选。'
          : '文件修订已恢复，目标 Agent 将重新处理本轮修订。',
      metadata: createMetadata('system_notice', {
        revisionId,
        chainId: retried.run.chainId,
        retryKey: input.retryKey,
        retryMode: retried.mode,
        stateVersion: retried.chain.stateVersion
      })
    });
    if (retried.mode === 'apply_reconcile') {
      this.setStatus(session, retried.run.status === 'awaiting_confirmation' ? 'WAIT_USER_DECISION' : 'COMPLETED');
      return retried;
    }
    this.setStatus(session, 'EXECUTING');
    this.dispatchFileRevisionProcessing(
      session,
      revisionId,
      retried.mode === 'receiver_only' ? 'continue_with_successful' : 'run_agents'
    );
    return retried;
  }

  private dispatchFileRevisionProcessing(
    session: SessionDetail,
    revisionId: string,
    mode: 'run_agents' | 'continue_with_successful' = 'run_agents'
  ) {
    const sessionId = session.id;
    const revisions = this.requireFileRevisions();
    const run = revisions.getRun(sessionId, revisionId);
    const dispatchable = mode === 'run_agents'
      ? ['submitted', 'interrupted'].includes(run.status)
      : run.status === 'processing';
    if (!dispatchable || this.fileRevisionDispatches.has(revisionId)) return;
    this.fileRevisionDispatches.add(revisionId);
    const processing = mode === 'continue_with_successful'
      ? this.orchestrator.continueFileRevisionAfterPartialFailure(session, revisionId)
      : this.orchestrator.processFileRevision(session, revisionId);
    void processing
      .then(() => {
        const current = this.sessions.get(sessionId);
        if (!current || this.deletingSessionIds.has(sessionId)) return;
        this.setStatus(current, 'WAIT_USER_DECISION');
      })
      .catch(async (error) => {
        const current = this.sessions.get(sessionId);
        if (!current || this.deletingSessionIds.has(sessionId)) return;
        const message = error instanceof Error ? error.message : String(error);
        const code = message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] ?? 'REVISION_PROCESSING_FAILED';
        const publicMessage = code === 'REVISION_PARTIAL_AGENT_FAILURE'
          ? 'Some selected Agents did not return a valid complete proposal.'
          : 'File revision processing failed. Retry or abandon this revision.';
        const failedRun = await revisions.markFailed(sessionId, revisionId, code, publicMessage).catch(() => undefined);
        this.events.create({
          sessionId,
          type: 'file_revision_failed',
          priority: 'high',
          content: '文件修订处理失败，请选择重试或放弃本轮修订。',
          metadata: createMetadata('error_card', { revisionId, code })
        });
        if (code === 'REVISION_PARTIAL_AGENT_FAILURE' && failedRun) {
          const chain = revisions.getChain(sessionId, failedRun.chainId);
          const successfulAgentCount = failedRun.agentResults.filter((result) => result.status === 'completed').length;
          const failedAgentCount = failedRun.agentResults.filter((result) => result.status === 'failed').length;
          this.events.create({
            sessionId,
            type: 'file_revision_failure_decision_requested',
            priority: 'high',
            content: '部分 Agent 处理失败，请明确选择重试、使用成功结果继续，或放弃修订。',
            metadata: createMetadata('confirmation_card', {
              revisionId,
              chainId: failedRun.chainId,
              stateVersion: chain.stateVersion,
              successfulAgentCount,
              failedAgentCount,
              options: [
                { key: 'retry_agents', label: '重试全部 Agent', style: 'primary' },
                ...(successfulAgentCount > 0
                  ? [{ key: 'continue_with_successful', label: '使用成功结果继续', style: 'default' }]
                  : []),
                { key: 'abandon_revision', label: '放弃修订', style: 'danger' }
              ]
            })
          });
          this.setStatus(current, 'WAIT_USER_DECISION');
        } else {
          this.setStatus(current, 'COMPLETED');
        }
      })
      .finally(() => this.fileRevisionDispatches.delete(revisionId));
  }

  async decideFileRevision(sessionId: string, revisionId: string, input: DecideFileRevisionInput) {
    const session = this.get(sessionId);
    const revisions = this.requireFileRevisions();
    const run = revisions.getRun(sessionId, revisionId);
    if (run.confirmationId !== input.confirmationId) {
      throw new BadRequestException('File revision confirmation does not match the active run.');
    }
    if (
      input.decision === 'apply_candidate' &&
      run.status === 'applied' &&
      run.candidateHash?.algorithm === input.candidateHash.algorithm &&
      run.candidateHash.value === input.candidateHash.value
    ) {
      this.setStatus(session, 'COMPLETED');
      return { run, applied: true, idempotentReplay: true };
    }
    this.assertPendingConfirmation(sessionId, input.confirmationId, 'confirm_file_revision_apply');

    if (input.decision === 'abandon_revision') {
      const resolved = await revisions.abandon(sessionId, revisionId, input);
      this.events.create({
        sessionId,
        type: 'user_confirmation_resolved',
        content: '已保留用户直接修订的文件，未写入 Agent 候选结果。',
        metadata: createMetadata('system_notice', {
          confirmationId: input.confirmationId,
          reason: 'confirm_file_revision_apply',
          decision: input.decision,
          revisionId
        })
      });
      this.setStatus(session, 'COMPLETED');
      return { run: resolved, applied: false };
    }

    this.events.createOnce(`file-revision-apply-started:${input.confirmationId}:${revisionId}:${input.candidateHash.value}`, {
      sessionId,
      type: 'file_revision_apply_started',
      content: `开始校验并写回文件修订候选：${run.filePath}`,
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        chainId: run.chainId,
        revisionId,
        iteration: run.iteration,
        filePath: run.filePath,
        candidateHash: input.candidateHash,
        expectedStateVersion: input.expectedStateVersion
      })
    });
    const applied = await revisions.applyCandidate(session, revisionId, input);
    this.events.createOnce(`file-revision-confirmation-resolved:${input.confirmationId}:${input.decision}`, {
      sessionId,
      type: 'user_confirmation_resolved',
      content: applied.applied ? '已确认应用 Agent 候选结果。' : '写回前检测到文件已变化，未覆盖原文件。',
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        reason: 'confirm_file_revision_apply',
        decision: input.decision,
        revisionId,
        candidateHash: input.candidateHash,
        applied: applied.applied
      })
    });
    if (!applied.applied) {
      const conflicts = applied.result.ok ? [] : applied.result.conflicts;
      this.events.create({
        sessionId,
        type: 'file_revision_stale',
        priority: 'high',
        content: '原文件在修订快照后再次变化，系统未执行覆盖。',
        metadata: createMetadata('error_card', {
          revisionId,
          filePath: run.filePath,
          conflicts
        })
      });
      this.setStatus(session, 'COMPLETED');
      return { run: applied.run, applied: false, conflicts };
    }
    this.events.createOnce(`file-revision-applied:${revisionId}:${input.candidateHash.value}`, {
      sessionId,
      type: 'file_revision_applied',
      content: `已安全写回文件：${run.filePath}`,
      metadata: createMetadata('system_notice', {
        revisionId,
        filePath: run.filePath,
        changeSetId: applied.changeSet.id,
        workspaceRevision: applied.result.revision,
        baselineId: applied.baseline?.id,
        persistenceRecoveryRequired: applied.persistenceRecoveryRequired,
        postApplyBaselineStatus: applied.chain.postApplyBaselineStatus
      })
    });
    if (applied.baseline) {
      this.events.create({
        sessionId,
        type: 'file_revision_baseline_captured',
        content: `已将写回结果记录为新基线：${applied.baseline.filePath}`,
        metadata: createMetadata('system_notice', {
          baselineId: applied.baseline.id,
          filePath: applied.baseline.filePath,
          hash: applied.baseline.hash,
          source: applied.baseline.source
        })
      });
    }
    this.setStatus(session, 'COMPLETED');
    return { run: applied.run, applied: true, baseline: applied.baseline };
  }

  async recoverFileRevisions() {
    const recovered: Array<{ sessionId: string; revisionId: string; from: string; to: string }> = [];
    for (const session of this.listRaw()) {
      const items = await this.requireFileRevisions().recoverSession(session);
      for (const item of items) recovered.push({ sessionId: session.id, ...item });
    }
    return recovered;
  }

  async delete(sessionId: string) {
    this.persistence.assertWritable();
    if (this.shuttingDown) {
      throw new ServiceUnavailableException('后端正在关闭，请在服务重启后重试删除。');
    }
    const session = this.get(sessionId);
    if (this.deletingSessionIds.has(sessionId)) {
      throw new ConflictException(`Session deletion is already in progress: ${sessionId}`);
    }

    this.deletingSessionIds.add(sessionId);
    try {
      const termination = createExecutionTermination({
        kind: 'user_cancelled',
        source: 'user',
        scope: 'session',
        diagnosticRef: 'session_delete'
      });
      // Invalidate background brief callbacks before requesting termination so
      // a late completion cannot recreate state while deletion is in progress.
      this.briefGenerationSeqBySession.set(
        sessionId,
        (this.briefGenerationSeqBySession.get(sessionId) ?? 0) + 1
      );
      const briefRun = this.briefGenerationRuns.get(sessionId);
      if (briefRun) abortWithTermination(briefRun.controller, termination);
      const workflowCancellation = session.workflowRunId && this.workflowRuntime
        ? this.workflowRuntime.cancel(session.workflowRunId, '会话删除前终止工作流。')
        : Promise.resolve();
      const executionCancellation = this.execution.cancelAndWait(sessionId, termination);
      const runtimeCancellation = this.runtime?.cancelSessionAndWait(sessionId, termination) ??
        Promise.resolve({ requested: 0, completed: 0, timedOut: false });
      const briefStopped = briefRun ? await settlesWithin(briefRun.done, 10_000) : true;
      const [executionStopped, runtimeStopped] = await Promise.all([
        executionCancellation,
        runtimeCancellation,
        workflowCancellation
      ]);
      if (!briefStopped || executionStopped.timedOut || runtimeStopped.timedOut) {
        throw new ConflictException(
          `Session runtime did not stop within the deletion grace period: ${sessionId}`
        );
      }

      await this.worktreeExecution?.deleteSessionDirectory(sessionId);
      this.workdirBrief?.deleteSessionDirectory(sessionId);
      this.sessions.delete(sessionId);
      this.briefGenerationSeqBySession.delete(sessionId);
      this.briefGenerationRuns.delete(sessionId);
      this.tasks.deleteSession(sessionId);
      this.memories.deleteSession(sessionId);
      this.events.deleteSession(sessionId);
      this.orchestrator.deleteSession(sessionId);
      await this.fileRevisions?.deleteSession(sessionId);
      this.persist();
      return { deleted: true, sessionId: session.id };
    } finally {
      this.deletingSessionIds.delete(sessionId);
    }
  }

  async interruptForRuntimeDisconnect(interruption: {
    sessionId: string;
    invocationId: string;
    reason: 'local_runtime_disconnected';
    occurredAt: string;
  }) {
    return this.interruptForWorkspaceDisconnect(interruption);
  }

  interruptForServiceShutdown(interruption: {
    sessionId: string;
    invocationId?: string;
    occurredAt: string;
    graceful: boolean;
    diagnosticRef?: string;
  }) {
    const session = this.sessions.get(interruption.sessionId);
    if (!session || !ACTIVE_INVOCATION_SESSION_STATUSES.has(session.status)) return false;

    const termination = createExecutionTermination({
      kind: 'service_shutdown',
      source: 'system',
      scope: 'service',
      graceful: interruption.graceful,
      ...(interruption.diagnosticRef ? { diagnosticRef: interruption.diagnosticRef } : {})
    });
    this.markSessionInterrupted(
      session,
      {
        reason: 'service_shutdown',
        invocationId: interruption.invocationId,
        occurredAt: interruption.occurredAt
      },
      termination,
      'Platform backend stopped; waiting for a future user wake-up.',
      '平台后端连接已中断，本次调用不会自动续跑。会话上下文已保留，可在后续唤醒功能中继续。'
    );
    return true;
  }

  async create(input: CreateSessionInput) {
    const startedAt = Date.now();
    try {
      this.persistence.assertWritable();
      const dataEpoch = this.persistence.currentDataEpoch();
      const now = nowIso();
      const participatingAgentIds = this.agents.resolveIds(input.agentIds);
      const workspaceBinding = await this.resolveWorkspaceBinding(input);
      const workspaceId = workspaceBinding.workingDirectory?.id ?? 'default-workspace';

      const sessionId = crypto.randomUUID();
      const leaseAcquired = await this.persistence.acquireWorkspaceSessionLease(workspaceId, sessionId);
      if (!leaseAcquired) {
        throw new ConflictException(`Workspace ${workspaceId} is already bound to an active session. Only one session per workspace is allowed.`);
      }
      const recognizedIntent = this.intentRecognition.recognizeTask(input.input);
      const session: SessionDetail = {
      id: sessionId,
      dataEpoch,
      title: this.titleFromInput(input.input),
      originalInput: input.input,
      status: 'AGENT_DISCUSSING',
      ownerId: 'local-user',
      workspaceId,
      projectId: input.projectId,
      origin: input.origin ?? 'user',
      autopilotRunId: input.autopilotRunId,
      knowledgeBaseIds: input.knowledgeBaseIds ?? [],
      workingDirectory: workspaceBinding.workingDirectory,
      workspaceContext: workspaceBinding.workspaceContext,
      runtimePreference: this.normalizeRuntimePreference(input.runtimePreference),
      tokenBudget: input.tokenBudget,
      tokenUsed: 0,
      taskDomain: recognizedIntent.domain,
      taskIntent: recognizedIntent.intent,
      requiresCodeChanges: recognizedIntent.requiresCodeChanges,
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
          mentionedAgentIds: participatingAgentIds,
          origin: session.origin,
          autopilotRunId: session.autopilotRunId
        })
      });

      this.generateBriefInBackground(session);

      return { session, firstEvent };
    } finally {
      workspaceMetrics.observe('session_create_duration_ms', Date.now() - startedAt);
    }
  }

  private async resolveWorkspaceBinding(input: CreateSessionInput) {
    if ('workspaceSnapshot' in input) {
      throw new BadRequestException('workspaceSnapshot is server-generated and cannot be supplied when creating a Session.');
    }
    const requestedKind = (input.workingDirectory as { kind?: string } | undefined)?.kind;
    if (requestedKind && requestedKind !== 'local_bridge' && requestedKind !== 'server_local') {
      throw new BadRequestException('workingDirectory.kind must be local_bridge or server_local.');
    }
    if (input.workingDirectory?.kind === 'local_bridge') {
      if (input.workingDirectory.path) {
        throw new BadRequestException('local_bridge workingDirectory must not expose a server-accessible path.');
      }
      const registration = this.localRuntime?.getWorkspace(input.workingDirectory.id);
      if (!registration) {
        throw new BadRequestException(`Local Runtime workspace is not connected: ${input.workingDirectory.id}`);
      }
      if (registration.displayName !== input.workingDirectory.name) {
        throw new BadRequestException('Local Runtime workspace name does not match its registered workspaceId.');
      }
      return {
        workingDirectory: input.workingDirectory,
        workspaceContext: {
          binding: {
            workspaceId: registration.workspaceId,
            providerKind: 'local_bridge',
            displayName: registration.displayName,
            capabilities: registration.capabilities,
            boundRevision: registration.revision,
            boundAt: nowIso()
          },
          indexComplete: registration.index?.complete ?? false,
          ...(registration.index
            ? {
                indexGeneration: registration.index.generation,
                indexRevision: registration.index.revision
              }
            : {})
        } satisfies SessionWorkspaceContext
      };
    }
    if (input.workingDirectory?.kind === 'server_local') {
      const path = input.workingDirectory.path?.trim();
      if (!path) {
        throw new BadRequestException('server_local workingDirectory requires an absolute path.');
      }
      try {
        const workingDirectory = await validateServerLocalWorkspace(input.workingDirectory);
        const provider = this.workspaceProviders?.resolveWorkingDirectory(workingDirectory);
        if (!provider) throw new Error('Server workspace provider is unavailable.');
        const revision = await provider.getRevision();
        return {
          workingDirectory,
          workspaceContext: {
            binding: {
              workspaceId: workingDirectory.id,
              providerKind: 'server_local',
              displayName: workingDirectory.name,
              capabilities: provider.capabilities(),
              boundRevision: revision,
              boundAt: nowIso()
            },
            indexComplete: false
          } satisfies SessionWorkspaceContext
        };
      } catch (error) {
        throw new BadRequestException(
          `Invalid server_local working directory: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return {
      workingDirectory: input.workingDirectory,
      workspaceContext: undefined
    };
  }

  private generateBriefInBackground(session: SessionDetail) {
    const generationSeq = (this.briefGenerationSeqBySession.get(session.id) ?? 0) + 1;
    this.briefGenerationSeqBySession.set(session.id, generationSeq);
    const previousRun = this.briefGenerationRuns.get(session.id);
    if (previousRun) {
      abortWithTermination(
        previousRun.controller,
        createExecutionTermination({ kind: 'superseded', source: 'orchestrator', scope: 'phase' })
      );
    }
    const controller = new AbortController();
    const done = this.orchestrator
      .discussAndCreateBrief(session, controller.signal)
      .then((brief) => {
        if (
          controller.signal.aborted ||
          this.deletingSessionIds.has(session.id) ||
          this.briefGenerationSeqBySession.get(session.id) !== generationSeq
        ) {
          return;
        }
        session.currentTaskBriefId = brief.id;
        this.setStatus(session, 'WAIT_USER_CONFIRM');
        if (session.origin === 'autopilot') {
          void this.confirmBrief(session.id, brief.id).catch((error) =>
            this.failSessionWithFullError(session, error, 'autopilot_auto_confirm')
          );
        }
      })
      .catch((error) => {
        if (controller.signal.aborted || this.deletingSessionIds.has(session.id)) return;
        this.failSessionWithFullError(session, error, 'brief_generation');
      })
      .finally(() => {
        if (this.briefGenerationRuns.get(session.id)?.controller === controller) {
          this.briefGenerationRuns.delete(session.id);
        }
      });
    this.briefGenerationRuns.set(session.id, { controller, done });
    void done;
  }

  async sendMessage(sessionId: string, content: string, mentionedAgentIds: string[] = []) {
    const session = this.get(sessionId);
    const receiverRecognitionPending = session.status === 'PAUSED';
    let handlingPlan: UserMessageHandlingPlan = receiverRecognitionPending
      ? this.intentRecognition.recognizeUserMessage(content, session.status)
      : await this.recognizeFollowUpHandlingPlan(session, content, mentionedAgentIds);
    handlingPlan = this.normalizeFollowUpHandlingPlan(session, handlingPlan);
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
    const deferred = this.hasActiveSessionWork(session);
    this.events.create({
      sessionId,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      toAgentIds: mentionedAgentIds,
      content: receiverRecognitionPending
        ? '会话已停止，消息已加入等待队列；继续后再由接收者进行意图识别和任务拆分。'
        : deferred
          ? `接收者已完成意图识别。当前任务结束后再进行任务拆分与派发：${handlingPlan.coordinatorInstruction}`
          : `接收者已完成意图识别，开始进行任务拆分与派发：${handlingPlan.coordinatorInstruction}`,
      metadata: createMetadata('chat_message', {
        messageKind: 'decision',
        handlingPlan,
        deferred,
        receiverRecognitionPending,
        receiverResponsibilities: ['intent_recognition', 'task_decomposition']
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

    const followUp: SessionFollowUpMessage = {
      id: crypto.randomUUID(),
      sourceEventId: event.id,
      content,
      mentionedAgentIds: Array.from(new Set(mentionedAgentIds)),
      handlingPlan,
      receiverRecognitionPending: receiverRecognitionPending || undefined,
      status: 'queued',
      queuedAt: nowIso()
    };
    session.pendingFollowUpMessages = [...(session.pendingFollowUpMessages ?? []), followUp];
    this.touchSession(session);

    if (deferred) {
      this.events.create({
        sessionId,
        type: 'session_status_changed',
        content: '后续需求已进入等待队列，将在当前任务结束后执行。',
        metadata: createMetadata('system_notice', {
          status: session.status,
          reason: 'follow_up_deferred_until_current_task_finishes',
          followUpMessageId: followUp.id,
          sourceEventId: event.id,
          mentionedAgentIds: followUp.mentionedAgentIds
        })
      });
    } else {
      this.scheduleFollowUpPlanning(session.id);
    }

    return { event, handlingPlan, deferred, followUpMessageId: followUp.id };
  }

  private async recognizeFollowUpHandlingPlan(
    session: SessionDetail,
    content: string,
    mentionedAgentIds: string[]
  ): Promise<UserMessageHandlingPlan> {
    try {
      return await this.orchestrator.recognizeFollowUpMessage(session, content, mentionedAgentIds);
    } catch (error) {
      this.logger.warn(`Receiver Runtime intent recognition failed for session ${session.id}: ${String(error)}`);
      return this.intentRecognition.recognizeUserMessage(content, session.status);
    }
  }

  async confirmBrief(sessionId: string, briefId: string) {
    const session = this.get(sessionId);
    if (session.currentTaskBriefId !== briefId) {
      throw new BadRequestException(`Brief is not current: ${briefId}`);
    }
    const brief = this.orchestrator.confirmBrief(session, briefId);
    session.currentTaskBriefId = brief.id;
    const availableWorkflows = this.workflows?.list().filter((workflow) => workflow.status === 'published') ?? [];
    this.setStatus(session, 'WAIT_WORKFLOW_SELECT');
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    this.events.create({
      sessionId,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      content: '任务契约已确认。请选择并检查本次执行使用的 Agent 工作流。',
      metadata: createMetadata('chat_message', {
        messageKind: 'decision',
        phase: 'workflow_selection',
        relatedBriefId: brief.id
      })
    });
    const confirmationId = crypto.randomUUID();
    this.events.create({
      sessionId,
      type: 'user_confirmation_requested',
      priority: 'high',
      content: '请选择工作流后开始执行。',
      metadata: createMetadata('confirmation_card', {
        confirmationId,
        reason: 'select_workflow',
        title: '选择执行工作流',
        description: '任务契约已确认，工作流确定 Agent 的执行顺序。',
        relatedBriefId: brief.id,
        workflowOptions: availableWorkflows.map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          version: workflow.currentPublishedVersion ?? workflow.version,
          nodeCount: workflow.nodes.length,
          agentCount: workflow.nodes.filter((node) => node.type === 'agent').length,
          humanApprovalCount: workflow.nodes.filter((node) => node.type === 'human_approval').length,
          robotApprovalCount: workflow.nodes.filter((node) => node.type === 'robot_approval').length,
          status: workflow.status
        })),
        options: availableWorkflows.length
          ? [{ key: 'open_workflow_selector', label: '选择工作流', style: 'primary' }]
          : [{ key: 'manage_workflows', label: '创建工作流', style: 'primary' }]
      })
    });
    return { accepted: true, sessionId: session.id, status: session.status, confirmationId };
  }

  async selectWorkflow(
    sessionId: string,
    input: { workflowId: string; workflowVersion?: number; confirmationId: string }
  ) {
    const session = this.get(sessionId);
    if (session.status !== 'WAIT_WORKFLOW_SELECT') {
      throw new BadRequestException(`Workflow selection requires WAIT_WORKFLOW_SELECT: ${session.status}`);
    }
    if (!this.workflows || !this.workflowRuntime) throw new BadRequestException('Workflow runtime is unavailable.');
    this.assertPendingConfirmation(sessionId, input.confirmationId, 'select_workflow');
    const workflow = this.workflows.get(input.workflowId);
    if (workflow.status !== 'published') throw new BadRequestException('Only published workflows can be executed.');
    const briefId = session.currentTaskBriefId;
    const brief = briefId ? this.orchestrator.getBrief(session.id, briefId) : undefined;
    if (!brief) throw new BadRequestException('Current confirmed brief is missing.');
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    const version = this.workflows.getVersion(workflow.id, input.workflowVersion);
    session.participatingAgentIds = Array.from(new Set([...session.participatingAgentIds, ...version.involvedAgentIds]));
    if (this.isEmptyWorkspace(session) && session.workspaceMode !== 'bootstrap') {
      const confirmationId = crypto.randomUUID();
      session.workspaceMode = 'empty_pending_decision';
      session.pendingBootstrapWorkflow = {
        workflowId: workflow.id,
        workflowVersion: version.version,
        selectionConfirmationId: input.confirmationId
      };
      this.setStatus(session, 'WAIT_USER_DECISION');
      this.events.create({
        sessionId: session.id,
        type: 'user_confirmation_requested',
        priority: 'high',
        content: `当前工作区“${session.workingDirectory?.name ?? session.workspaceSnapshot?.rootName ?? 'workspace'}”为空，请确认是否初始化新项目。`,
        metadata: createMetadata('confirmation_card', {
          confirmationId,
          reason: 'initialize_empty_workspace',
          title: '当前工作区为空',
          description: '可以从零创建项目文件。初始化确认不会自动安装依赖或执行命令，这些操作仍需再次确认。',
          options: [
            { key: 'initialize_project', label: '初始化新项目', style: 'primary' },
            { key: 'reselect_workspace', label: '重新选择目录', style: 'default' },
            { key: 'cancel', label: '取消任务', style: 'danger' }
          ],
          workflowId: workflow.id,
          workflowName: workflow.name
        })
      });
      return { session, workflow, workflowRun: undefined, createdTasks: [] };
    }
    const run = await this.workflowRuntime.start({
      session,
      brief,
      coordinatorId: coordinator.id,
      workflowId: workflow.id,
      workflowVersion: version.version,
      confirmationId: input.confirmationId
    });
    session.workflowRunId = run.id;
    this.setStatus(session, 'EXECUTING');
    const createdTasks = this.tasks.list(session.id).filter((task) => task.workflowRunId === run.id);
    return { session, workflow, workflowRun: run, createdTasks };
  }

  async resolveEmptyWorkspaceDecision(
    sessionId: string,
    input: {
      confirmationId: string;
      decision: 'initialize_project' | 'reselect_workspace' | 'cancel';
    }
  ) {
    const session = this.get(sessionId);
    if (session.status !== 'WAIT_USER_DECISION' || session.workspaceMode !== 'empty_pending_decision') {
      throw new BadRequestException(`Empty workspace decision is not pending: ${session.status}`);
    }
    this.assertPendingConfirmation(sessionId, input.confirmationId, 'initialize_empty_workspace');
    this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: `用户处理空工作区：${input.decision}`,
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: input.decision === 'initialize_project' ? 'approved' : 'rejected',
        selectedOptionKey: input.decision
      })
    });
    if (input.decision === 'cancel') {
      session.pendingBootstrapWorkflow = undefined;
      this.setStatus(session, 'CANCELLED');
      return { session };
    }
    if (input.decision === 'reselect_workspace') {
      session.workspaceMode = undefined;
      session.pendingBootstrapWorkflow = undefined;
      this.setStatus(session, 'WAIT_WORKFLOW_SELECT');
      return { session };
    }
    const pending = session.pendingBootstrapWorkflow;
    if (!pending || !this.workflows || !this.workflowRuntime) {
      throw new BadRequestException('Pending bootstrap workflow is unavailable.');
    }
    const briefId = session.currentTaskBriefId;
    const brief = briefId ? this.orchestrator.getBrief(session.id, briefId) : undefined;
    if (!brief) throw new BadRequestException('Current confirmed brief is missing.');
    const workflow = this.workflows.get(pending.workflowId);
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    session.workspaceMode = 'bootstrap';
    session.pendingBootstrapWorkflow = undefined;
    const run = await this.workflowRuntime.start({
      session,
      brief,
      coordinatorId: coordinator.id,
      workflowId: workflow.id,
      workflowVersion: pending.workflowVersion,
      confirmationId: pending.selectionConfirmationId
    });
    session.workflowRunId = run.id;
    this.setStatus(session, 'EXECUTING');
    const createdTasks = this.tasks.list(session.id).filter((task) => task.workflowRunId === run.id);
    return { session, workflow, workflowRun: run, createdTasks };
  }

  async resolveWorkflowHumanDecision(
    sessionId: string,
    runId: string,
    nodeRunId: string,
    input: {
      confirmationId: string;
      expectedRunRevision?: number;
      decision: 'approve' | 'revise' | 'cancel';
      instruction?: string;
    }
  ) {
    const session = this.get(sessionId);
    if (!this.workflowRuntime) throw new BadRequestException('Workflow runtime is unavailable.');
    if (session.workflowRunId !== runId) throw new BadRequestException(`Workflow run is not active for session: ${runId}`);
    const result = await this.workflowRuntime.decideHuman({
      runId,
      nodeRunId,
      confirmationId: input.confirmationId,
      userId: session.ownerId,
      expectedRunRevision: input.expectedRunRevision,
      decision: input.decision,
      instruction: input.instruction
    });
    this.touchSession(session);
    return { session, ...result };
  }

  async applyQueuedExecutionOutcome(sessionId: string, outcome: ExecutionOutcome) {
    const session = this.sessions.get(sessionId);
    if (session?.activeFollowUpMessageId) {
      this.applyFollowUpOutcome(sessionId, session.activeFollowUpMessageId, outcome);
      return;
    }
    if (await this.workflowRuntime?.acceptExecutionOutcome(sessionId, outcome)) return;
    this.applyOutcome(sessionId, outcome);
  }

  resolveWorkflowStep(
    sessionId: string,
    input: {
      confirmationId: string;
      taskId: string;
      decision: 'approve' | 'revise';
      instruction?: string;
    }
  ) {
    const session = this.get(sessionId);
    const run = session.workflowRun;
    if (session.status !== 'WAIT_WORKFLOW_STEP_CONFIRM' || !run) {
      throw new BadRequestException(`Workflow step confirmation is not active: ${session.status}`);
    }
    this.assertPendingConfirmation(sessionId, input.confirmationId, 'confirm_workflow_step');
    const expectedTaskId = run.nodeTaskIds[run.currentStepIndex];
    if (expectedTaskId !== input.taskId) {
      throw new BadRequestException(`Workflow step is not current: ${input.taskId}`);
    }
    const task = this.tasks.list(sessionId).find((candidate) => candidate.id === input.taskId);
    if (!task) throw new BadRequestException(`Workflow task not found: ${input.taskId}`);
    const approved = input.decision === 'approve';
    this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: approved ? `用户确认工作流环节：${task.title}` : `用户要求修改工作流环节：${task.title}`,
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: approved ? 'approved' : 'rejected',
        selectedOptionKey: input.decision,
        relatedTaskId: task.id,
        workflowRunId: run.id
      })
    });

    if (approved) {
      run.completedTaskIds = Array.from(new Set([...run.completedTaskIds, task.id]));
      run.currentStepIndex += 1;
      run.status = run.currentStepIndex >= run.nodeTaskIds.length ? 'completed' : 'running';
      run.updatedAt = nowIso();
    } else {
      const instruction = input.instruction?.trim() || '请重新检查并修改本环节输出。';
      this.tasks.update(task, { status: 'reworking', resultSummary: instruction });
      run.status = 'running';
      run.updatedAt = nowIso();
      const assigneeId = task.assignee?.type === 'agent' ? task.assignee.id : undefined;
      this.events.create({
        sessionId,
        type: 'user_message',
        userMessageIntent: 'correction',
        priority: 'high',
        content: instruction,
        toAgentIds: assigneeId ? [assigneeId] : [],
        taskId: task.id,
        metadata: createMetadata('chat_message', {
          text: instruction,
          relatedTaskIds: [task.id],
          workflowRunId: run.id,
          workflowStepIndex: run.currentStepIndex
        })
      });
    }

    this.setStatus(session, 'EXECUTING');
    this.resumeExecution(session);
    return { session, task, decision: input.decision };
  }

  reviseBrief(
    sessionId: string,
    briefId: string,
    input: {
      reason?: string;
      userMessage?: string;
      confirmationId?: string;
      assignedAgentKeys?: string[];
    } = {}
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

    // P1 分流:指定 Agent 定向修订 vs 全量重跑
    if (input.assignedAgentKeys && input.assignedAgentKeys.length > 0) {
      return this.reviseBriefDirected(
        session,
        brief,
        content,
        input.confirmationId,
        input.assignedAgentKeys
      );
    }

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

  private reviseBriefDirected(
    session: SessionDetail,
    brief: TaskBrief,
    userModification: string,
    confirmationId: string | undefined,
    assignedAgentKeys: string[]
  ) {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);

    // 更新 session.latestContractGoal 为用户修改后的目标（从 userModification 提取或直接使用）
    session.latestContractGoal = userModification;

    const userEvent = this.events.create({
      sessionId: session.id,
      type: 'user_message',
      userMessageIntent: 'correction',
      priority: 'high',
      content: userModification,
      toAgentIds: [coordinator.id],
      metadata: createMetadata('chat_message', {
        text: userModification,
        mentionedAgentIds: [coordinator.id],
        relatedBriefId: brief.id,
        revisionOfBriefId: brief.id
      })
    });

    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_resolved',
      content: '用户选择修改当前任务契约（定向修订模式）。',
      metadata: createMetadata('system_notice', {
        confirmationId,
        status: 'rejected',
        selectedOptionKey: 'revise_directed',
        relatedBriefId: brief.id,
        assignedAgentKeys
      })
    });

    this.events.create({
      sessionId: session.id,
      type: 'brief_rejected',
      fromAgentId: coordinator.id,
      content: `当前任务契约已进入定向修订，指定的 ${assignedAgentKeys.length} 个 Agent 将审阅用户修改，最后由 Coordinator 定稿。`,
      metadata: createMetadata('system_notice', {
        briefId: brief.id,
        reason: userModification,
        coordinatorAgentId: coordinator.id,
        assignedAgentKeys
      })
    });

    // 取消正在进行的执行（如果有）
    this.execution.cancel(
      session.id,
      createExecutionTermination({ kind: 'superseded', source: 'orchestrator', scope: 'phase' })
    );
    this.tasks.cancelUnfinished(session.id, messages.requirementChangedCancelTasks);

    this.setStatus(session, 'AGENT_DISCUSSING');
    this.generateDirectedRevisionInBackground(session, brief, userModification, assignedAgentKeys, userEvent.id);

    return { accepted: true, sessionId: session.id, status: session.status, event: userEvent };
  }

  private generateDirectedRevisionInBackground(
    session: SessionDetail,
    oldBrief: TaskBrief,
    userModification: string,
    assignedAgentKeys: string[],
    sourceEventId: string
  ) {
    const generationSeq = (this.briefGenerationSeqBySession.get(session.id) ?? 0) + 1;
    this.briefGenerationSeqBySession.set(session.id, generationSeq);
    const previousRun = this.briefGenerationRuns.get(session.id);
    if (previousRun) {
      abortWithTermination(
        previousRun.controller,
        createExecutionTermination({ kind: 'superseded', source: 'orchestrator', scope: 'phase' })
      );
    }
    const controller = new AbortController();
    const done = this.orchestrator
      .runDirectedBriefRevision(session, oldBrief, userModification, assignedAgentKeys, sourceEventId, controller.signal)
      .then((brief) => {
        if (
          controller.signal.aborted ||
          this.deletingSessionIds.has(session.id) ||
          this.briefGenerationSeqBySession.get(session.id) !== generationSeq
        ) {
          return;
        }
        session.currentTaskBriefId = brief.id;
        this.setStatus(session, 'WAIT_USER_CONFIRM');
      })
      .catch((error) => {
        if (controller.signal.aborted || this.deletingSessionIds.has(session.id)) return;
        this.failSessionWithFullError(session, error, 'directed_brief_revision');
      })
      .finally(() => {
        if (this.briefGenerationRuns.get(session.id)?.controller === controller) {
          this.briefGenerationRuns.delete(session.id);
        }
      });
    this.briefGenerationRuns.set(session.id, { controller, done });
    void done;
  }

  private async consultBrief(session: SessionDetail, content: string, mentionedAgentIds: string[]) {
    const { userEvent } = await this.orchestrator.consultBriefWithAgent(session, content, mentionedAgentIds);
    this.touchSession(session);
    return { event: userEvent };
  }

  private hasActiveSessionWork(session: SessionDetail) {
    return Boolean(
      session.status === 'INTERRUPTED' ||
      session.status === 'PAUSED' ||
      session.activeFollowUpMessageId ||
      this.followUpPlanningRuns.has(session.id) ||
      this.briefGenerationRuns.has(session.id) ||
      this.execution.isRunning(session.id) ||
      ACTIVE_INVOCATION_SESSION_STATUSES.has(session.status)
    );
  }

  private scheduleFollowUpPlanning(sessionId: string) {
    if (this.followUpPlanningRuns.has(sessionId) || this.shuttingDown) return;
    const run = this.processNextFollowUp(sessionId)
      .catch((error) => {
        const session = this.sessions.get(sessionId);
        if (!session || this.deletingSessionIds.has(sessionId)) return;
        const active = session.pendingFollowUpMessages?.find(
          (item) => item.id === session.activeFollowUpMessageId
        );
        if (active) active.status = 'queued';
        session.activeFollowUpMessageId = undefined;
        this.setStatus(session, 'FAILED');
        this.events.create({
          sessionId,
          type: 'error_reported',
          priority: 'high',
          content: `接收者处理后续需求失败：${error instanceof Error ? error.message : String(error)}`,
          metadata: createMetadata('error_card', {
            phase: 'follow_up_task_decomposition',
            followUpMessageId: active?.id,
            runtimeError: extractRuntimeError(error)
          })
        });
      })
      .finally(() => {
        if (this.followUpPlanningRuns.get(sessionId) === run) {
          this.followUpPlanningRuns.delete(sessionId);
        }
      });
    this.followUpPlanningRuns.set(sessionId, run);
    void run;
  }

  private async processNextFollowUp(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'INTERRUPTED' || session.status === 'PAUSED' || session.activeFollowUpMessageId) return;
    if (
      this.briefGenerationRuns.has(sessionId) ||
      this.execution.isRunning(sessionId) ||
      ACTIVE_INVOCATION_SESSION_STATUSES.has(session.status)
    ) {
      return;
    }
    const followUp = session.pendingFollowUpMessages?.find((item) => item.status === 'queued');
    if (!followUp) return;
    if (followUp.receiverRecognitionPending) {
      followUp.handlingPlan = await this.recognizeFollowUpHandlingPlan(
        session,
        followUp.content,
        followUp.mentionedAgentIds
      );
      followUp.receiverRecognitionPending = undefined;
      this.touchSession(session);
    }
    followUp.handlingPlan = this.normalizeFollowUpHandlingPlan(session, followUp.handlingPlan);

    followUp.status = 'planning';
    followUp.startedAt = nowIso();
    session.activeFollowUpMessageId = followUp.id;

    if (followUp.handlingPlan.failedExecutionAction === 'resume') {
      this.recordAgentRequirementContext(
        session,
        followUp.content,
        followUp.sourceEventId,
        this.relevantAgentIds(session, followUp.content, followUp.handlingPlan.affectedAgentIds)
      );
      this.completeFollowUpRouting(session, followUp.id);
      this.retryFailedSession(session, followUp.sourceEventId, true);
      return;
    }

    this.setStatus(session, 'AGENT_DISCUSSING');
    this.events.create({
      sessionId,
      type: 'session_status_changed',
      content: followUp.mentionedAgentIds.length > 1
        ? '被 @ 的多个 Agent 开始讨论，随后由接收者拆分任务。'
        : '接收者开始拆分后续需求并准备任务派发。',
      metadata: createMetadata('system_notice', {
        status: 'AGENT_DISCUSSING',
        reason: followUp.mentionedAgentIds.length > 1
          ? 'follow_up_multi_agent_discussion_started'
          : 'follow_up_decomposition_started',
        followUpMessageId: followUp.id,
        mentionedAgentIds: followUp.mentionedAgentIds
      })
    });

    const { brief, tasks } = await this.orchestrator.prepareFollowUpExecution(
      session,
      followUp.content,
      followUp.sourceEventId,
      followUp.mentionedAgentIds,
      {
        discussionRequired:
          followUp.handlingPlan.requirementRelation === 'new_requirement' ||
          followUp.handlingPlan.failedExecutionAction === 'replan',
        requirementRelation: followUp.handlingPlan.requirementRelation
      }
    );
    session.currentTaskBriefId = brief.id;
    followUp.status = 'executing';
    this.setStatus(session, 'EXECUTING');
    this.execution.start(session, brief, tasks, (outcome) => {
      this.applyFollowUpOutcome(sessionId, followUp.id, outcome);
    });
  }

  private normalizeFollowUpHandlingPlan(
    session: SessionDetail,
    plan: UserMessageHandlingPlan
  ): UserMessageHandlingPlan {
    const requirementRelation = plan.requirementRelation ?? 'continuation';
    const failedExecutionAction = session.status === 'FAILED' && requirementRelation === 'continuation'
      ? plan.failedExecutionAction === 'replan' ? 'replan' : 'resume'
      : 'none';
    return { ...plan, requirementRelation, failedExecutionAction };
  }

  private completeFollowUpRouting(session: SessionDetail, followUpMessageId: string) {
    session.pendingFollowUpMessages = (session.pendingFollowUpMessages ?? []).filter(
      (item) => item.id !== followUpMessageId
    );
    if (session.activeFollowUpMessageId === followUpMessageId) {
      session.activeFollowUpMessageId = undefined;
    }
    this.touchSession(session);
  }

  private applyFollowUpOutcome(sessionId: string, followUpMessageId: string, outcome: ExecutionOutcome) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingFollowUpMessages = (session.pendingFollowUpMessages ?? []).filter(
      (item) => item.id !== followUpMessageId
    );
    if (session.activeFollowUpMessageId === followUpMessageId) {
      session.activeFollowUpMessageId = undefined;
    }
    this.touchSession(session);
    this.events.create({
      sessionId,
      type: 'session_status_changed',
      content: outcome.kind === 'delivered'
        ? '本条后续需求已执行完成。'
        : `本条后续需求执行结束：${'reason' in outcome ? outcome.reason : outcome.kind}`,
      metadata: createMetadata('system_notice', {
        status: session.status,
        reason: 'follow_up_execution_finished',
        followUpMessageId,
        outcome: outcome.kind
      })
    });
    this.applyOutcome(sessionId, outcome);
  }

  /** Applied when the background execution pipeline finishes. */
  applyOutcome(sessionId: string, outcome: ExecutionOutcome) {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.status === 'CANCELLED' ||
      session.status === 'COMPLETED' ||
      session.status === 'PAUSED' ||
      session.status === 'INTERRUPTED'
    ) {
      return;
    }
    if (outcome.kind === 'workflow_step_completed') {
      this.pauseForWorkflowStepConfirmation(session, outcome.taskId, outcome.resultSummary);
      return;
    }
    if (outcome.kind === 'approval_required') {
      this.setStatus(session, 'WAIT_USER_DECISION');
      this.events.create({
        sessionId,
        type: 'session_status_changed',
        content: '执行已暂停，等待用户授权所需能力。',
        metadata: createMetadata('system_notice', {
          status: 'WAIT_USER_DECISION',
          outcome: outcome.kind,
          reason: outcome.reason
        })
      });
      return;
    }
    if (outcome.kind === 'failed' && this.pauseForLocalRuntimeConfirmation(session, outcome.error, 'task_execution')) {
      return;
    }
    if (outcome.kind === 'cancelled') {
      return;
    }
    if (outcome.kind === 'workspace_conflict') {
      const writebackState = this.workspaceWritebackAggregate(sessionId);
      if (writebackState === 'blocking') this.setStatus(session, 'WAIT_WORKSPACE_CONFLICT_RESOLUTION');
      else if (writebackState === 'in_flight') this.setStatus(session, 'APPLYING_CHANGES');
      else if (writebackState === 'terminal') {
        const waitingWritebacks = this.workspaceWritebacks?.list(sessionId).filter((record) => {
          if (!record.taskId || !['applied', 'abandoned'].includes(record.status)) return false;
          return this.tasks.find(sessionId, record.taskId)?.status === 'waiting';
        }) ?? [];
        if (waitingWritebacks.length) {
          void this.completeTerminalWorkspaceWritebacks(session, waitingWritebacks)
            .catch((error) => this.failSession(session, error, 'workspace_writeback_resume'));
        }
      }
      return;
    }
    if (
      session.status === 'WAIT_USER_DECISION' &&
      outcome.kind !== 'ask_user' &&
      outcome.kind !== 'delivered'
    ) {
      // delivered 是终态权威结果（执行真的完成了），允许它覆盖之前由竞态
      // 进入的 WAIT_USER_DECISION；其他非 ask_user 结果（rework/failed）继续被吞。
      return;
    }
    const hasQueuedFollowUp = session.pendingFollowUpMessages?.some((item) => item.status === 'queued') ?? false;
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
      this.scheduleFollowUpPlanning(sessionId);
      if (!hasQueuedFollowUp) {
        this.events.create({
          sessionId,
          type: 'session_status_changed',
          content: messages.sessionStatusUpdated('COMPLETED'),
          metadata: createMetadata('system_notice', {
            status: 'COMPLETED',
            outcome: outcome.kind,
            reason: 'execution_delivered'
          })
        });
      }
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
        reason,
        runtimeError: outcome.kind === 'failed' ? outcome.error : undefined,
        actions: outcome.kind === 'ask_user' ? outcome.actions : undefined
      })
    });
    if (outcome.kind === 'ask_user') {
      this.events.create({
        sessionId,
        type: 'user_confirmation_requested',
        priority: 'high',
        content: 'Coordinator 自动处理未能继续推进，请确认下一步。',
        metadata: createMetadata('confirmation_card', {
          confirmationId: crypto.randomUUID(),
          reason: 'coordinator_routing_needs_user_decision',
          title: '需要用户确认下一步',
          description: reason || '任务在自动恢复后仍无法继续，需要用户确认是否继续执行或取消。',
          actions: outcome.actions,
          options: [
            { key: 'resume', label: messages.reworkResume, style: 'primary' },
            { key: 'cancel', label: messages.reworkCancel, style: 'default' }
          ]
        })
      });
    }
    if (outcome.kind === 'rework') {
      this.startRework(session, reason);
    }
  }

  async resolveLocalRuntimePermission(
    sessionId: string,
    input: { confirmationId: string; decision: 'approve_once' | 'cancel' }
  ) {
    const session = this.get(sessionId);
    if (session.status !== 'WAIT_USER_DECISION') {
      throw new BadRequestException(`Local Runtime permission confirmation is not active: ${session.status}`);
    }
    const request = this.assertPendingConfirmation(
      sessionId,
      input.confirmationId,
      'approve_local_runtime_permission'
    );
    const payload = request.metadata.payload as {
      workspaceId?: string;
      permission?: LocalRuntimePermission;
      phase?: string;
    } | undefined;
    if (!payload?.workspaceId || !payload.permission) {
      throw new BadRequestException('Local Runtime permission confirmation payload is incomplete.');
    }
    if (input.decision === 'approve_once') {
      if (!this.localRuntime) throw new ServiceUnavailableException('Local Runtime service is unavailable.');
      await this.localRuntime.grantWorkspacePermissionOnce(payload.workspaceId, payload.permission);
    }
    const resolvedEvent = this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      priority: 'high',
      content: input.decision === 'approve_once'
        ? `用户已单次授权本机危险动作：${payload.permission}`
        : `用户已取消本机危险动作：${payload.permission}`,
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: input.decision === 'approve_once' ? 'approved' : 'rejected',
        selectedOptionKey: input.decision,
        workspaceId: payload.workspaceId,
        permission: payload.permission
      })
    });
    if (input.decision === 'cancel') {
      this.tasks.cancelUnfinished(sessionId, '用户拒绝本机危险动作授权。');
      this.setStatus(session, 'CANCELLED');
      return { session, resolvedEvent };
    }
    this.retryAfterLocalRuntimePermission(session, payload.phase, resolvedEvent.id);
    return { session, resolvedEvent };
  }

  async resolvePostReviewAction(
    sessionId: string,
    input: { confirmationId: string; action: PostReviewAction['action'] }
  ) {
    const session = this.get(sessionId);
    if (session.status !== 'WAIT_USER_DECISION') {
      throw new BadRequestException(`Post Review action requires WAIT_USER_DECISION: ${session.status}`);
    }
    const action = this.confirmedPostReviewAction(sessionId, input.confirmationId, input.action);
    const alreadyResolved = this.events.list(sessionId).some(
      (event) =>
        event.type === 'user_confirmation_resolved' &&
        (event.metadata.payload as { confirmationId?: string } | undefined)?.confirmationId === input.confirmationId
    );
    if (alreadyResolved) {
      throw new BadRequestException(`Confirmation already resolved: ${input.confirmationId}`);
    }

    const resolvedEvent = this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: `用户选择 Post Review 动作：${action.action}`,
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: action.action === 'cancel' ? 'rejected' : 'approved',
        selectedOptionKey: action.action,
        action
      })
    });

    if (action.action === 'request_workspace_context') {
      const reviewer = this.pickSessionAgent(session, ['review', 'test', 'coordinator']);
      const requestedContext = {
        reason: action.reason,
        requestedRefs: action.missingPaths.map((path) => ({
          type: 'workspace_file' as const,
          label: path,
          ref: path
        })),
        requestedFiles: action.missingPaths.map((path) => ({ path })),
        followUpInstruction: 'Load the requested workspace files and retry Post Review with grounded evidence.'
      };
      const resolution = await this.orchestrator.hydrateSupplementalContext(session, requestedContext);
      session.supplementalContextRequests = [
        ...(session.supplementalContextRequests ?? []),
        {
          id: crypto.randomUUID(),
          taskId: session.currentTaskBriefId ?? session.id,
          agentId: reviewer.id,
          requestedContext,
          resolution,
          createdAt: nowIso()
        }
      ].slice(-12);
      this.events.create({
        sessionId,
        type: 'agent_message',
        fromAgentId: reviewer.id,
        content: resolution.hydratedPaths.length
          ? `Post Review loaded workspace context: ${resolution.hydratedPaths.join(', ')}`
          : `Post Review could not load workspace context: ${resolution.failedPaths.map((item) => `${item.path}:${item.code}`).join(', ') || 'no readable paths'}`,
        metadata: createMetadata('chat_message', {
          messageKind: 'progress',
          phase: 'context_supplement',
          requestedContext,
          resolution,
          action
        })
      });
      if (resolution.hydratedPaths.length) {
        this.setStatus(session, 'EXECUTING');
        this.resumeExecution(session);
      } else {
        this.touchSession(session);
      }
    } else if (action.action === 'deliver_with_limitations') {
      this.setStatus(session, 'EXECUTING');
      this.resumeExecution(session);
    } else if (action.action === 'save_progress') {
      this.touchSession(session);
    } else {
      this.execution.cancel(
        sessionId,
        createExecutionTermination({ kind: 'user_cancelled', source: 'user', scope: 'session' })
      );
      this.tasks.cancelUnfinished(sessionId, action.reason ?? '用户取消 Post Review 后续流程。');
      this.setStatus(session, 'CANCELLED');
    }

    return { session, action, resolvedEvent };
  }

  private confirmedPostReviewAction(
    sessionId: string,
    confirmationId: string,
    actionKey: PostReviewAction['action']
  ): PostReviewAction {
    const confirmation = this.events
      .list(sessionId)
      .find(
        (event) =>
          event.type === 'user_confirmation_requested' &&
          (event.metadata.payload as { confirmationId?: string } | undefined)?.confirmationId === confirmationId
      );
    const actions = (confirmation?.metadata.payload as { actions?: PostReviewAction[] } | undefined)?.actions;
    const action = actions?.find((candidate) => candidate.action === actionKey);
    if (!action) {
      throw new BadRequestException(`Post Review action is not available: ${actionKey}`);
    }
    return action;
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

    if (session.workflowRunId && this.workflowRuntime) {
      const previousRun = this.workflowRuntime.get(session.workflowRunId);
      const coordinator = this.pickSessionAgent(session, ['coordinator']);
      this.events.create({
        sessionId: session.id,
        type: 'session_status_changed',
        priority: 'high',
        content: messages.reworkStarted(reworkRounds, maxRounds),
        metadata: createMetadata('system_notice', {
          status: 'REWORKING',
          reworkRound: reworkRounds,
          maxReworkRounds: maxRounds,
          reason,
          previousWorkflowRunId: previousRun.id
        })
      });
      void this.workflowRuntime.start({
        session,
        brief,
        coordinatorId: coordinator.id,
        workflowId: previousRun.workflowId,
        workflowVersion: previousRun.workflowVersion,
        confirmationId: `workflow-rework:${session.id}:${reworkRounds}`
      }).catch((error) => this.failSession(session, error, 'workflow_rework'));
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

  async pause(sessionId: string, reason = '用户已停止会话', confirmationId?: string) {
    const session = this.get(sessionId);
    const alreadyPaused = session.status === 'PAUSED';
    if (!alreadyPaused) {
      this.assertControlTransition(session.status, 'PAUSED');
      session.pauseState = {
        previousStatus: session.status,
        pausedAt: nowIso(),
        reason
      };
      this.setStatus(session, 'PAUSED');
    }

    const termination = createExecutionTermination({
      kind: 'user_paused',
      source: 'user',
      scope: 'session',
      diagnosticRef: 'session_paused'
    });
    this.briefGenerationSeqBySession.set(
      sessionId,
      (this.briefGenerationSeqBySession.get(sessionId) ?? 0) + 1
    );
    const briefRun = this.briefGenerationRuns.get(sessionId);
    if (briefRun) abortWithTermination(briefRun.controller, termination);

    const [briefStopped, executionStopped, runtimeStopped] = await Promise.all([
      briefRun ? settlesWithin(briefRun.done, 10_000) : Promise.resolve(true),
      this.execution.cancelAndWait(sessionId, termination),
      this.runtime?.cancelSessionAndWait(sessionId, termination) ??
        Promise.resolve({ requested: 0, completed: 0, timedOut: false })
    ]);
    if (!briefStopped || executionStopped.timedOut || runtimeStopped.timedOut) {
      throw new ConflictException({
        code: 'SESSION_PAUSE_TIMEOUT',
        message: '会话已标记为暂停，但部分后台执行未在宽限期内停止，可重试停止。',
        details: {
          briefStopped,
          executionTimedOut: executionStopped.timedOut,
          runtimeTimedOut: runtimeStopped.timedOut
        }
      });
    }

    const event = alreadyPaused
      ? this.events.list(sessionId).at(-1)
      : this.events.create({
          sessionId,
          type: 'session_status_changed',
          priority: 'high',
          content: reason,
          metadata: createMetadata('system_notice', {
            status: 'PAUSED',
            requestedStatus: 'PAUSED',
            reason,
            termination
          })
        });
    const confirmationEvent = confirmationId && !alreadyPaused
      ? this.events.create({
          sessionId,
          type: 'user_confirmation_resolved',
          content: '用户已停止会话',
          metadata: createMetadata('system_notice', {
            confirmationId,
            status: 'approved',
            selectedOptionKey: 'pause'
          })
        })
      : undefined;
    return { session, event, confirmationEvent };
  }

  resume(sessionId: string, reason = '用户已继续会话', confirmationId?: string) {
    const session = this.get(sessionId);
    if (session.status !== 'PAUSED') {
      return this.control(sessionId, 'EXECUTING', reason, confirmationId);
    }
    this.assertControlTransition(session.status, 'EXECUTING');
    const previousStatus = session.pauseState?.previousStatus ?? 'EXECUTING';
    session.pauseState = undefined;
    const nextStatus = this.hasFinalDelivery(sessionId)
      ? 'COMPLETED'
      : previousStatus === 'AGENT_DISCUSSING' || previousStatus === 'REVISING_BRIEF'
        ? 'AGENT_DISCUSSING'
        : 'EXECUTING';
    this.setStatus(session, nextStatus);
    const event = this.events.create({
      sessionId,
      type: 'session_status_changed',
      priority: 'high',
      content: reason,
      metadata: createMetadata('system_notice', {
        status: nextStatus,
        requestedStatus: 'EXECUTING',
        reason,
        resumedFromStatus: previousStatus
      })
    });
    const confirmationEvent = confirmationId
      ? this.events.create({
          sessionId,
          type: 'user_confirmation_resolved',
          content: messages.userSelectedResume,
          metadata: createMetadata('system_notice', {
            confirmationId,
            status: 'approved',
            selectedOptionKey: 'resume'
          })
        })
      : undefined;
    if (nextStatus === 'AGENT_DISCUSSING') this.generateBriefInBackground(session);
    else if (nextStatus === 'EXECUTING') this.resumeExecution(session);
    return { session, event, confirmationEvent };
  }

  control(sessionId: string, status: SessionStatus, reason?: string, confirmationId?: string) {
    const session = this.get(sessionId);
    this.assertControlTransition(session.status, status);
    const nextStatus = status === 'EXECUTING' && this.hasFinalDelivery(sessionId) ? 'COMPLETED' : status;
    this.setStatus(session, nextStatus);
    if (nextStatus === 'WAIT_USER_DECISION' || nextStatus === 'CANCELLED') {
      this.execution.cancel(
        sessionId,
        createExecutionTermination({
          kind: 'user_cancelled',
          source: 'user',
          scope: nextStatus === 'WAIT_USER_DECISION' ? 'invocation' : 'session'
        })
      );
    }
    if (nextStatus === 'CANCELLED' && session.workflowRunId && this.workflowRuntime) {
      void this.workflowRuntime.cancel(session.workflowRunId, reason ?? '用户已取消会话').catch((error) => {
        this.logger.error(`Failed to cancel workflow ${session.workflowRunId} for session ${session.id}: ${String(error)}`);
      });
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

  async decideLocalReportSave(
    sessionId: string,
    input: {
      confirmationId: string;
      artifactId: string;
      decision: 'save_local' | 'keep_in_session';
    }
  ) {
    const session = this.get(sessionId);
    const result = await this.orchestrator.decideLocalReportSave(session, input);
    this.touchSession(session);
    return { session, ...result };
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

  private requireFileRevisions() {
    if (!this.fileRevisions) {
      throw new ServiceUnavailableException('File revision processing is unavailable.');
    }
    return this.fileRevisions;
  }

  private validateFileRevisionAgents(session: SessionDetail, agentIds: string[]) {
    const participantIds = new Set(session.participatingAgentIds);
    const agents = [...new Set(agentIds)].map((agentId) => {
      const agent = this.agents.getByIdOrKey(agentId);
      if (!participantIds.has(agent.id)) throw new BadRequestException(`Agent is not part of this session: ${agentId}`);
      if (agent.status !== 'active') throw new BadRequestException(`Agent is not active: ${agent.name}`);
      if (agent.key === 'coordinator') throw new BadRequestException('The receiver cannot be selected as a processing Agent.');
      return agent;
    });
    if (agents.length === 0) throw new BadRequestException('Select at least one processing Agent.');
    return agents;
  }

  private applyWorkflowRuntimeUpdate(update: WorkflowRuntimeUpdate) {
    const session = this.sessions.get(update.sessionId);
    if (!session) return;
    session.workflowRunId = update.workflowRunId;
    if (update.kind === 'session_outcome') {
      this.applyOutcome(session.id, update.outcome);
      return;
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED', 'INTERRUPTED'].includes(session.status)) return;
    if (update.status === 'waiting_human') {
      this.setStatus(session, 'WAIT_WORKFLOW_STEP_CONFIRM');
      return;
    }
    if (update.status === 'failed') {
      this.setStatus(session, 'FAILED');
      return;
    }
    if (update.status === 'cancelled') {
      this.setStatus(session, 'CANCELLED');
      return;
    }
    // A completed workflow still runs the existing Post Review/final delivery pipeline.
    this.setStatus(session, 'EXECUTING');
  }

  private setStatus(session: SessionDetail, status: SessionStatus) {
    const previousStatus = session.status;
    session.status = status;
    session.updatedAt = nowIso();
    this.persist();

    const terminalStatuses: SessionStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
    if (terminalStatuses.includes(status) && !terminalStatuses.includes(previousStatus)) {
      void this.persistence.releaseWorkspaceSessionLease(session.workspaceId, session.id).catch((error) => {
        this.logger.error(`Failed to release workspace session lease for ${session.workspaceId}: ${String(error)}`);
      });
    }
  }

  private async interruptForWorkspaceDisconnect(interruption: {
    sessionId: string;
    invocationId?: string;
    reason: 'local_runtime_disconnected';
    occurredAt: string;
  }) {
    const { sessionId } = interruption;
    const session = this.sessions.get(sessionId);
    if (!session || !ACTIVE_INVOCATION_SESSION_STATUSES.has(session.status)) return false;
    if (this.runtimeInterruptingSessions.has(sessionId)) return false;

    this.runtimeInterruptingSessions.add(sessionId);
    const termination = createExecutionTermination({
      kind: 'runtime_disconnected',
      source: 'runtime',
      scope: 'session',
      diagnosticRef: interruption.reason
    });
    const subject = 'Local Runtime';
    try {
      this.markSessionInterrupted(
        session,
        interruption,
        termination,
        `${subject} disconnected; waiting for a future user wake-up.`,
        `${subject} 已断开，本次调用已中断且不会自动续跑。会话上下文已保留，可在后续唤醒功能中继续。`
      );

      const workflowCancellation = session.workflowRunId && this.workflowRuntime
        ? this.workflowRuntime.cancel(
          session.workflowRunId,
          `${subject} disconnected; the invocation will not resume automatically.`
        )
        : Promise.resolve();
      const runtimeCancellation = this.runtime?.cancelSessionAndWait(sessionId, termination) ??
        Promise.resolve({ requested: 0, completed: 0, timedOut: false });
      await Promise.all([
        this.execution.cancelAndWait(sessionId, termination),
        runtimeCancellation,
        workflowCancellation
      ]);
      return true;
    } finally {
      this.runtimeInterruptingSessions.delete(sessionId);
    }
  }

  private markSessionInterrupted(
    session: SessionDetail,
    interruption: {
      reason:
        | 'local_runtime_disconnected'
        | 'service_shutdown';
      invocationId?: string;
      occurredAt: string;
    },
    termination: ReturnType<typeof createExecutionTermination>,
    taskReason: string,
    eventContent: string
  ) {
    session.interruption = {
      reason: interruption.reason,
      invocationId: interruption.invocationId,
      occurredAt: interruption.occurredAt,
      wakeable: true
    };
    // Persist metadata and status in the same Session snapshot.
    this.setStatus(session, 'INTERRUPTED');
    this.briefGenerationSeqBySession.set(
      session.id,
      (this.briefGenerationSeqBySession.get(session.id) ?? 0) + 1
    );
    const briefRun = this.briefGenerationRuns.get(session.id);
    if (briefRun) abortWithTermination(briefRun.controller, termination);
    this.tasks.interruptUnfinished(session.id, taskReason);
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: eventContent,
      metadata: createMetadata('system_notice', {
        status: 'INTERRUPTED',
        requestedStatus: 'INTERRUPTED',
        reason: interruption.reason,
        invocationId: interruption.invocationId,
        wakeable: true,
        termination
      })
    });
  }

  private failSession(session: SessionDetail, error: unknown, phase: string) {
    const runtimeError = extractRuntimeError(error);
    if (this.pauseForLocalRuntimeConfirmation(session, runtimeError, phase)) return;
    const message = runtimeError?.message ?? (error instanceof Error ? error.message : String(error));
    this.setStatus(session, 'FAILED');
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: `会话在${messages.phaseLabel(phase)}阶段失败：${message}`,
      metadata: createMetadata('system_notice', {
        status: 'FAILED',
        phase,
        message,
        runtimeError
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'error_reported',
      priority: 'high',
      content: message,
      metadata: createMetadata('error_card', {
        phase,
        message,
        runtimeError
      })
    });
  }

  private failSessionWithFullError(session: SessionDetail, error: unknown, phase: string) {
    const runtimeError = extractRuntimeError(error);
    if (this.pauseForLocalRuntimeConfirmation(session, runtimeError, phase)) return;
    const message = runtimeError?.message ?? (error instanceof Error ? error.message : String(error));
    const runtimePhase = typeof runtimeError?.details?.phase === 'string'
      ? runtimeError.details.phase
      : undefined;
    const effectivePhase = runtimePhase ?? phase;
    const phaseLabel = messages.phaseLabel(effectivePhase);
    const fullMessage = `会话在${phaseLabel}阶段失败：${message}`;
    this.setStatus(session, 'FAILED');
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: fullMessage,
      metadata: createMetadata('system_notice', {
        status: 'FAILED',
        phase: effectivePhase,
        phaseLabel,
        message,
        fullMessage,
        runtimeError
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'error_reported',
      priority: 'high',
      content: fullMessage,
      metadata: createMetadata('error_card', {
        phase: effectivePhase,
        phaseLabel,
        message,
        fullMessage,
        runtimeError
      })
    });
  }

  private assertControlTransition(current: SessionStatus, next: SessionStatus) {
    const allowed: Partial<Record<SessionStatus, SessionStatus[]>> = {
      AGENT_DISCUSSING: ['PAUSED', 'CANCELLED'],
      WAIT_USER_CONFIRM: ['REVISING_BRIEF', 'CANCELLED'],
      WAIT_WORKFLOW_SELECT: ['REVISING_BRIEF', 'CANCELLED'],
      WAIT_WORKFLOW_STEP_CONFIRM: ['EXECUTING', 'CANCELLED'],
      REVISING_BRIEF: ['WAIT_USER_CONFIRM', 'PAUSED', 'CANCELLED'],
      EXECUTING: ['WAIT_USER_DECISION', 'PAUSED', 'CANCELLED'],
      POST_REVIEW: ['WAIT_USER_DECISION', 'PAUSED', 'CANCELLED'],
      REWORKING: ['WAIT_USER_DECISION', 'PAUSED', 'CANCELLED', 'EXECUTING'],
      WAIT_USER_DECISION: ['EXECUTING', 'CANCELLED'],
      PAUSED: ['EXECUTING', 'CANCELLED'],
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
      ['AGENT_DISCUSSING', 'WAIT_USER_CONFIRM', 'WAIT_WORKFLOW_SELECT', 'REVISING_BRIEF', 'WAIT_USER_DECISION'].includes(status)
    );
  }

  private pauseForWorkflowStepConfirmation(session: SessionDetail, taskId: string, resultSummary: string) {
    const run = session.workflowRun;
    if (!run || run.nodeTaskIds[run.currentStepIndex] !== taskId) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: `工作流执行状态与任务不一致：${taskId}` });
      return;
    }
    const task = this.tasks.list(session.id).find((candidate) => candidate.id === taskId);
    if (!task) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: `未找到工作流任务：${taskId}` });
      return;
    }
    const assigneeId = task.assignee?.type === 'agent' ? task.assignee.id : undefined;
    const agent = assigneeId ? this.agents.findByIdOrKey(assigneeId) : undefined;
    run.status = 'awaiting_step_confirmation';
    run.updatedAt = nowIso();
    this.setStatus(session, 'WAIT_WORKFLOW_STEP_CONFIRM');
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      taskId,
      fromAgentId: assigneeId,
      content: `${agent?.name ?? 'Agent'} 完成工作流环节「${task.title}」。阶段输出：${resultSummary}`,
      metadata: createMetadata('chat_message', {
        messageKind: 'summary',
        phase: 'workflow_step_completed',
        workflowRunId: run.id,
        workflowId: run.workflowId,
        workflowStepIndex: run.currentStepIndex,
        relatedTaskIds: [task.id],
        resultSummary
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_requested',
      taskId,
      priority: 'high',
      content: `请确认工作流环节「${task.title}」的输出。`,
      metadata: createMetadata('confirmation_card', {
        confirmationId: crypto.randomUUID(),
        reason: 'confirm_workflow_step',
        title: `确认环节 ${run.currentStepIndex + 1}/${run.nodeTaskIds.length}`,
        description: resultSummary,
        relatedTaskId: task.id,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        workflowStepIndex: run.currentStepIndex,
        workflowStepCount: run.nodeTaskIds.length,
        outputSummary: resultSummary,
        options: [
          { key: 'approve', label: '确认并继续', style: 'primary' },
          { key: 'revise', label: '要求修改', style: 'default' }
        ]
      })
    });
  }

  private emitWorkflowTaskCreated(
    session: SessionDetail,
    task: AgentTask,
    coordinatorId: string,
    assigneeId: string,
    workflowId: string,
    workflowNodeId: string,
    workflowStepIndex: number
  ) {
    const payload = {
      taskId: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      assignedBy: task.assignedBy,
      assignee: task.assignee,
      routingMode: task.routingMode,
      assignmentReason: task.assignmentReason,
      contextRequirements: task.contextRequirements,
      verificationPlan: task.verificationPlan,
      riskNotes: task.riskNotes,
      requiresUserConfirmation: true,
      dependsOnTaskIds: task.dependsOnTaskIds,
      acceptanceCriteria: task.acceptanceCriteria,
      workflowId,
      workflowNodeId,
      workflowStepIndex
    };
    this.events.create({
      sessionId: session.id,
      type: 'task_created',
      taskId: task.id,
      content: `已创建工作流任务：${task.title}`,
      metadata: createMetadata('task_card', payload)
    });
    this.events.create({
      sessionId: session.id,
      type: 'task_assigned',
      taskId: task.id,
      fromAgentId: coordinatorId,
      toAgentIds: [assigneeId],
      content: `Coordinator 已分配工作流任务：${task.title}`,
      metadata: createMetadata('task_card', payload)
    });
  }

  private assertPendingConfirmation(sessionId: string, confirmationId: string, reason: string) {
    const events = this.events.list(sessionId);
    const request = events.find(
      (event) =>
        event.type === 'user_confirmation_requested' &&
        (event.metadata.payload as { confirmationId?: string; reason?: string } | undefined)?.confirmationId === confirmationId &&
        (event.metadata.payload as { reason?: string } | undefined)?.reason === reason
    );
    const resolved = events.some(
      (event) =>
        event.type === 'user_confirmation_resolved' &&
        (event.metadata.payload as { confirmationId?: string } | undefined)?.confirmationId === confirmationId
    );
    if (!request || resolved) throw new BadRequestException(`Confirmation is missing or already resolved: ${confirmationId}`);
    return request;
  }

  private isEmptyWorkspace(session: SessionDetail) {
    const index = session.workspaceIndex;
    if (
      index?.status === 'ready' &&
      index.complete &&
      !index.truncated &&
      index.indexedEntries === 0 &&
      index.entries.length === 0
    ) {
      return true;
    }
    const snapshot = session.workspaceSnapshot;
    return Boolean(
      snapshot &&
      snapshot.fileCount === 0 &&
      snapshot.files.length === 0 &&
      snapshot.tree.length === 0
    );
  }

  private reopenRequirementLoop(
    session: SessionDetail,
    content: string,
    sourceEvent: CollaborationEvent,
    affectedAgentIds: string[],
    reason: string
  ) {
    this.execution.cancel(
      session.id,
      createExecutionTermination({ kind: 'superseded', source: 'orchestrator', scope: 'phase' })
    );
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

  private isResumeCommand(content: string) {
    return /^(继续|重试|恢复|resume|retry|continue)$/i.test(content.trim());
  }

  private retryFailedSession(session: SessionDetail, sourceEventId: string, resumeCurrentBrief = false) {
    const failurePhase = this.latestFailurePhase(session.id);
    const shouldRetryBrief =
      !session.currentTaskBriefId ||
      (!resumeCurrentBrief && ['discussion', 'brief_generation', 'brief_revision'].includes(failurePhase ?? ''));
    if (shouldRetryBrief) {
      this.setStatus(session, 'AGENT_DISCUSSING');
      this.events.create({
        sessionId: session.id,
        type: 'session_status_changed',
        priority: 'high',
        content: '收到继续指令，正在重新生成任务契约。',
        metadata: createMetadata('system_notice', {
          status: 'AGENT_DISCUSSING',
          reason: 'failed_brief_generation_user_retry',
          sourceEventId
        })
      });
      this.generateBriefInBackground(session);
      return;
    }

    for (const task of this.tasks.list(session.id)) {
      if (task.status === 'failed') {
        this.tasks.update(task, { status: 'pending', resultSummary: undefined });
      }
    }
    this.setStatus(session, 'EXECUTING');
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: '收到继续指令，正在恢复任务执行。',
      metadata: createMetadata('system_notice', {
        status: 'EXECUTING',
        reason: 'failed_execution_user_retry',
        sourceEventId
      })
    });
    this.resumeExecution(session);
  }

  private pauseForLocalRuntimeConfirmation(
    session: SessionDetail,
    runtimeError: RuntimeError | undefined,
    fallbackPhase: string
  ) {
    if (runtimeError?.code !== 'CAPABILITY_BLOCKED' || runtimeError.details?.confirmationRequired !== true) {
      return false;
    }
    const permission = runtimeError.details.permission as LocalRuntimePermission | undefined;
    const workspaceId = typeof runtimeError.details.workspaceId === 'string'
      ? runtimeError.details.workspaceId
      : undefined;
    if (!permission || !workspaceId) return false;
    const phase = typeof runtimeError.details.phase === 'string'
      ? runtimeError.details.phase
      : fallbackPhase;
    const confirmationId = crypto.randomUUID();
    this.setStatus(session, 'WAIT_USER_DECISION');
    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_requested',
      priority: 'high',
      content: `检测到需要用户确认的本机危险动作：${permission}`,
      metadata: createMetadata('confirmation_card', {
        confirmationId,
        reason: 'approve_local_runtime_permission',
        title: '确认本机危险动作',
        description: `本次执行需要 ${permission} 权限。批准后仅对下一次本机调用生效，不会改成永久授权。`,
        options: [
          { key: 'approve_once', label: '仅本次允许', style: 'primary' },
          { key: 'cancel', label: '取消任务', style: 'danger' }
        ],
        permission,
        workspaceId,
        phase
      })
    });
    return true;
  }

  private retryAfterLocalRuntimePermission(session: SessionDetail, phase: string | undefined, sourceEventId: string) {
    if (
      !session.currentTaskBriefId ||
      ['discussion', 'brief_generation', 'brief_revision', 'brief_consultation'].includes(phase ?? '')
    ) {
      this.setStatus(session, 'AGENT_DISCUSSING');
      this.events.create({
        sessionId: session.id,
        type: 'session_status_changed',
        priority: 'high',
        content: '危险动作已获单次授权，正在重新生成任务契约。',
        metadata: createMetadata('system_notice', {
          status: 'AGENT_DISCUSSING',
          reason: 'local_runtime_permission_approved',
          sourceEventId,
          phase
        })
      });
      this.generateBriefInBackground(session);
      return;
    }
    this.setStatus(session, 'EXECUTING');
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: '危险动作已获单次授权，正在恢复任务执行。',
      metadata: createMetadata('system_notice', {
        status: 'EXECUTING',
        reason: 'local_runtime_permission_approved',
        sourceEventId,
        phase
      })
    });
    this.resumeExecution(session);
  }

  private latestFailurePhase(sessionId: string) {
    const events = this.events.list(sessionId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      const status = (event?.metadata as { payload?: { status?: unknown } } | undefined)?.payload?.status;
      if (event?.type !== 'error_reported' && status !== 'FAILED') continue;
      const metadata = event.metadata as { payload?: { phase?: unknown } } | undefined;
      if (typeof metadata?.payload?.phase === 'string') return metadata.payload.phase;
    }
    return undefined;
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
    if (session.workflowRunId && this.workflowRuntime) {
      const coordinator = this.pickSessionAgent(session, ['coordinator']);
      void this.workflowRuntime
        .resumeCurrentExecution(session.workflowRunId, {
          session,
          brief,
          coordinatorId: coordinator.id
        })
        .then((resumed) => {
          if (!resumed) {
            this.applyOutcome(session.id, {
              kind: 'ask_user',
              reason: '当前工作流没有可恢复的运行中节点。'
            });
          }
        })
        .catch((error) => this.failSession(session, error, 'workflow_resume'));
      return;
    }
    this.tasks.resetStaleRunning(session.id);
    const unfinishedTasks = this.tasks.unfinished(session.id);
    this.execution.start(session, brief, unfinishedTasks, (outcome) => this.applyOutcome(session.id, outcome));
  }

  private recoverWorkspaceWritebackState(session: SessionDetail) {
    if (session.status !== 'APPLYING_CHANGES' || !this.workspaceWritebacks) return false;
    const records = this.workspaceWritebacks.list(session.id);
    session.workspaceWritebacks = records;
    const aggregate = this.workspaceWritebackAggregate(session.id);
    if (aggregate === 'none' || aggregate === 'blocking') {
      session.status = 'WAIT_WORKSPACE_CONFLICT_RESOLUTION';
      session.updatedAt = nowIso();
      return true;
    }
    if (aggregate === 'terminal') {
      for (const record of records) {
        if (!record.taskId) continue;
        const task = this.tasks.find(session.id, record.taskId);
        if (task) {
          this.tasks.update(task, {
            status: 'completed',
            resultSummary: record.resultSummary ?? 'Workspace writeback completed before backend restart.'
          });
        }
      }
      const occurredAt = nowIso();
      session.status = 'INTERRUPTED';
      session.interruption = {
        reason: 'service_shutdown',
        invocationId: records.at(-1)?.invocationId,
        occurredAt,
        wakeable: true
      };
      session.updatedAt = occurredAt;
      return true;
    }
    return false;
  }

  private workspaceWritebackAggregate(sessionId: string): 'blocking' | 'in_flight' | 'terminal' | 'none' {
    const records = this.workspaceWritebacks?.list(sessionId) ?? [];
    if (!records.length) return 'none';
    if (records.some((record) => record.status === 'conflicted' || record.status === 'failed')) return 'blocking';
    if (records.some((record) => ['queued', 'merging', 'applying'].includes(record.status))) return 'in_flight';
    return 'terminal';
  }

  private async completeTerminalWorkspaceWritebacks(
    session: SessionDetail,
    records: WorkspaceWritebackRecord[]
  ) {
    this.setStatus(session, 'EXECUTING');
    let acceptedWorkflowOutcome = false;
    for (const record of records) {
      if (!record.taskId) continue;
      const task = this.tasks.find(session.id, record.taskId);
      if (!task || task.status !== 'waiting') continue;
      const resultSummary = record.status === 'applied'
        ? record.resultSummary ?? 'Workspace changes were applied after conflict resolution.'
        : 'The isolated workspace changes were abandoned by the user.';
      this.tasks.update(task, { status: 'completed', resultSummary });
      if (session.workflowRunId && this.workflowRuntime) {
        await this.workflowRuntime.acceptExecutionOutcome(session.id, {
          kind: 'workflow_step_completed',
          taskId: record.taskId,
          resultSummary
        });
        acceptedWorkflowOutcome = true;
      }
    }
    if (!acceptedWorkflowOutcome) this.resumeExecution(session);
  }

  private normalizeRuntimePreference(input?: RuntimePreference): RuntimePreference | undefined {
    if (!input) return undefined;
    const preferredRuntimeType = isRuntimeType(input.preferredRuntimeType) ? input.preferredRuntimeType : undefined;
    const allowedRuntimeTypes = Array.from(new Set((input.allowedRuntimeTypes ?? []).filter(isRuntimeType)));
    const preferredModelId = input.preferredModelId?.trim() || undefined;
    const preference = {
      ...(preferredRuntimeType ? { preferredRuntimeType } : {}),
      ...(preferredModelId ? { preferredModelId } : {}),
      ...(allowedRuntimeTypes.length ? { allowedRuntimeTypes } : {})
    };
    return Object.keys(preference).length ? preference : undefined;
  }

  private assertCurrentSchema(session: SessionDetail) {
    if (typeof session.dataEpoch !== 'string' || !session.dataEpoch) {
      throw new Error(`CUTOVER_REQUIRED: persisted Session has no dataEpoch: ${session.id ?? 'unknown'}`);
    }
    assertCurrentDataEpoch(this.persistence.currentDataEpoch(), session.dataEpoch, `Session ${session.id}`);
    const workingDirectoryKind = (session.workingDirectory as { kind?: string } | undefined)?.kind;
    if (workingDirectoryKind === 'browser_local') {
      throw new Error(`CUTOVER_REQUIRED: persisted Session uses retired browser_local workspace: ${session.id}`);
    }
  }
  private restartExecutionWithUpdatedContext(
    session: SessionDetail,
    sourceEventId: string,
    affectedAgentIds: string[],
    interruptTaskId: string
  ) {
    if (session.status !== 'EXECUTING' || !this.execution.isRunning(session.id)) {
      return;
    }
    const brief = session.currentTaskBriefId
      ? this.orchestrator.getBrief(session.id, session.currentTaskBriefId)
      : undefined;
    if (!brief) {
      this.applyOutcome(session.id, { kind: 'ask_user', reason: messages.resumeBriefMissing });
      return;
    }

    const unfinishedTasks = this.tasks.unfinished(session.id).filter((task) => task.id !== interruptTaskId);
    if (!unfinishedTasks.length) {
      return;
    }

    if (session.workflowRunId && this.workflowRuntime) {
      void this.workflowRuntime.rescheduleCurrentExecution(session.workflowRunId, sourceEventId);
      this.events.create({
        sessionId: session.id,
        type: 'session_status_changed',
        priority: 'high',
        content: '执行中补充需求已写入相关 Agent 上下文，正在重调度当前工作流节点。',
        metadata: createMetadata('system_notice', {
          status: session.status,
          reason: 'executing_user_interrupt_rescheduled',
          sourceEventId,
          affectedAgentIds,
          interruptTaskId,
          affectedTaskIds: unfinishedTasks.map((task) => task.id),
          workflowRunId: session.workflowRunId
        })
      });
      return;
    }

    this.execution.cancel(
      session.id,
      createExecutionTermination({ kind: 'superseded', source: 'orchestrator', scope: 'phase' })
    );
    this.events.create({
      sessionId: session.id,
      type: 'session_status_changed',
      priority: 'high',
      content: '执行中补充需求已写入相关 Agent 上下文，正在重调度未完成任务。',
      metadata: createMetadata('system_notice', {
        status: session.status,
        reason: 'executing_user_interrupt_rescheduled',
        sourceEventId,
        affectedAgentIds,
        interruptTaskId,
        affectedTaskIds: unfinishedTasks.map((task) => task.id)
      })
    });
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

  savePendingInvocation(sessionId: string, invocation: PendingInvocation) {
    const session = this.get(sessionId);
    if (!session.pendingInvocations) {
      session.pendingInvocations = [];
    }
    session.pendingInvocations.push(invocation);
    this.persist();
    this.logger.log(
      `[Session ${sessionId}] Saved pending invocation ${invocation.invocationId} ` +
      `with ${invocation.pendingApprovals.length} approval(s) required`
    );
  }

  async retryPendingApprovalTasks(sessionId: string, approvedCapabilityId: string) {
    const session = this.get(sessionId);
    if (!session.pendingInvocations || session.pendingInvocations.length === 0) {
      return;
    }

    const toRetry = session.pendingInvocations.filter((inv) =>
      inv.pendingApprovals.some((a) => a.toolId === approvedCapabilityId)
    );

    if (toRetry.length === 0) {
      return;
    }

    this.logger.log(
      `[Session ${sessionId}] Found ${toRetry.length} pending invocation(s) to retry after capability approval`
    );

    for (const inv of toRetry) {
      // 重新检查所有待审批能力 - 可能需要多个审批
      const stillPending = inv.pendingApprovals.filter((a) => {
        try {
          const check = this.capabilities.checkInvocation(a.toolId, {
            sessionId: inv.sessionId,
            agentId: inv.agentId
          });
          return !check.allowed;
        } catch (err) {
          this.logger.warn(
            `[Session ${sessionId}] Failed to check capability ${a.toolId}: ${err}`
          );
          return true; // 保守起见,检查失败时认为仍需审批
        }
      });

      if (stillPending.length > 0) {
        // 仍有未授权的能力,更新状态但不重试
        inv.pendingApprovals = stillPending;
        this.persist();
        this.logger.log(
          `[Session ${sessionId}] Invocation ${inv.invocationId} still has ${stillPending.length} pending approval(s)`
        );
        continue;
      }

      // 所有审批完成,移除并触发重试
      session.pendingInvocations = session.pendingInvocations.filter(
        (i) => i.invocationId !== inv.invocationId
      );
      const task = this.tasks.find(sessionId, inv.taskId);
      if (task) this.tasks.update(task, { status: 'pending', resultSummary: undefined });
      this.resolveSupersededCapabilityRoutingConfirmations(sessionId);
      this.setStatus(session, 'EXECUTING');
      this.persist();

      this.logger.log(
        `[Session ${sessionId}] All approvals granted for invocation ${inv.invocationId}, triggering retry for task ${inv.taskId}`
      );

      // 异步重试,不阻塞当前响应
      setImmediate(() => {
        this.resumeExecution(session);
      });
    }
  }

  private persist() {
    this.persistence.setCollection('sessions', [...this.sessions.values()]);
  }

  private resolveSupersededCapabilityRoutingConfirmations(sessionId: string) {
    const events = this.events.list(sessionId);
    const resolvedIds = new Set(events
      .filter((event) => event.type === 'user_confirmation_resolved')
      .map((event) => (event.metadata.payload as { confirmationId?: string } | undefined)?.confirmationId)
      .filter((value): value is string => Boolean(value)));
    for (const event of events) {
      if (event.type !== 'user_confirmation_requested') continue;
      const payload = event.metadata.payload as {
        confirmationId?: string;
        reason?: string;
        description?: string;
      } | undefined;
      if (
        !payload?.confirmationId ||
        resolvedIds.has(payload.confirmationId) ||
        payload.reason !== 'coordinator_routing_needs_user_decision' ||
        !payload.description?.includes('HUMAN_APPROVAL_REQUIRED')
      ) continue;
      this.events.create({
        sessionId,
        type: 'user_confirmation_resolved',
        content: '能力授权已完成，旧的继续/取消确认已自动关闭。',
        metadata: createMetadata('system_notice', {
          confirmationId: payload.confirmationId,
          status: 'approved',
          selectedOptionKey: 'capabilities_approved'
        })
      });
    }
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
