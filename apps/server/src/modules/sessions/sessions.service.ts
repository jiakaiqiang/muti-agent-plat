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
import { existsSync } from 'node:fs';
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
  PendingConfirmationContext,
  PendingInvocation,
  PostReviewAction,
  RuntimeError,
  SessionDetail,
  SessionRecoveryCheckpoint,
  SessionFollowUpMessage,
  IntentRoutingRolloutMode,
  SessionStatus,
  RuntimePreference,
  SessionWorkingDirectory,
  SessionWorkspaceContext,
  TaskBrief,
  UserMessageHandlingPlan,
  WorkspaceWritebackRecord,
  WorkItem
,
  RequirementConfirmationBinding,
  WorkflowStartBinding
} from '@agent-cluster/shared';
import { matchesRequirementConfirmation, requirementConfirmationFingerprint } from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { executionProgressView } from '@agent-cluster/shared';
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
import {
  matchExactUserCommand,
  matchExecutionStatusQuestion,
  matchWorkflowAgentDirective,
  matchWorkflowAgentSkipCommand,
  type ExactCommandMatch,
  type WorkflowAgentDirectiveMatch,
  type WorkflowAgentSkipCommandMatch
} from '../intent-recognition/deterministic-command-guard.service.js';
import { SemanticIntentRouterService } from '../intent-recognition/semantic-intent-router.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
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
import { RequirementDocumentStore } from './requirement-document-store.js';
import { WorkflowStartStore } from '../workflows/workflow-start-store.js';
import { ChangeRequestStore } from './change-request-store.js';
import { evaluateWorkflowMemberMapping } from './workflow-member-mapping.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import { LocalRuntimeConnectionService } from '../local-runtime/local-runtime-connection.service.js';
import { WorkspaceProviderResolver } from '../workspaces/workspace-provider-resolver.js';
import { WorkspaceWritebackService } from '../workspaces/workspace-writeback.service.js';
import { validateServerLocalWorkspace } from '../workspaces/validate-server-local-workspace.js';
import { CapabilitiesService } from '../capabilities/capabilities.service.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { FileRevisionsService } from '../file-revisions/file-revisions.service.js';
import { RouteApplicationService } from '../message-routing/route-application.service.js';
import { MessageIngressService } from '../message-routing/message-ingress.service.js';
import { resolveExactCommand } from '../message-routing/command-state-resolver.service.js';
import { applyExactCommandResolution } from '../message-routing/command-application.service.js';

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

/**
 * Interruptions emit `session_status_changed`, not a failure event, so
 * `latestFailurePhase()` can never derive a phase for them. Recording the phase
 * at interruption time is the only reliable source. The vocabulary matches the
 * failure phases consumed by `retryFailedSession`, so both origins share one
 * brief-retry decision.
 */
const INTERRUPTION_PHASE_BY_STATUS: Partial<Record<SessionStatus, string>> = {
  AGENT_DISCUSSING: 'discussion',
  REVISING_BRIEF: 'brief_revision',
  EXECUTING: 'task_execution',
  POST_REVIEW: 'task_execution',
  REWORKING: 'task_execution'
};

/**
 * Cards whose pending state gives a typed Agent directive a deterministic meaning.
 * Outside these, "让前端工程师执行" is an ordinary requirement and stays on the
 * semantic router.
 */
const WORKFLOW_DIRECTIVE_CARD_REASONS = new Set([
  'workflow_agent_substitution',
  'workflow_upstream_rerun'
]);

/** Statuses where the Session is parked on the user and will need its Runtime again to move on. */
const WAITING_USER_SESSION_STATUSES = new Set<SessionStatus>([
  'WAIT_USER_CONFIRM',
  'WAIT_WORKFLOW_SELECT',
  'WAIT_WORKFLOW_STEP_CONFIRM',
  'WAIT_WORKSPACE_CONFLICT_RESOLUTION',
  'WAIT_USER_DECISION',
  'PAUSED'
]);

function normalizeDirectiveAlias(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\-_·、,，.。]/gu, '');
}

/**
 * Resolves operator text against a closed candidate set. Returns the single match,
 * `'ambiguous'` when several candidates match, or undefined when none do, so the
 * caller can ask back rather than picking a target the user did not name.
 */
export function matchSingleByAliases(
  target: string,
  candidates: Array<{ value: string; aliases: string[] }>
): string | 'ambiguous' | undefined {
  const needle = normalizeDirectiveAlias(target);
  if (needle.length < 2) return undefined;
  const exact = new Set<string>();
  const partial = new Set<string>();
  for (const candidate of candidates) {
    for (const alias of candidate.aliases) {
      const normalized = normalizeDirectiveAlias(alias ?? '');
      if (normalized.length < 2) continue;
      if (normalized === needle) exact.add(candidate.value);
      else if (normalized.includes(needle) || needle.includes(normalized)) partial.add(candidate.value);
    }
  }
  const resolved = exact.size ? exact : partial;
  if (resolved.size === 1) return [...resolved][0];
  return resolved.size > 1 ? 'ambiguous' : undefined;
}

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
  private readonly intentRoutingRuns = new Map<string, Promise<void>>();
  private readonly intentRoutingControllers = new Map<string, AbortController>();
  private readonly intentRoutingRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly intentRoutingWorkerId = `intent-routing:${process.pid}:${crypto.randomUUID()}`;
  private readonly deletingSessionIds = new Set<string>();
  private readonly fileRevisionDispatches = new Set<string>();
  private shuttingDown = false;
  private readonly runtimeInterruptingSessions = new Set<string>();
  private readonly runtimeInterruptSubscription?: Subscription;
  private readonly workspaceOfflineSubscription?: Subscription;
  private readonly runtimeStopSubscription?: Subscription;
  private readonly lifecycle: SessionLifecycleStore;
  /** Phase 4: immutable requirement document versions the confirmation binds to. */
  private readonly requirementDocuments: RequirementDocumentStore;
  /**
   * Phase 4: durable start requests. Submitting the decision and dispatching it
   * are separate steps so a retried click resolves to the run it already made,
   * and a dispatch that died mid-flight is recoverable instead of forking.
   */
  private readonly workflowStarts: WorkflowStartStore;
  /**
   * Phase 5: execution-time scope changes. One user message is one request, bound
   * to the requirement/document/run versions it was raised against, so a late
   * impact analysis cannot be shown against a requirement that already moved on.
   */
  private readonly changeRequests: ChangeRequestStore;

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
    @Optional() private readonly workspaceWritebacks?: WorkspaceWritebackService,
    @Optional() private readonly contextManagement?: ContextManagementService,
    @Optional() private readonly semanticIntentRouter?: SemanticIntentRouterService,
    @Optional() private readonly routeApplication?: RouteApplicationService,
    @Optional() private readonly messageIngress?: MessageIngressService,
    @Optional() private readonly artifacts?: ArtifactsService
  ) {
    this.lifecycle = new SessionLifecycleStore(persistence);
    this.requirementDocuments = new RequirementDocumentStore(persistence);
    this.workflowStarts = new WorkflowStartStore(persistence);
    this.changeRequests = new ChangeRequestStore(persistence);
    const persisted = this.persistence.getCollection<SessionDetail[]>('sessions', []);
    let recoveredWorkspaceWriteback = false;
    for (const session of persisted) {
      this.assertCurrentSchema(session);
      if (this.recoverWorkspaceWritebackState(session)) recoveredWorkspaceWriteback = true;
      this.sessions.set(session.id, session);
      if (this.lifecycle.get(session.id)?.state === 'deleting') this.deletingSessionIds.add(session.id);
    }
    if (recoveredWorkspaceWriteback) this.persist();
    for (const session of this.sessions.values()) {
      if (this.lifecycle.get(session.id)?.state !== 'active' && this.lifecycle.get(session.id)) continue;
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
    this.workspaceOfflineSubscription = this.localRuntime?.workspaceOffline?.().subscribe((offline) => {
      this.notifyLocalRuntimeOffline(offline.workspaceId);
    });
    this.runtimeStopSubscription = this.localRuntime?.stopConfirmations?.().subscribe(receipt => {
      if (!this.sessions.has(receipt.sessionId)) return;
      if (receipt.event) {
        this.events.acceptCommitted(receipt.event);
        return;
      }
      const summary = this.runtime?.getStopSummary(receipt.sessionId);
      if (!summary?.stopRequestId) return;
      this.events.createOnce(`runtime-stop:${summary.stopRequestId}:${summary.version}`, {
        sessionId: receipt.sessionId,
        type: 'runtime_progress',
        content: summary.canResume ? '执行已停止。' : `已确认 ${summary.confirmedCount}/${summary.requestedCount} 个停止目标。`,
        metadata: createMetadata('system_notice', {
          code: 'RUNTIME_STOP_STATE_CHANGED',
          runtimeInvocationId: receipt.invocationId,
          stopRequestId: summary.stopRequestId,
          version: summary.version,
          stopSummary: summary
        })
      });
    });
  }

  onModuleDestroy() {
    this.runtimeInterruptSubscription?.unsubscribe();
    this.workspaceOfflineSubscription?.unsubscribe();
    this.runtimeStopSubscription?.unsubscribe();
    for (const timer of this.intentRoutingRetryTimers.values()) clearTimeout(timer);
    this.intentRoutingRetryTimers.clear();
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

  list(visibility: 'active' | 'deleted' | 'all' = 'active') {
    return [...this.sessions.values()]
      .filter(session => {
        const state = this.lifecycle.get(session.id)?.state ?? 'active';
        return visibility === 'all' || (visibility === 'deleted' ? state === 'deleted' : state !== 'deleted');
      })
      .sort((left, right) => this.compareSessionRecency(left, right))
      .map((session) => {
        const lifecycle = this.lifecycle.get(session.id);
        return ({
        id: session.id,
        title: session.title,
        projectId: session.projectId,
        workspaceId: session.workspaceId,
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
        lifecycleState: lifecycle?.state ?? 'active',
        lifecycleGeneration: lifecycle?.generation,
        lifecycleRevision: lifecycle?.revision,
        deleteRequestId: lifecycle?.deleteRequestId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
        });
      });
  }

  get(sessionId: string) {
    const session = this.getIncludingDeleted(sessionId);
    const lifecycle = this.lifecycle.get(sessionId);
    if (lifecycle?.state !== undefined && lifecycle.state !== 'active') {
      throw new ConflictException({
        code: lifecycle.state === 'deleted' ? 'SESSION_DELETED' : 'SESSION_DELETING',
        message: lifecycle.state === 'deleted' ? '会话已删除，请先恢复后再操作。' : '会话正在删除，当前操作已被阻止。',
        lifecycle
      });
    }
    return session;
  }

  getIncludingDeleted(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }
    if (this.workspaceWritebacks) session.workspaceWritebacks = this.workspaceWritebacks.list(sessionId);
    return session;
  }

  lifecycleState(sessionId: string) {
    const session = this.getIncludingDeleted(sessionId);
    const lifecycle = this.lifecycle.get(sessionId);
    if (!lifecycle) throw new NotFoundException(`Session lifecycle not found: ${sessionId}`);
    const stopSummary = this.runtime?.getStopSummary?.(sessionId) ?? {
      sessionId, version: 0, status: lifecycle.stopStatus, requestedCount: 0, confirmedCount: 0,
      targets: [], blockers: lifecycle.stopStatus === 'idle' || lifecycle.stopStatus === 'confirmed' ? [] : [{
        reason: 'state_query_failed' as const, message: '停止状态服务不可用，无法确认会话已经停稳。'
      }], canResume: lifecycle.stopStatus === 'idle' || lifecycle.stopStatus === 'confirmed'
    };
    return { lifecycle, stopSummary, blockers: stopSummary.blockers, sessionStatus: session.status };
  }

  matchesActiveGeneration(sessionId: string, expectedGeneration?: number) {
    return this.lifecycle.matchesActiveGeneration(sessionId, expectedGeneration);
  }

  listWorkItems(sessionId: string) {
    this.get(sessionId);
    return this.contextManagement?.listWorkItems(sessionId) ?? [];
  }

  getWorkItem(sessionId: string, workItemId: string) {
    this.get(sessionId);
    if (!this.contextManagement) throw new ServiceUnavailableException('Context management is unavailable.');
    return this.contextManagement.getWorkItem(sessionId, workItemId);
  }

  async activateWorkItem(sessionId: string, workItemId: string) {
    const session = this.get(sessionId);
    if (!this.contextManagement) throw new ServiceUnavailableException('Context management is unavailable.');
    const previousWorkItemId = session.activeWorkItemId;
    const workItem = await this.contextManagement.activateWorkItem(session, workItemId);
    this.touchSession(session);
    this.events.create({
      sessionId,
      type: 'work_item_activated',
      content: `已切换到任务上下文：${workItem.title}`,
      metadata: createMetadata('system_notice', {
        workItemId: workItem.id,
        previousWorkItemId,
        workflowResumeTriggered: false
      })
    });
    return { workItem, workflowResumeTriggered: false };
  }

  listDecisions(sessionId: string) {
    this.get(sessionId);
    return this.contextManagement?.listDecisions(sessionId) ?? [];
  }

  getIntentRouting(sessionId: string, routingId: string) {
    this.get(sessionId);
    const routing = this.contextManagement?.listRoutingRecords(sessionId).find((item) => item.id === routingId);
    if (!routing) throw new NotFoundException(`IntentRoutingRecord not found: ${routingId}`);
    return routing;
  }

  debugIntentRouting(sessionId: string) {
    this.get(sessionId);
    if (!this.contextManagement) return { routings: [], snapshots: [] };
    return {
      routings: this.contextManagement.listRoutingRecords(sessionId),
      snapshots: this.contextManagement.listSnapshots(sessionId).map((snapshot) => ({
        id: snapshot.id,
        sourceEventId: snapshot.sourceEventId,
        activeWorkItemId: snapshot.activeWorkItemId,
        candidateWorkItemIds: snapshot.candidateWorkItemIds,
        validDecisionIds: snapshot.validDecisionIds,
        revision: snapshot.revision,
        snapshotHash: snapshot.snapshotHash,
        createdAt: snapshot.createdAt
      }))
    };
  }

  async clarifyIntentRouting(
    sessionId: string,
    routingId: string,
    input: {
      choice: 'continue_current' | 'related_new' | 'independent_new';
      confirmationId?: string;
    }
  ) {
    const session = this.get(sessionId);
    if (!this.contextManagement || !this.routeApplication) {
      throw new ServiceUnavailableException('Intent routing is unavailable.');
    }
    const routing = this.getIntentRouting(sessionId, routingId);
    const followUp = (session.pendingFollowUpMessages ?? []).find((item) => item.routingId === routingId) ??
      this.contextManagement.listFollowUps(sessionId).find((item) => item.routingId === routingId);
    if (routing.status === 'ROUTED') {
      return { routing, workItem: followUp?.workItemId
        ? this.contextManagement.getWorkItem(sessionId, followUp.workItemId)
        : this.contextManagement.activeWorkItem(session) };
    }
    if (routing.status !== 'CLARIFICATION_REQUIRED') {
      throw new ConflictException(`Intent routing is not waiting for clarification: ${routing.status}`);
    }
    if (!followUp) throw new NotFoundException(`Follow-up message not found for routing: ${routingId}`);
    if (!(session.pendingFollowUpMessages ?? []).some((item) => item.id === followUp.id)) {
      session.pendingFollowUpMessages = [...(session.pendingFollowUpMessages ?? []), followUp];
    }
    const active = this.contextManagement.activeWorkItem(session);
    if (!active) throw new ConflictException('No active WorkItem is available for clarification.');
    const snapshot = await this.contextManagement.buildIntentSnapshot({
      session,
      sourceEventId: routing.sourceEventId,
      currentMessage: followUp.content,
      latestEventSeq: this.events.list(sessionId).length,
      mentionedAgentIds: followUp.mentionedAgentIds,
      replyToEventId: followUp.replyToEventId,
      pendingConfirmation: this.pendingConfirmationSummary(sessionId),
      pendingConfirmationContext: this.pendingConfirmationContext(sessionId),
      failureCheckpoint: this.latestFailurePhase(sessionId)
    });
    await this.contextManagement.updateRoutingRecord(sessionId, routingId, {
      status: 'SNAPSHOT_READY',
      snapshotId: snapshot.id,
      reasonCodes: [...routing.reasonCodes, `USER_CLARIFIED_${input.choice.toUpperCase()}`]
    });
    await this.contextManagement.updateRoutingRecord(sessionId, routingId, { status: 'CLASSIFYING' });
    const related = input.choice === 'related_new';
    const independent = input.choice === 'independent_new';
    const decision = {
      dialogueAct: 'command' as const,
      scopeRelation: independent
        ? 'independent_new_requirement' as const
        : related ? 'related_new_requirement' as const : 'same_requirement' as const,
      contextPolicy: independent
        ? 'clean_task_context' as const
        : related ? 'inherit_selected' as const : 'inherit_confirmed' as const,
      requestedAction: independent
        ? 'create_independent_work_item' as const
        : related ? 'create_related_work_item' as const : 'continue_active_work_item' as const,
      selectedWorkItemId: active.id,
      selectedDecisionIds: related || !independent
        ? this.contextManagement.validDecisions(sessionId, active.id).map((item) => item.id)
        : [],
      selectedArtifactIds: related ? [...active.inheritedArtifactIds] : [],
      goalSegments: independent || related ? [followUp.content] : [],
      missingFields: [],
      ambiguityReasons: [],
      reasonCodes: [`USER_CLARIFIED_${input.choice.toUpperCase()}`],
      riskLevel: 'low' as const
    };
    const validation = {
      schemaValid: true,
      referencesValid: true,
      transitionValid: true,
      snapshotCurrent: true,
      safeToApply: true,
      serverConfidence: 1,
      errors: []
    };
    const validating = await this.contextManagement.updateRoutingRecord(sessionId, routingId, {
      status: 'VALIDATING',
      decision,
      validation
    });
    const confirmationResolvedEvent = this.events.createDraft({
      sessionId,
      type: 'user_confirmation_resolved',
      content: '任务关系已确认。',
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        routingId,
        status: 'approved',
        selectedOptionKey: input.choice
      })
    });
    const applied = await this.routeApplication.apply({
      session,
      snapshot,
      followUp,
      outcome: { routing: validating, decision, validation, autoApplicable: true },
      additionalEvents: [confirmationResolvedEvent]
    });
    followUp.workItemId = applied.workItem.id;
    followUp.handlingPlan = applied.handlingPlan;
    if (!applied.committedEvents?.some((event) => event.type === 'user_confirmation_resolved')) this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      content: '任务关系已确认。',
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        routingId,
        status: 'approved',
        selectedOptionKey: input.choice
      })
    });
    if (!applied.committedEvent) this.events.create({
      sessionId,
      type: applied.createdWorkItem ? 'work_item_created' : 'work_item_activated',
      content: applied.createdWorkItem
        ? `已创建任务上下文：${applied.workItem.title}`
        : `继续任务上下文：${applied.workItem.title}`,
      metadata: createMetadata('system_notice', {
        routingId,
        workItemId: applied.workItem.id,
        previousWorkItemId: applied.previousWorkItemId,
        inheritedDecisionIds: applied.workItem.inheritedDecisionIds,
        inheritedArtifactIds: applied.workItem.inheritedArtifactIds
      })
    });
    if (!this.hasActiveSessionWork(session)) this.scheduleFollowUpPlanning(sessionId);
    return { routing: applied.routing, workItem: applied.workItem };
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

  /**
   * Reconciles user-action state after a process restart. This only mutates the
   * durable checkpoint and confirmation audit; it never starts execution.
   */
  async reconcileRecoveryStateOnBoot(sessionId: string) {
    const session = this.get(sessionId);
    const events = this.events.list(sessionId);
    const resolvedIds = new Set(events
      .filter((event) => event.type === 'user_confirmation_resolved')
      .map((event) => (event.metadata.payload as { confirmationId?: unknown } | undefined)?.confirmationId)
      .filter((value): value is string => typeof value === 'string'));
    if (session.activeRecoveryCheckpoint && resolvedIds.has(session.activeRecoveryCheckpoint.confirmationId)) {
      session.activeRecoveryCheckpoint = undefined;
      this.persist();
    }

    const unresolvedRequests = events.filter((event) => {
      if (event.type !== 'user_confirmation_requested' && event.type !== 'intent_clarification_required') return false;
      const id = (event.metadata.payload as { confirmationId?: unknown } | undefined)?.confirmationId;
      return typeof id === 'string' && !resolvedIds.has(id);
    });
    const latestUnresolvedRequest = unresolvedRequests.at(-1);
    const structuredCurrent = session.status === 'WAIT_USER_DECISION' && latestUnresolvedRequest
      ? [latestUnresolvedRequest].find((event) => {
          const payload = event.metadata.payload as { actions?: unknown; reason?: unknown } | undefined;
          return (Array.isArray(payload?.actions) && payload.actions.length > 0) ||
            ['approve_local_runtime_permission', 'workflow_agent_substitution', 'confirm_workflow_step', 'confirm_workflow_human_gate'].includes(String(payload?.reason));
        })
      : undefined;
    if (
      structuredCurrent &&
      session.activeRecoveryCheckpoint &&
      (structuredCurrent.metadata.payload as { confirmationId?: unknown } | undefined)?.confirmationId !==
        session.activeRecoveryCheckpoint.confirmationId
    ) {
      session.activeRecoveryCheckpoint = undefined;
      this.persist();
    }
    for (const event of unresolvedRequests) {
      const id = (event.metadata.payload as { confirmationId?: unknown } | undefined)?.confirmationId;
      if (
        typeof id !== 'string' ||
        id === session.activeRecoveryCheckpoint?.confirmationId ||
        event.id === structuredCurrent?.id
      ) continue;
      const payload = event.metadata.payload as { reason?: unknown } | undefined;
      const shouldExpire = session.status === 'FAILED' || session.status === 'INTERRUPTED' ||
        session.status === 'WAIT_USER_DECISION';
      if (!shouldExpire) continue;
      this.events.createOnce(`recovery-expire-confirmation:${session.id}:${id}`, {
        sessionId,
        type: 'user_confirmation_resolved',
        content: '服务重启后该确认已过期，系统已创建新的恢复检查点。',
        metadata: createMetadata('system_notice', {
          confirmationId: id,
          status: 'expired',
          resolution: 'expired',
          reason: typeof payload?.reason === 'string' ? payload.reason : 'stale_confirmation',
          selectedOptionKey: 'expired_on_recovery'
        })
      });
    }

    const recoveryStatus = session.status;
    if (!session.activeRecoveryCheckpoint && (recoveryStatus === 'FAILED' || recoveryStatus === 'INTERRUPTED' || (recoveryStatus === 'WAIT_USER_DECISION' && !structuredCurrent))) {
      const reason = recoveryStatus === 'FAILED' ? 'retry_failed_execution' :
        recoveryStatus === 'INTERRUPTED' ? 'recover_interrupted_execution' :
          'coordinator_routing_needs_user_decision';
      if (recoveryStatus === 'WAIT_USER_DECISION' && session.workflowRunId && this.workflowRuntime) {
        try {
          this.workflowRuntime.checkpointInterruptedExecution?.(session.workflowRunId, {
            code: 'RECOVERY_STATE_REBUILT',
            message: '服务重启后重建用户决策恢复检查点。'
          });
        } catch (error) {
          this.logger.warn(`Failed to checkpoint stale workflow ${session.workflowRunId} during recovery: ${String(error)}`);
        }
      }
      const checkpoint = this.createRecoveryCheckpoint(session, reason);
      this.createRecoveryConfirmation(session, checkpoint, {
        content: recoveryStatus === 'FAILED'
          ? '服务重启后发现一个可重试的失败执行。'
          : recoveryStatus === 'INTERRUPTED'
            ? '服务重启后发现一个可恢复的中断执行。'
            : '当前工作流需要确认下一步，历史确认已过期。',
        title: recoveryStatus === 'FAILED' ? '重试失败执行' : '恢复当前执行',
        description: '会话上下文已保留。点击继续或发送“继续”后，将从当前检查点创建新的执行尝试。'
      });
    } else if (session.activeRecoveryCheckpoint && !unresolvedRequests.some((event) =>
      (event.metadata.payload as { confirmationId?: unknown } | undefined)?.confirmationId ===
        session.activeRecoveryCheckpoint?.confirmationId
    )) {
      this.createRecoveryConfirmation(session, session.activeRecoveryCheckpoint, {
        content: '服务重启后已恢复当前执行检查点。',
        title: '恢复当前执行',
        description: '会话上下文已保留。点击继续或发送“继续”后，将从当前检查点创建新的执行尝试。'
      });
    }
    this.persist();
    const workItemStatus = this.workItemStatusForSessionStatus(session.status);
    if (workItemStatus) {
      await this.retryActiveWorkItemStatus(session, workItemStatus);
    }
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

  async recoverIntentRoutings(sessionIds?: string[]) {
    if (!this.contextManagement || !this.semanticIntentRouter) return [];
    const allowed = sessionIds ? new Set(sessionIds) : undefined;
    const recovered: Array<{ sessionId: string; routingId: string; action: string }> = [];
    for (const session of this.sessions.values()) {
      if (allowed && !allowed.has(session.id)) continue;
      const records = [...this.contextManagement.listRoutingRecords(session.id)]
        .sort((left, right) => left.sessionSeq - right.sessionSeq);
      for (const routing of records) {
        const followUp = (session.pendingFollowUpMessages ?? []).find((item) => item.routingId === routing.id) ??
          this.contextManagement.listFollowUps(session.id).find((item) => item.routingId === routing.id);
        if (!followUp) continue;
        // `finish()` 把 shadow 下 autoApplicable 的判定也记成 ROUTED，所以没有这道
        // 门禁时，重启恢复会把从未打算执行的 pause/cancel 补跑一遍。判据是记录自身的
        // rolloutMode 而非当前进程的 rollout：动作该不该执行，由它被判定时的模式决定。
        const mayApplyControlAction = routing.rolloutMode !== 'shadow';
        const pendingControlAction = routing.status === 'ROUTED' &&
          mayApplyControlAction &&
          ['pause', 'cancel'].includes(routing.decision?.requestedAction ?? '') &&
          routing.actionStatus !== 'applied';
        if (['completed', 'failed', 'cancelled'].includes(followUp.status) && !pendingControlAction) {
          session.pendingFollowUpMessages = (session.pendingFollowUpMessages ?? []).filter((item) => item.id !== followUp.id);
          if (session.activeFollowUpMessageId === followUp.id) session.activeFollowUpMessageId = undefined;
          continue;
        }
        if (!(session.pendingFollowUpMessages ?? []).some((item) => item.id === followUp.id)) {
          session.pendingFollowUpMessages = [...(session.pendingFollowUpMessages ?? []), followUp];
          this.touchSession(session);
        }
        if (routing.status === 'ROUTED') {
          const action = routing.decision?.requestedAction;
          if (action === 'pause' && mayApplyControlAction && routing.actionStatus !== 'applied') {
            await this.applyPersistedRoutingAction(session, routing.id, followUp, 'pause');
            recovered.push({ sessionId: session.id, routingId: routing.id, action: 'pause_recovered' });
          } else if (action === 'cancel' && mayApplyControlAction && routing.actionStatus !== 'applied') {
            await this.applyPersistedRoutingAction(session, routing.id, followUp, 'cancel');
            recovered.push({ sessionId: session.id, routingId: routing.id, action: 'cancel_recovered' });
          }
          if (action === 'pause' || action === 'cancel') {
            if (routing.actionStatus === 'applied' && !['completed', 'failed', 'cancelled'].includes(followUp.status)) {
              await this.completeFollowUpRouting(
                session,
                followUp.id,
                action === 'cancel' ? 'cancelled' : 'completed'
              );
              recovered.push({
                sessionId: session.id,
                routingId: routing.id,
                action: `${action}_completion_recovered`
              });
            }
            continue;
          }
          const interruptedFollowUp = ['planning', 'executing'].includes(followUp.status) &&
            !this.execution.isRunning(session.id) &&
            !this.followUpPlanningRuns.has(session.id);
          if (interruptedFollowUp) {
            followUp.status = 'queued';
            session.activeFollowUpMessageId = undefined;
            await this.contextManagement.updateFollowUpStatus(session.id, followUp.id, 'queued');
          }
          // 启动路径保持保守：INTERRUPTED 从 hasActiveSessionWork 移出后，这里会开始
          // 自动重排任务，违反 recovery.service 的"运行时调用绝不自动重驱"边界（会重复
          // 执行命令、重复写文件）。只有用户真的发消息才唤醒。
          if (
            session.status !== 'INTERRUPTED' &&
            !this.hasActiveSessionWork(session) &&
            followUp.status === 'queued'
          ) {
            this.scheduleFollowUpPlanning(session.id);
            recovered.push({ sessionId: session.id, routingId: routing.id, action: 'follow_up_rescheduled' });
          }
          continue;
        }
        if (routing.status === 'CLARIFICATION_REQUIRED' || routing.status === 'REJECTED') continue;
        if (routing.status === 'CLASSIFYING' || routing.status === 'VALIDATING' || routing.status === 'APPLYING') {
          const leaseExpiresAt = Date.parse(routing.leaseExpiresAt ?? '');
          if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now()) {
            if (routing.snapshotId) {
              this.scheduleIntentRoutingRetry(
                session.id,
                routing.id,
                routing.snapshotId,
                followUp.id,
                followUp.handlingPlan.requirementRelation
              );
              recovered.push({ sessionId: session.id, routingId: routing.id, action: 'active_lease_preserved' });
            }
            continue;
          }
          await this.contextManagement.updateRoutingRecord(session.id, routing.id, {
            status: 'PENDING_RETRY',
            reasonCodes: [...routing.reasonCodes, 'RECOVERED_AFTER_RESTART']
          });
        }
        const snapshot = await this.contextManagement.buildIntentSnapshot({
          session,
          sourceEventId: routing.sourceEventId,
          currentMessage: followUp.content,
          latestEventSeq: this.events.list(session.id).length,
          mentionedAgentIds: followUp.mentionedAgentIds,
          replyToEventId: followUp.replyToEventId,
          pendingConfirmation: this.pendingConfirmationSummary(session.id),
          pendingConfirmationContext: this.pendingConfirmationContext(session.id),
          failureCheckpoint: this.latestFailurePhase(session.id)
        });
        await this.contextManagement.updateRoutingRecord(session.id, routing.id, {
          status: 'SNAPSHOT_READY',
          snapshotId: snapshot.id,
          reasonCodes: [...routing.reasonCodes, 'RECOVERED_AFTER_RESTART']
        });
        this.enqueueIntentRouting(
          session.id,
          routing.id,
          snapshot.id,
          followUp.id,
          followUp.handlingPlan.requirementRelation
        );
        recovered.push({ sessionId: session.id, routingId: routing.id, action: 'routing_requeued' });
      }
    }
    return recovered;
  }

  async delete(sessionId: string, deleteRequestId: string = crypto.randomUUID()) {
    this.persistence.assertWritable();
    if (this.shuttingDown) {
      throw new ServiceUnavailableException('后端正在关闭，请在服务重启后重试删除。');
    }
    const session = this.getIncludingDeleted(sessionId);
    const existingLifecycle = this.lifecycle.get(sessionId);
    if (existingLifecycle?.state === 'deleted') {
      const view = this.lifecycleState(sessionId);
      return { sessionId, deleted: true, ...view };
    }
    const begun = await this.lifecycle.beginDelete(sessionId, session.dataEpoch, deleteRequestId);
    if (begun.event) this.events.acceptCommitted(begun.event);
    this.deletingSessionIds.add(sessionId);
    session.status = 'PAUSED';
    session.updatedAt = nowIso();
    const termination = createExecutionTermination({
      kind: 'user_paused', source: 'user', scope: 'session', diagnosticRef: 'session_delete'
    });
    this.briefGenerationSeqBySession.set(sessionId, (this.briefGenerationSeqBySession.get(sessionId) ?? 0) + 1);
    this.cancelIntentRoutingRetries(sessionId);
    this.intentRoutingControllers.get(sessionId)?.abort(termination);
    const briefRun = this.briefGenerationRuns.get(sessionId);
    if (briefRun) abortWithTermination(briefRun.controller, termination);
    const [briefStopped, executionStopped, runtimeStopped] = await Promise.all([
      briefRun ? settlesWithin(briefRun.done, 10_000) : Promise.resolve(true),
      this.execution.cancelAndWait(sessionId, termination),
      this.runtime?.cancelSessionAndWait(sessionId, termination) ??
        Promise.resolve({ requested: 0, completed: 0, timedOut: false })
    ]);
    if (!briefStopped || executionStopped.timedOut || runtimeStopped.timedOut) {
      const view = this.lifecycleState(sessionId);
      const blockers = [...view.blockers];
      if (!briefStopped) blockers.push({ reason: 'process_running' as const, message: '需求讨论仍在停止中。' });
      if (executionStopped.timedOut) blockers.push({ reason: 'process_running' as const, message: '任务执行仍在停止中。' });
      if (runtimeStopped.timedOut && !blockers.length) blockers.push({
        reason: 'process_exit_unknown' as const, message: 'Runtime 尚未提供可信停止证据。'
      });
      return { sessionId, deleted: false, ...view, blockers };
    }
    const completed = await this.lifecycle.completeDelete(sessionId);
    if (completed.event) this.events.acceptCommitted(completed.event);
    if (completed.lifecycle.state === 'deleted') {
      this.deletingSessionIds.delete(sessionId);
      await this.persistence.releaseWorkspaceSessionLease(session.workspaceId, session.id).catch((error) => {
        this.logger.error(`Failed to release workspace session lease for ${session.workspaceId}: ${String(error)}`);
      });
    }
    return {
      sessionId,
      deleted: completed.lifecycle.state === 'deleted',
      lifecycle: completed.lifecycle,
      stopSummary: completed.stopSummary,
      blockers: completed.stopSummary.blockers,
      sessionStatus: session.status
    };
  }

  async restore(sessionId: string, input: { requestId: string; expectedGeneration: number }) {
    const session = this.getIncludingDeleted(sessionId);
    const lifecycle = this.lifecycle.get(sessionId);
    if (!lifecycle) throw new NotFoundException(`Session lifecycle not found: ${sessionId}`);
    if (session.workingDirectory?.kind === 'server_local' &&
      (!session.workingDirectory.path || !existsSync(session.workingDirectory.path))) {
      throw new ConflictException('会话工作目录已被移动或删除，无法安全恢复。');
    }
    if (session.workingDirectory?.kind === 'local_bridge' && !this.localRuntime?.getWorkspace(session.workspaceId)) {
      throw new ConflictException('本地 Runtime 工作区当前不可用，请连接本地助手后再恢复。');
    }
    const leaseAcquired = await this.persistence.acquireWorkspaceSessionLease(session.workspaceId, session.id);
    if (!leaseAcquired) throw new ConflictException('该工作区正被另一个活动会话使用，暂时无法恢复。');
    try {
      const restored = await this.lifecycle.restore(sessionId, input);
      if (restored.event) this.events.acceptCommitted(restored.event);
      session.status = 'PAUSED';
      session.pauseState = {
        previousStatus: session.pauseState?.previousStatus ?? 'EXECUTING',
        pausedAt: nowIso(),
        reason: 'session_restored'
      };
      session.updatedAt = nowIso();
      this.deletingSessionIds.delete(sessionId);
      return { session, lifecycle: restored.lifecycle, restored: true };
    } catch (error) {
      await this.persistence.releaseWorkspaceSessionLease(session.workspaceId, session.id).catch(() => undefined);
      if (String(error).includes('STALE_GENERATION')) throw new ConflictException('会话生命周期已变化，请刷新后重试。');
      if (String(error).includes('STOP_UNCONFIRMED')) throw new ConflictException('停止状态尚未确认，不能恢复会话。');
      throw error;
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
      revision: 1,
      decisionLedgerRevision: 0,
      intentRoutingGeneration: 'v2',
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
      try {
        const initialized = await this.lifecycle.initialize(session.id, dataEpoch);
        if (initialized.event) this.events.acceptCommitted(initialized.event);
      } catch (error) {
        this.sessions.delete(session.id);
        this.persist();
        await this.persistence.releaseWorkspaceSessionLease(workspaceId, sessionId).catch(() => undefined);
        throw error;
      }

      const firstEvent = this.events.create({
        sessionId: session.id,
        type: 'user_message',
        sessionUserId: session.ownerId,
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

      await this.contextManagement?.ensureInitialWorkItem(session, firstEvent.id, input.input);

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
      if (!input.runtimePreference?.preferredRuntimeType) {
        throw new BadRequestException('LOCAL_RUNTIME_REQUIRED: Select an available Runtime for the local workspace.');
      }
      const requestedRuntimeTypes = new Set([
        ...(input.runtimePreference?.preferredRuntimeType ? [input.runtimePreference.preferredRuntimeType] : []),
        ...(input.runtimePreference?.allowedRuntimeTypes ?? [])
      ]);
      for (const runtimeType of requestedRuntimeTypes) {
        if (!this.localRuntime?.isRuntimeAvailable(input.workingDirectory.id, runtimeType)) {
          throw new BadRequestException(
            `LOCAL_RUNTIME_UNAVAILABLE: Runtime ${runtimeType} is unavailable on the connected device.`
          );
        }
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
    const lifecycleGeneration = this.lifecycle.generation(session.id);
    if (!this.lifecycle.isActive(session.id, lifecycleGeneration)) return;
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
          !this.lifecycle.isActive(session.id, lifecycleGeneration) ||
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
        if (controller.signal.aborted || this.deletingSessionIds.has(session.id) ||
          !this.lifecycle.isActive(session.id, lifecycleGeneration)) return;
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

  async sendMessage(
    sessionId: string,
    content: string,
    mentionedAgentIds: string[] = [],
    clientMessageId?: string,
    replyToEventId?: string
  ) {
    const session = this.get(sessionId);
    const replay = this.findMessageReplay(session, clientMessageId);
    if (replay) return replay;
    const pendingConfirmation = this.pendingConfirmationContext(session.id);
    const workflowAgentSkip = matchWorkflowAgentSkipCommand(content);
    if (workflowAgentSkip && pendingConfirmation?.reason === 'workflow_agent_substitution') {
      return this.handleWorkflowAgentSkipMessage(
        session,
        content,
        mentionedAgentIds,
        clientMessageId,
        pendingConfirmation.confirmationId,
        workflowAgentSkip
      );
    }
    const workflowDirective = pendingConfirmation && WORKFLOW_DIRECTIVE_CARD_REASONS.has(pendingConfirmation.reason)
      ? matchWorkflowAgentDirective(content)
      : undefined;
    if (workflowDirective) {
      return this.handleWorkflowAgentDirectiveMessage(
        session,
        content,
        mentionedAgentIds,
        clientMessageId,
        pendingConfirmation!,
        workflowDirective
      );
    }
    const exactCommand = matchExactUserCommand(content);
    if (exactCommand) {
      return this.handleExactCommandMessage(session, content, mentionedAgentIds, clientMessageId, exactCommand);
    }
    // A plain "how far along are we" is answered from the run's own state. It
    // carries no requirement, so routing it through the classifier would spend a
    // model call to restate what the projection already knows (AC2).
    const statusQuestion = matchExecutionStatusQuestion(content);
    if (statusQuestion && !mentionedAgentIds.length) {
      return this.handleExecutionStatusQuestion(session, content, clientMessageId);
    }
    const routingMode = this.intentRoutingMode();
    const explicitPreference = this.intentRecognition
      .recognizeUserMessage(content, session.status).intent === 'preference_input';
    const budgetExhaustionRecovery = pendingConfirmation?.reason === 'work_item_budget_exhausted'
      ? pendingConfirmation.confirmationId
      : undefined;
    if (budgetExhaustionRecovery || this.shouldEnforceIntentRouting(session, routingMode)) {
      return this.sendMessageWithIntentV2(
        session,
        content,
        mentionedAgentIds,
        clientMessageId,
        routingMode,
        replyToEventId,
        budgetExhaustionRecovery,
        explicitPreference
      );
    }
    const receiverRecognitionPending = session.status === 'PAUSED';
    const useLocalIntentRecognition = receiverRecognitionPending;
    let handlingPlan: UserMessageHandlingPlan = useLocalIntentRecognition
      ? this.intentRecognition.recognizeUserMessage(content, session.status)
      : await this.recognizeFollowUpHandlingPlan(session, content, mentionedAgentIds);
    handlingPlan = this.normalizeFollowUpHandlingPlan(session, handlingPlan);
    const event = this.events.create({
      sessionId,
      type: 'user_message',
      sessionUserId: session.ownerId,
      userMessageIntent: handlingPlan.intent,
      priority: handlingPlan.priority,
      content,
      toAgentIds: mentionedAgentIds,
      metadata: {
        ...createMetadata('chat_message', { text: content, mentionedAgentIds }),
        ...(clientMessageId ? { idempotencyKey: this.messageIdempotencyKey(sessionId, clientMessageId) } : {})
      }
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
          ? '已收到后续消息，将在当前任务结束后处理。'
          : '已收到消息，正在准备后续处理。',
      metadata: createMetadata('chat_message', {
        messageKind: 'decision',
        handlingPlan,
        deferred,
        receiverRecognitionPending,
        receiverResponsibilities: ['intent_recognition', 'task_decomposition']
      })
    });

    if (explicitPreference || handlingPlan.intent === 'preference_input') {
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
      ...(replyToEventId ? { replyToEventId } : {}),
      receiverRecognitionPending: receiverRecognitionPending || undefined,
      status: 'queued',
      queuedAt: nowIso()
    };
    session.pendingFollowUpMessages = [...(session.pendingFollowUpMessages ?? []), followUp];

    if (routingMode !== 'disabled' && this.contextManagement && this.semanticIntentRouter) {
      const workItem = await this.contextManagement.ensureInitialWorkItem(session, event.id, session.originalInput);
      const routing = await this.contextManagement.createRoutingRecord({
        session,
        sourceEventId: event.id,
        idempotencyKey: `${session.id}:${event.id}:intent-v2.1`,
        rolloutMode: routingMode
      });
      const snapshot = await this.contextManagement.buildIntentSnapshot({
        session,
        sourceEventId: event.id,
        currentMessage: content,
        latestEventSeq: this.events.list(session.id).length,
        mentionedAgentIds: followUp.mentionedAgentIds,
        replyToEventId: followUp.replyToEventId,
        pendingConfirmation: this.pendingConfirmationSummary(session.id),
        pendingConfirmationContext: this.pendingConfirmationContext(session.id),
        failureCheckpoint: this.latestFailurePhase(session.id)
      });
      followUp.workItemId = workItem.id;
      followUp.routingId = routing.id;
      this.enqueueIntentRouting(session.id, routing.id, snapshot.id, followUp.id, handlingPlan.requirementRelation);
    }
    this.touchSession(session);
    await this.contextManagement?.saveFollowUp(session.id, followUp);

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

    return {
      event,
      handlingPlan,
      deferred,
      followUpMessageId: followUp.id,
      routingId: followUp.routingId,
      routingStatus: followUp.routingId ? 'SNAPSHOT_READY' as const : undefined,
      idempotentReplay: false as const
    };
  }

  private intentRoutingMode(): IntentRoutingRolloutMode {
    const configured = process.env.INTENT_ROUTING_MODE?.trim();
    const compatible = configured === 'enforce_existing_sessions'
      ? 'enforce_selected_sessions'
      : configured === 'enforce_all' ? 'enforce_all_current_epoch' : configured;
    return compatible && [
      'disabled',
      'shadow',
      'enforce_new_sessions',
      'enforce_selected_sessions',
      'enforce_all_current_epoch'
    ].includes(compatible)
      ? compatible as IntentRoutingRolloutMode
      : 'shadow';
  }

  private shouldEnforceIntentRouting(session: SessionDetail, mode: IntentRoutingRolloutMode) {
    if (mode === 'enforce_all_current_epoch') return session.dataEpoch === this.persistence.currentDataEpoch();
    if (mode === 'enforce_new_sessions') return session.intentRoutingGeneration === 'v2';
    if (mode === 'enforce_selected_sessions') {
      const selected = new Set((process.env.INTENT_ROUTING_SESSION_IDS ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean));
      return selected.has(session.id);
    }
    return false;
  }

  private async sendMessageWithIntentV2(
    session: SessionDetail,
    content: string,
    mentionedAgentIds: string[],
    clientMessageId: string | undefined,
    routingMode: IntentRoutingRolloutMode,
    replyToEventId?: string,
    budgetExhaustionConfirmationId?: string,
    explicitPreference = false
  ) {
    const handlingPlan = this.pendingIntentHandlingPlan();
    const deferred = this.hasActiveSessionWork(session);

    if (!this.contextManagement || !this.semanticIntentRouter || !this.routeApplication || !this.messageIngress) {
      throw new ServiceUnavailableException('Intent V2 routing services are unavailable.');
    }
    const committed = await this.messageIngress.commit({
      session,
      content,
      mentionedAgentIds,
      handlingPlan,
      routingMode,
      replyToEventId,
      messageIdempotencyKey: clientMessageId ? this.messageIdempotencyKey(session.id, clientMessageId) : undefined,
      ...(explicitPreference ? { preferenceConfirmation: {} } : {}),
      ...(budgetExhaustionConfirmationId ? { budgetExhaustionConfirmationId } : {})
    });
    const { event, followUp, routing, workItem } = committed;
    if (committed.idempotentReplay) {
      if (['RECEIVED', 'SNAPSHOT_READY', 'PENDING_RETRY', 'CLASSIFYING', 'VALIDATING', 'APPLYING'].includes(routing.status)) {
        const snapshot = [...this.contextManagement.listSnapshots(session.id)]
          .filter((item) => item.sourceEventId === event.id)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
        if (snapshot) {
          this.enqueueIntentRouting(session.id, routing.id, snapshot.id, followUp.id, followUp.handlingPlan.requirementRelation);
        } else {
          const rebuilt = await this.contextManagement.buildIntentSnapshot({
            session,
            sourceEventId: event.id,
            currentMessage: followUp.content,
            latestEventSeq: this.events.list(session.id).length,
            mentionedAgentIds: followUp.mentionedAgentIds,
            replyToEventId: followUp.replyToEventId,
            pendingConfirmation: this.pendingConfirmationSummary(session.id),
            pendingConfirmationContext: this.pendingConfirmationContext(session.id),
            failureCheckpoint: this.latestFailurePhase(session.id)
          });
          await this.contextManagement.updateRoutingRecord(session.id, routing.id, {
            status: 'SNAPSHOT_READY',
            snapshotId: rebuilt.id,
            reasonCodes: [...new Set([...routing.reasonCodes, 'SNAPSHOT_REBUILT_AFTER_REPLAY'])]
          });
          this.enqueueIntentRouting(session.id, routing.id, rebuilt.id, followUp.id, followUp.handlingPlan.requirementRelation);
        }
      }
      return {
        event,
        handlingPlan: followUp.handlingPlan,
        deferred,
        followUpMessageId: followUp.id,
        routingId: routing.id,
        routingStatus: routing.status,
        idempotentReplay: true as const
      };
    }
    let snapshot;
    try {
      snapshot = await this.contextManagement.buildIntentSnapshot({
        session,
        sourceEventId: event.id,
        currentMessage: content,
        latestEventSeq: this.events.list(session.id).length,
        mentionedAgentIds: followUp.mentionedAgentIds,
        replyToEventId: followUp.replyToEventId,
        pendingConfirmation: this.pendingConfirmationSummary(session.id),
        pendingConfirmationContext: this.pendingConfirmationContext(session.id),
        failureCheckpoint: this.latestFailurePhase(session.id)
      });
    } catch (error) {
      await this.contextManagement.updateRoutingRecord(session.id, routing.id, {
        status: 'PENDING_RETRY',
        reasonCodes: [...new Set([...routing.reasonCodes, 'SNAPSHOT_BUILD_FAILED'])]
      });
      this.events.create({
        sessionId: session.id,
        type: 'follow_up_queued',
        content: 'Message saved; intent recognition will retry after the context snapshot is available.',
        metadata: createMetadata('system_notice', {
          routingId: routing.id,
          followUpMessageId: followUp.id,
          workItemId: workItem.id,
          status: 'PENDING_RETRY',
          error: error instanceof Error ? error.message : String(error)
        })
      });
      return {
        event,
        handlingPlan,
        deferred,
        followUpMessageId: followUp.id,
        routingId: routing.id,
        routingStatus: 'PENDING_RETRY' as const,
        idempotentReplay: false as const
      };
    }
    this.events.create({
      sessionId: session.id,
      type: 'follow_up_queued',
      content: '消息已保存，正在识别它与当前任务的关系。',
      metadata: createMetadata('system_notice', {
        routingId: routing.id,
        followUpMessageId: followUp.id,
        workItemId: workItem.id,
        status: 'SNAPSHOT_READY'
      })
    });
    this.enqueueIntentRouting(session.id, routing.id, snapshot.id, followUp.id);
    return {
      event,
      handlingPlan,
      deferred,
      followUpMessageId: followUp.id,
      routingId: routing.id,
      routingStatus: 'SNAPSHOT_READY' as const,
      idempotentReplay: false as const
    };
  }

  private pendingIntentHandlingPlan(): UserMessageHandlingPlan {
    return {
      intent: 'clarification',
      priority: 'normal',
      shouldPause: false,
      affectedTaskIds: [],
      affectedAgentIds: [],
      requiresBriefRevision: false,
      requiresUserConfirmation: false,
      coordinatorInstruction: '等待系统意图识别完成。'
    };
  }

  /**
   * Answers a read-only progress question from the run's own state. No model is
   * called and no contract is touched: every stage name comes from the published
   * workflow snapshot, so the reply cannot name a stage the user never approved,
   * and a queued scope change is reported rather than hidden behind "still
   * running" (AC1/AC2).
   */
  private async handleExecutionStatusQuestion(
    session: SessionDetail,
    content: string,
    clientMessageId: string | undefined
  ) {
    const handlingPlan: UserMessageHandlingPlan = {
      intent: 'question',
      requirementRelation: 'continuation',
      failedExecutionAction: 'none',
      priority: 'normal',
      shouldPause: false,
      affectedTaskIds: [],
      affectedAgentIds: [],
      requiresBriefRevision: false,
      requiresUserConfirmation: false,
      coordinatorInstruction: '按当前执行状态直接回答，不改动已确认范围。'
    };
    const event = this.events.create({
      sessionId: session.id,
      type: 'user_message',
      sessionUserId: session.ownerId,
      userMessageIntent: handlingPlan.intent,
      priority: handlingPlan.priority,
      content,
      toAgentIds: [],
      metadata: {
        ...createMetadata('chat_message', { text: content, mentionedAgentIds: [], handlingPlan }),
        ...(clientMessageId ? { idempotencyKey: this.messageIdempotencyKey(session.id, clientMessageId) } : {})
      }
    });

    const run = this.workflowRuntime?.findBySession(session.id);
    const view = executionProgressView({
      ...(run
        ? {
            run: {
              status: run.status,
              ...(run.currentNodeId ? { currentNodeId: run.currentNodeId } : {}),
              nodes: (run.definitionSnapshot?.nodes ?? []).map((node) => ({
                id: node.id,
                type: node.type,
                ...(node.name ? { name: node.name } : {}),
                order: node.order
              })),
              pendingRevisionHandoff: Boolean(run.pendingRevisionHandoff),
              pendingUpstreamRerun: Boolean(run.pendingUpstreamRerun)
            }
          }
        : {}),
      tasks: this.tasks.list(session.id).map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        ...(task.workflowNodeId ? { workflowNodeId: task.workflowNodeId } : {})
      })),
      pendingChangeRequests: this.changeRequests.unresolved(session.id).map((item) => ({
        id: item.id,
        summary: item.summary,
        status: item.status
      }))
    });

    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    const text = this.formatExecutionProgressAnswer(view);
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      content: text,
      metadata: createMetadata('chat_message', {
        messageKind: 'answer',
        text,
        phase: 'execution_status_answer',
        executionProgress: view
      })
    });
    this.touchSession(session);
    return {
      event,
      handlingPlan,
      deferred: false as const,
      followUpMessageId: undefined,
      routingId: undefined,
      routingStatus: undefined,
      idempotentReplay: false as const
    };
  }

  /** Fixed phrasing over projected state; nothing here is model output. */
  private formatExecutionProgressAnswer(view: ReturnType<typeof executionProgressView>) {
    const lines: string[] = [view.headline];
    if (view.currentStage) lines.push(`当前环节：${view.currentStage}`);
    if (view.completedStages.length) lines.push(`已完成：${view.completedStages.join('、')}`);
    if (view.remainingStages.length) lines.push(`还未开始：${view.remainingStages.join('、')}`);
    if (view.awaitingUser) {
      const reason = view.waitReason === 'revision_handoff'
        ? '需要你决定如何处理返工'
        : view.waitReason === 'upstream_rerun'
          ? '需要你选择退回哪个上游节点'
          : '需要你确认后才能继续';
      lines.push(`正在等待：${reason}`);
    }
    for (const task of view.attentionTasks) {
      lines.push(`需要关注：${task.title}（${task.reason === 'blocked' ? '受阻' : '失败'}）`);
    }
    for (const change of view.pendingChanges) {
      lines.push(`待处理的范围变更：${change.summary}${change.awaitingUser ? '（等待你选择）' : '（已暂缓）'}`);
    }
    return lines.join('\n');
  }

  private async handleExactCommandMessage(
    session: SessionDetail,
    content: string,
    mentionedAgentIds: string[],
    clientMessageId: string | undefined,
    exactCommand: ExactCommandMatch
  ) {
    const resolution = resolveExactCommand({
      command: exactCommand,
      sessionStatus: session.status,
      pendingConfirmation: this.pendingConfirmationContext(session.id),
      hasFailedWorkflowRun: this.hasFailedWorkflowRun(session)
    });
    const resumesExecution = resolution.action === 'resume_session' || resolution.action === 'retry_current';
    const handlingPlan: UserMessageHandlingPlan = {
      intent: 'command',
      requirementRelation: 'continuation',
      failedExecutionAction: resumesExecution ? 'resume' : 'none',
      priority: ['resume', 'retry', 'pause', 'cancel'].includes(exactCommand.command) ? 'high' : 'normal',
      shouldPause: resolution.action === 'pause_session',
      affectedTaskIds: [],
      affectedAgentIds: [],
      requiresBriefRevision: false,
      requiresUserConfirmation: resolution.action === 'clarify',
      coordinatorInstruction: resolution.message
    };
    const event = this.events.create({
      sessionId: session.id,
      type: 'user_message',
      sessionUserId: session.ownerId,
      userMessageIntent: handlingPlan.intent,
      priority: handlingPlan.priority,
      content,
      toAgentIds: mentionedAgentIds,
      metadata: {
        ...createMetadata('chat_message', {
          text: content,
          mentionedAgentIds,
          handlingPlan,
          exactCommand,
          commandResolution: resolution
        }),
        ...(clientMessageId ? { idempotencyKey: this.messageIdempotencyKey(session.id, clientMessageId) } : {})
      }
    });

    await applyExactCommandResolution({
      resolution,
      port: {
        resume: (confirmationId) => this.resume(session.id, resolution.message, confirmationId),
        retryCurrent: (confirmationId) => this.resume(session.id, resolution.message, confirmationId),
        pause: () => this.pause(session.id, resolution.message),
        cancel: () => this.control(session.id, 'CANCELLED', resolution.message)
      }
    });

    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      toAgentIds: mentionedAgentIds,
      content: resolution.message,
      metadata: createMetadata('chat_message', {
        messageKind: 'decision',
        phase: 'exact_command_routing',
        handlingPlan,
        exactCommand,
        commandResolution: resolution
      })
    });
    this.touchSession(session);

    return {
      event,
      handlingPlan,
      deferred: false as const,
      followUpMessageId: undefined,
      routingId: undefined,
      routingStatus: undefined,
      idempotentReplay: false as const
    };
  }

  private async handleWorkflowAgentSkipMessage(
    session: SessionDetail,
    content: string,
    mentionedAgentIds: string[],
    clientMessageId: string | undefined,
    confirmationId: string,
    directive: WorkflowAgentSkipCommandMatch
  ) {
    if (session.status !== 'WAIT_USER_DECISION' || !this.workflowRuntime || !session.workflowRunId) {
      throw new BadRequestException('当前没有可跳过的工作流 Agent。');
    }
    const request = this.assertPendingConfirmation(session.id, confirmationId, 'workflow_agent_substitution');
    const payload = request.metadata.payload as {
      relatedTaskId?: string;
      workflowRunId?: string;
    } | undefined;
    if (!payload?.relatedTaskId || payload.workflowRunId !== session.workflowRunId) {
      throw new BadRequestException('待跳过的工作流 Agent 与当前运行不匹配。');
    }
    const handlingPlan: UserMessageHandlingPlan = {
      intent: 'command',
      requirementRelation: 'continuation',
      failedExecutionAction: 'none',
      priority: 'high',
      shouldPause: false,
      affectedTaskIds: [payload.relatedTaskId],
      affectedAgentIds: [],
      requiresBriefRevision: false,
      requiresUserConfirmation: false,
      coordinatorInstruction: '跳过当前工作流 Agent，并从下一节点继续执行。'
    };
    const event = this.events.create({
      sessionId: session.id,
      type: 'user_message',
      sessionUserId: session.ownerId,
      userMessageIntent: 'command',
      priority: 'high',
      content,
      toAgentIds: mentionedAgentIds,
      metadata: {
        ...createMetadata('chat_message', {
          text: content,
          mentionedAgentIds,
          handlingPlan,
          workflowAgentSkip: directive
        }),
        ...(clientMessageId ? { idempotencyKey: this.messageIdempotencyKey(session.id, clientMessageId) } : {})
      }
    });

    await this.workflowRuntime.skipCurrentAgent({
      runId: session.workflowRunId,
      taskId: payload.relatedTaskId,
      reason: content,
      confirmationId
    });
    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_resolved',
      priority: 'high',
      content: '用户已跳过当前工作流 Agent，工作流从下一节点继续执行。',
      metadata: createMetadata('system_notice', {
        confirmationId,
        status: 'approved',
        selectedOptionKey: 'skip_agent',
        relatedTaskId: payload.relatedTaskId,
        workflowRunId: session.workflowRunId
      })
    });
    this.setStatus(session, 'EXECUTING');
    this.touchSession(session);
    return {
      event,
      handlingPlan,
      deferred: false as const,
      followUpMessageId: undefined,
      routingId: undefined,
      routingStatus: undefined,
      idempotentReplay: false as const
    };
  }

  /**
   * Applies a typed workflow directive that names an Agent or an upstream node,
   * so "让前端工程师执行" and "退回架构设计节点重新执行" resolve the pending card
   * without clicking. The target is matched against the card's own candidate list,
   * so an unknown or ambiguous name asks back instead of guessing.
   */
  private async handleWorkflowAgentDirectiveMessage(
    session: SessionDetail,
    content: string,
    mentionedAgentIds: string[],
    clientMessageId: string | undefined,
    pendingConfirmation: PendingConfirmationContext,
    directive: WorkflowAgentDirectiveMatch
  ) {
    const resolution = this.resolveWorkflowDirectiveTarget(session, pendingConfirmation, directive);
    const handlingPlan: UserMessageHandlingPlan = {
      intent: 'command',
      requirementRelation: 'continuation',
      failedExecutionAction: 'none',
      priority: 'high',
      shouldPause: false,
      affectedTaskIds: [],
      affectedAgentIds: resolution.kind === 'assign_agent' ? [resolution.agentId] : [],
      requiresBriefRevision: false,
      requiresUserConfirmation: resolution.kind === 'clarify',
      coordinatorInstruction: resolution.kind === 'clarify'
        ? resolution.message
        : directive.kind === 'assign_agent'
          ? '按用户指定的 Agent 改派当前工作流节点。'
          : '按用户指定的上游节点退回重新执行。'
    };
    const event = this.events.create({
      sessionId: session.id,
      type: 'user_message',
      sessionUserId: session.ownerId,
      userMessageIntent: 'command',
      priority: 'high',
      content,
      toAgentIds: mentionedAgentIds,
      metadata: {
        ...createMetadata('chat_message', {
          text: content,
          mentionedAgentIds,
          handlingPlan,
          workflowDirective: directive,
          directiveResolution: resolution.kind
        }),
        ...(clientMessageId ? { idempotencyKey: this.messageIdempotencyKey(session.id, clientMessageId) } : {})
      }
    });

    if (resolution.kind === 'clarify') {
      const coordinator = this.pickSessionAgent(session, ['coordinator']);
      this.events.create({
        sessionId: session.id,
        type: 'agent_message',
        fromAgentId: coordinator.id,
        content: resolution.message,
        metadata: createMetadata('chat_message', {
          messageKind: 'decision',
          phase: 'workflow_directive_routing',
          handlingPlan,
          workflowDirective: directive,
          candidates: resolution.candidates
        })
      });
      this.touchSession(session);
      return {
        event,
        handlingPlan,
        deferred: false as const,
        followUpMessageId: undefined,
        routingId: undefined,
        routingStatus: undefined,
        idempotentReplay: false as const
      };
    }

    if (resolution.kind === 'assign_agent') {
      await this.resolveWorkflowAgentSubstitution(session.id, {
        confirmationId: pendingConfirmation.confirmationId,
        taskId: resolution.taskId,
        agentId: resolution.agentId
      });
    } else {
      await this.resolveWorkflowUpstreamRerun(session.id, {
        confirmationId: pendingConfirmation.confirmationId,
        decision: 'rerun_upstream',
        nodeId: resolution.nodeId,
        instruction: content
      });
    }
    return {
      event,
      handlingPlan,
      deferred: false as const,
      followUpMessageId: undefined,
      routingId: undefined,
      routingStatus: undefined,
      idempotentReplay: false as const
    };
  }

  private resolveWorkflowDirectiveTarget(
    session: SessionDetail,
    pendingConfirmation: PendingConfirmationContext,
    directive: WorkflowAgentDirectiveMatch
  ):
    | { kind: 'assign_agent'; agentId: string; taskId: string }
    | { kind: 'rerun_upstream'; nodeId: string }
    | { kind: 'clarify'; message: string; candidates: string[] } {
    if (pendingConfirmation.reason === 'workflow_upstream_rerun') {
      const pending = session.workflowRunId
        ? this.workflowRuntime?.pendingUpstreamRerun(session.workflowRunId)
        : undefined;
      const candidates = pending?.candidates ?? [];
      const labels = candidates.map((candidate) => `${candidate.nodeName}（${candidate.agentName}）`);
      // On this card both phrasings mean the same thing: the named stage re-runs.
      const matched = matchSingleByAliases(directive.targetText, candidates.map((candidate) => ({
        value: candidate.nodeId,
        aliases: [candidate.nodeName, candidate.agentName, candidate.agentId]
      })));
      if (matched === 'ambiguous' || !matched) {
        return {
          kind: 'clarify',
          message: matched === 'ambiguous'
            ? `「${directive.targetText}」同时匹配到多个上游节点，请直接点击卡片中的节点，或写明唯一名称。可选：${labels.join('、') || '无'}`
            : `没有匹配到名为「${directive.targetText}」的上游节点。可退回的节点：${labels.join('、') || '无'}`,
          candidates: labels
        };
      }
      return { kind: 'rerun_upstream', nodeId: matched };
    }

    const payload = this.pendingConfirmationPayload(session.id, pendingConfirmation.confirmationId);
    const candidateAgentIds = Array.isArray(payload?.candidateAgentIds)
      ? payload.candidateAgentIds.filter((id): id is string => typeof id === 'string')
      : [];
    const taskId = typeof payload?.relatedTaskId === 'string' ? payload.relatedTaskId : undefined;
    const candidates = candidateAgentIds.flatMap((agentId) => {
      try {
        const agent = this.agents.getForSurface(agentId, 'workflow');
        return [{ value: agent.id, aliases: [agent.name, agent.key, agent.role ?? ''], label: agent.name }];
      } catch {
        return [];
      }
    });
    const labels = candidates.map((candidate) => candidate.label);
    if (!taskId || !candidates.length) {
      return {
        kind: 'clarify',
        message: '当前改派卡没有可用的候选 Agent，请直接在卡片中选择操作。',
        candidates: labels
      };
    }
    const matched = matchSingleByAliases(directive.targetText, candidates);
    if (matched === 'ambiguous' || !matched) {
      return {
        kind: 'clarify',
        message: matched === 'ambiguous'
          ? `「${directive.targetText}」同时匹配到多个 Agent，请写明唯一名称。可选：${labels.join('、')}`
          : `没有匹配到名为「${directive.targetText}」的候选 Agent。可选：${labels.join('、')}`,
        candidates: labels
      };
    }
    return { kind: 'assign_agent', agentId: matched, taskId };
  }

  private pendingConfirmationPayload(sessionId: string, confirmationId: string) {
    const request = this.events.list(sessionId).find(
      (event) =>
        event.type === 'user_confirmation_requested' &&
        (event.metadata.payload as { confirmationId?: string } | undefined)?.confirmationId === confirmationId
    );
    return request?.metadata.payload as {
      relatedTaskId?: unknown;
      candidateAgentIds?: unknown[];
    } | undefined;
  }

  private findMessageReplay(session: SessionDetail, clientMessageId?: string) {
    if (clientMessageId === undefined) return undefined;
    const normalized = clientMessageId.trim();
    if (!normalized || normalized.length > 200) {
      throw new BadRequestException('Idempotency-Key must contain 1-200 characters.');
    }
    const key = this.messageIdempotencyKey(session.id, normalized);
    const event = this.events.list(session.id).find((item) => item.metadata.idempotencyKey === key);
    if (!event) return undefined;
    const followUp = (session.pendingFollowUpMessages ?? []).find((item) => item.sourceEventId === event.id) ??
      this.contextManagement?.listFollowUps(session.id).find((item) => item.sourceEventId === event.id);
    const routing = followUp?.routingId
      ? this.contextManagement?.listRoutingRecords(session.id).find((item) => item.id === followUp.routingId)
      : undefined;
    const persistedHandlingPlan = (event.metadata.payload as {
      handlingPlan?: UserMessageHandlingPlan;
    } | undefined)?.handlingPlan;
    return {
      event,
      handlingPlan: followUp?.handlingPlan ?? persistedHandlingPlan ?? this.pendingIntentHandlingPlan(),
      deferred: Boolean(followUp),
      followUpMessageId: followUp?.id,
      routingId: routing?.id,
      routingStatus: routing?.status,
      idempotentReplay: true as const
    };
  }

  private messageIdempotencyKey(sessionId: string, clientMessageId: string) {
    return `message:${sessionId}:${clientMessageId.trim()}`;
  }

  private pendingConfirmationSummary(sessionId: string) {
    return this.pendingConfirmationContext(sessionId)?.content;
  }

  private pendingConfirmationContext(sessionId: string): PendingConfirmationContext | undefined {
    const events = this.events.list(sessionId);
    const resolvedIds = new Set(events.flatMap((event) => {
      if (event.type !== 'user_confirmation_resolved') return [];
      const confirmationId = (event.metadata.payload as { confirmationId?: unknown } | undefined)?.confirmationId;
      return typeof confirmationId === 'string' ? [confirmationId] : [];
    }));
    const activeCheckpoint = this.sessions.get(sessionId)?.activeRecoveryCheckpoint;
    if (activeCheckpoint && !resolvedIds.has(activeCheckpoint.confirmationId)) {
      const activeRequest = [...events].reverse().find((event) => {
        if (event.type !== 'user_confirmation_requested' && event.type !== 'intent_clarification_required') return false;
        return (event.metadata.payload as { confirmationId?: unknown } | undefined)?.confirmationId ===
          activeCheckpoint.confirmationId;
      });
      const activeContext = activeRequest
        ? this.confirmationContextFromEvent(activeRequest)
        : undefined;
      if (activeContext) return activeContext;
    }
    const pending: PendingConfirmationContext[] = [];
    for (const event of [...events].reverse()) {
      if (event.type !== 'user_confirmation_requested' && event.type !== 'intent_clarification_required') continue;
      const context = this.confirmationContextFromEvent(event);
      if (!context || resolvedIds.has(context.confirmationId)) continue;
      pending.push(context);
    }
    return pending.length === 1 ? pending[0] : undefined;
  }

  private confirmationContextFromEvent(event: CollaborationEvent): PendingConfirmationContext | undefined {
    const payload = event.metadata.payload as {
      confirmationId?: unknown;
      reason?: unknown;
      title?: unknown;
      description?: unknown;
      options?: unknown;
      actions?: unknown;
    } | undefined;
    if (typeof payload?.confirmationId !== 'string') return undefined;
    const options: PendingConfirmationContext['options'] = Array.isArray(payload.options)
      ? payload.options.flatMap((option): PendingConfirmationContext['options'] => {
          if (!option || typeof option !== 'object') return [];
          const candidate = option as { key?: unknown; label?: unknown; style?: unknown };
          if (typeof candidate.key !== 'string' || typeof candidate.label !== 'string') return [];
          const style: PendingConfirmationContext['options'][number]['style'] =
            candidate.style === 'primary' || candidate.style === 'default' || candidate.style === 'danger'
              ? candidate.style
              : undefined;
          return [{ key: candidate.key, label: candidate.label, ...(style ? { style } : {}) }];
        })
      : [];
    return {
      confirmationId: payload.confirmationId,
      reason: typeof payload.reason === 'string' ? payload.reason : 'unspecified',
      content: event.content,
      ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
      ...(typeof payload.description === 'string' ? { description: payload.description } : {}),
      options,
      requiresStructuredAction: Array.isArray(payload.actions) && payload.actions.length > 0,
      createdAt: event.createdAt
    };
  }

  private enqueueIntentRouting(
    sessionId: string,
    routingId: string,
    snapshotId: string,
    followUpId: string,
    legacyRelation?: UserMessageHandlingPlan['requirementRelation']
  ) {
    const previous = this.intentRoutingRuns.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() =>
      this.processIntentRouting(sessionId, routingId, snapshotId, followUpId, legacyRelation)
    ).catch(async (error) => {
      if (String(error).includes('ROUTING_LEASE_LOST')) return;
      const current = this.contextManagement?.listRoutingRecords(sessionId).find((item) => item.id === routingId);
      if (current && ['CLASSIFYING', 'VALIDATING', 'APPLYING', 'PENDING_RETRY'].includes(current.status)) {
        await this.contextManagement?.updateRoutingRecord(sessionId, routingId, {
          status: 'PENDING_RETRY',
          reasonCodes: [...new Set([...current.reasonCodes, 'ROUTING_PROCESSING_FAILED'])]
        }).catch(() => undefined);
        this.scheduleIntentRoutingRetry(sessionId, routingId, snapshotId, followUpId, legacyRelation);
      }
      this.logger.warn(`Intent routing failed for session ${sessionId}: ${String(error)}`);
    }).finally(() => {
      if (this.intentRoutingRuns.get(sessionId) === run) this.intentRoutingRuns.delete(sessionId);
    });
    this.intentRoutingRuns.set(sessionId, run);
  }

  private scheduleIntentRoutingRetry(
    sessionId: string,
    routingId: string,
    snapshotId: string,
    followUpId: string,
    legacyRelation?: UserMessageHandlingPlan['requirementRelation']
  ) {
    if (this.shuttingDown || this.sessions.get(sessionId)?.status === 'PAUSED') return;
    const key = `${sessionId}:${routingId}`;
    if (this.intentRoutingRetryTimers.has(key)) return;
    const retryCount = this.contextManagement?.listRoutingRecords(sessionId)
      .find((item) => item.id === routingId)?.retryCount ?? 0;
    const delay = Math.min(5_000, 250 * 2 ** Math.min(retryCount, 4));
    const timer = setTimeout(() => {
      this.intentRoutingRetryTimers.delete(key);
      this.enqueueIntentRouting(sessionId, routingId, snapshotId, followUpId, legacyRelation);
    }, delay);
    timer.unref?.();
    this.intentRoutingRetryTimers.set(key, timer);
  }

  /** Drops every pending intent routing retry owned by one session. */
  private cancelIntentRoutingRetries(sessionId: string) {
    const prefix = `${sessionId}:`;
    for (const [key, timer] of this.intentRoutingRetryTimers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.intentRoutingRetryTimers.delete(key);
    }
  }

  private async processIntentRouting(
    sessionId: string,
    routingId: string,
    snapshotId: string,
    followUpId: string,
    legacyRelation?: UserMessageHandlingPlan['requirementRelation']
  ) {
    const startedAt = Date.now();
    const session = this.sessions.get(sessionId);
    const lifecycleGeneration = this.lifecycle.generation(sessionId);
    if (!session || this.deletingSessionIds.has(sessionId) || session.status === 'PAUSED' ||
      !this.lifecycle.isActive(sessionId, lifecycleGeneration)) return;
    const routingController = new AbortController();
    this.intentRoutingControllers.set(sessionId, routingController);
    try {
      if (!this.contextManagement) return;
      const claim = await this.contextManagement.claimIntentRouting(
        session.id,
        routingId,
        snapshotId,
        `${this.intentRoutingWorkerId}:${crypto.randomUUID()}`,
        150_000
      );
      if (!this.lifecycle.isActive(sessionId, lifecycleGeneration)) return;
      if (claim.state === 'terminal') return;
      if (claim.state === 'blocked') {
        const blocking = claim.blockingRouting;
        if (blocking?.snapshotId) {
          const blockingFollowUp = this.contextManagement.listFollowUps(session.id)
            .find((item) => item.routingId === blocking.id);
          if (blockingFollowUp) {
            this.scheduleIntentRoutingRetry(
              sessionId,
              blocking.id,
              blocking.snapshotId,
              blockingFollowUp.id
            );
          }
        }
        this.scheduleIntentRoutingRetry(sessionId, routingId, snapshotId, followUpId, legacyRelation);
        return;
      }
      const routing = claim.routing;
      const snapshot = this.contextManagement?.listSnapshots(session.id).find((item) => item.id === snapshotId);
      if (!routing || !snapshot || !this.semanticIntentRouter) return;
      const outcome = await this.semanticIntentRouter.classify(session, routing, snapshot, routingController.signal);
      if (routingController.signal.aborted || String(session.status) === 'PAUSED') return;
      if (
        outcome.validation.errors.includes('SNAPSHOT_STALE') &&
        await this.contextManagement.reserveRoutingRebuild(sessionId, routingId)
      ) {
        workspaceMetrics.increment('intent_route_stale_snapshot_total');
        const followUp = session.pendingFollowUpMessages?.find((item) => item.id === followUpId) ??
          this.contextManagement.listFollowUps(session.id).find((item) => item.id === followUpId);
        if (!followUp) return;
        const rebuilt = await this.contextManagement.buildIntentSnapshot({
          session,
          sourceEventId: routing.sourceEventId,
          currentMessage: followUp.content,
          latestEventSeq: this.events.list(session.id).length,
          mentionedAgentIds: followUp.mentionedAgentIds,
          replyToEventId: followUp.replyToEventId,
          pendingConfirmation: this.pendingConfirmationSummary(session.id),
          pendingConfirmationContext: this.pendingConfirmationContext(session.id),
          failureCheckpoint: this.latestFailurePhase(session.id)
        });
        await this.contextManagement.updateRoutingRecord(session.id, routingId, {
          status: 'SNAPSHOT_READY',
          snapshotId: rebuilt.id,
          reasonCodes: [...new Set([...outcome.routing.reasonCodes, 'SNAPSHOT_REBUILT'])]
        });
        this.enqueueIntentRouting(sessionId, routingId, rebuilt.id, followUpId, legacyRelation);
        return;
      }
      if (routing.rolloutMode === 'shadow') {
        const v2Continuation = outcome.decision.scopeRelation === 'same_requirement';
        const legacyContinuation = legacyRelation === 'continuation';
        const shadowResult = v2Continuation === legacyContinuation ? 'shadow_match' : 'shadow_difference';
        await this.contextManagement.updateRoutingRecord(session.id, routingId, {
          reasonCodes: [
            ...outcome.routing.reasonCodes,
            v2Continuation === legacyContinuation ? 'SHADOW_MATCH' : 'SHADOW_DIFFERENCE'
          ]
        });
        workspaceMetrics.increment('intent_route_total', 1, {
          relation: outcome.decision.scopeRelation,
          action: outcome.decision.requestedAction,
          result: shadowResult
        });
        workspaceMetrics.observe('intent_route_latency_ms', Date.now() - startedAt, { result: shadowResult });
        return;
      }
      const followUp = session.pendingFollowUpMessages?.find((item) => item.id === followUpId);
      if (!followUp) return;
      if (!outcome.autoApplicable) {
        const reason = intentClarificationMetricReason(outcome.validation.errors);
        workspaceMetrics.increment('intent_route_total', 1, {
          relation: outcome.decision.scopeRelation,
          action: outcome.decision.requestedAction,
          result: 'clarification_required'
        });
        workspaceMetrics.increment('intent_route_clarification_total', 1, { reason });
        workspaceMetrics.observe('intent_route_latency_ms', Date.now() - startedAt, {
          result: 'clarification_required'
        });
        this.emitIntentClarification(session, followUp, outcome.routing.reasonCodes);
        return;
      }
      if (!this.routeApplication) throw new ServiceUnavailableException('Route application service is unavailable.');
      const applied = await this.routeApplication.apply({ session, snapshot, followUp, outcome });
      if (routingController.signal.aborted || String(session.status) === 'PAUSED') return;
      workspaceMetrics.increment('intent_route_total', 1, {
        relation: outcome.decision.scopeRelation,
        action: outcome.decision.requestedAction,
        result: 'routed'
      });
      workspaceMetrics.observe('intent_route_latency_ms', Date.now() - startedAt, { result: 'routed' });
      followUp.workItemId = applied.workItem.id;
      followUp.handlingPlan = applied.handlingPlan;
      if (!applied.committedEvent) this.events.create({
        sessionId: session.id,
        type: applied.createdWorkItem ? 'work_item_created' : 'work_item_activated',
        content: applied.createdWorkItem
          ? `已创建任务上下文：${applied.workItem.title}`
          : `继续任务上下文：${applied.workItem.title}`,
        metadata: createMetadata('system_notice', {
          routingId,
          workItemId: applied.workItem.id,
          previousWorkItemId: applied.previousWorkItemId,
          inheritedDecisionIds: applied.workItem.inheritedDecisionIds,
          inheritedArtifactIds: applied.workItem.inheritedArtifactIds
        })
      });
      const action = outcome.decision.requestedAction;
      if (action === 'pause' || action === 'cancel') {
        await this.applyPersistedRoutingAction(session, routingId, followUp, action);
        return;
      }
      /*
      // legacy pause branch handled by applyPersistedRoutingAction
      if (Boolean(false) && String(action) === 'pause') {
        void this.completeFollowUpRouting(session!, followUp!.id);
        await this.pause(session.id, '用户通过意图路由请求暂停会话');
        return;
      }
      // legacy cancel branch handled by applyPersistedRoutingAction
      if (Boolean(false) && String(action) === 'cancel') {
        void this.completeFollowUpRouting(session!, followUp!.id);
        this.control(session.id, 'CANCELLED', '用户通过意图路由请求取消会话');
        return;
      }
      */
      const coordinator = this.pickSessionAgent(session, ['coordinator']);
      this.events.create({
        sessionId: session.id,
        type: 'agent_message',
        fromAgentId: coordinator.id,
        toAgentIds: followUp.mentionedAgentIds,
        content: applied.handlingPlan.requiresUserConfirmation
          ? '需要补充信息后才能继续处理当前消息。'
          : '意图识别已完成，正在处理当前消息。',
        metadata: createMetadata('chat_message', {
          messageKind: 'decision',
          routingId,
          workItemId: applied.workItem.id,
          handlingPlan: applied.handlingPlan
        })
      });
      if (!this.hasActiveSessionWork(session)) this.scheduleFollowUpPlanning(session.id);
    } catch (error) {
      workspaceMetrics.increment('intent_route_total', 1, {
        relation: 'unknown',
        action: 'unknown',
        result: 'processing_error'
      });
      workspaceMetrics.observe('intent_route_latency_ms', Date.now() - startedAt, { result: 'processing_error' });
      this.logger.warn(`Intent routing processing failed for session ${session.id}: ${String(error)}`);
      if (String(error).includes('ROUTING_LEASE_LOST')) return;
      if (this.contextManagement) {
        const current = this.contextManagement.listRoutingRecords(session.id).find((item) => item.id === routingId);
        if (current && ['CLASSIFYING', 'VALIDATING', 'APPLYING'].includes(current.status)) {
          await this.contextManagement.updateRoutingRecord(session.id, routingId, {
            status: 'PENDING_RETRY',
            reasonCodes: [...new Set([...current.reasonCodes, 'ROUTING_PROCESSING_FAILED'])]
          });
          this.scheduleIntentRoutingRetry(sessionId, routingId, snapshotId, followUpId, legacyRelation);
        }
      }
    } finally {
      if (this.intentRoutingControllers.get(sessionId) === routingController) this.intentRoutingControllers.delete(sessionId);
    }
  }

  stopState(sessionId: string) {
    this.get(sessionId);
    return this.runtime?.getStopSummary(sessionId) ?? {
      sessionId,
      version: 0,
      status: 'unknown' as const,
      requestedCount: 0,
      confirmedCount: 0,
      targets: [],
      blockers: [{ reason: 'state_query_failed' as const, message: 'Runtime 停止状态服务不可用。' }],
      canResume: false
    };
  }

  private emitIntentClarification(
    session: SessionDetail,
    followUp: SessionFollowUpMessage,
    reasonCodes: string[]
  ) {
    const confirmationId = crypto.randomUUID();
    this.events.create({
      sessionId: session.id,
      type: 'intent_clarification_required',
      priority: 'high',
      content: '无法安全确定这条消息与现有任务的关系，请选择处理方式。',
      metadata: createMetadata('confirmation_card', {
        confirmationId,
        reason: 'intent_relation_clarification',
        routingId: followUp.routingId,
        followUpMessageId: followUp.id,
        reasonCodes,
        title: '选择任务关系',
        description: followUp.content,
        options: [
          { key: 'continue_current', label: '继续当前任务', style: 'primary' },
          { key: 'related_new', label: '作为相关新任务', style: 'default' },
          { key: 'independent_new', label: '作为独立新任务', style: 'default' }
        ]
      })
    });
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

  async confirmBrief(sessionId: string, briefId: string, confirmationId?: string) {
    const session = this.get(sessionId);
    if (session.currentTaskBriefId !== briefId) {
      throw new BadRequestException(`Brief is not current: ${briefId}`);
    }
    const resolvedConfirmationId = confirmationId ?? this.findPendingConfirmationId(
      sessionId,
      'confirm_task_brief',
      (payload) => payload.relatedBriefId === briefId
    );
    if (!resolvedConfirmationId) {
      throw new BadRequestException(`Task Brief confirmation is missing: ${briefId}`);
    }
    // A replayed approval (double click, retried request) is the same
    // confirmation: return the state it produced instead of failing (AC3).
    if (this.isConfirmationApproved(sessionId, resolvedConfirmationId)) {
      const current = this.orchestrator.getBrief(sessionId, briefId);
      if (current) return current;
    }
    const request = this.assertPendingConfirmation(sessionId, resolvedConfirmationId, 'confirm_task_brief');
    const binding = this.documentBindingFromCard(session, resolvedConfirmationId, request.metadata.payload);
    if (binding) this.assertConfirmationCurrent(session, binding);
    const brief = this.orchestrator.confirmBrief(session, briefId);
    if (binding) {
      const confirmed = await this.requirementDocuments.confirm(binding.documentId, { confirmationId: resolvedConfirmationId });
      if (confirmed.status === 'rejected') {
        throw new ConflictException({ code: 'stale_confirmation', reason: confirmed.code, received: binding });
      }
    }
    session.currentTaskBriefId = brief.id;
    if (this.contextManagement) {
      const activeWorkItem = await this.contextManagement.ensureInitialWorkItem(
        session,
        `brief-confirmation:${brief.id}`,
        brief.goal
      );
      const confirmationEvent = this.events.createDraft({
        sessionId,
        type: 'user_confirmation_resolved',
        sessionUserId: session.ownerId,
        content: '任务契约已确认并写入决策账本。',
        metadata: createMetadata('system_notice', {
          confirmationId: resolvedConfirmationId,
          relatedBriefId: brief.id,
          workItemId: activeWorkItem.id,
          status: 'approved',
          reason: 'confirm_task_brief'
        })
      });
      await this.contextManagement.recordConfirmedDecisions({
        session,
        workItemId: activeWorkItem.id,
        sourceEvent: confirmationEvent,
        decisions: [
          { kind: 'requirement', content: brief.goal },
          ...(brief.scope.length ? [{ kind: 'constraint' as const, content: `In scope: ${brief.scope.join('; ')}` }] : []),
          ...(brief.outOfScope.length ? [{ kind: 'constraint' as const, content: `Out of scope: ${brief.outOfScope.join('; ')}` }] : []),
          ...brief.constraints.map((content) => ({ kind: 'constraint' as const, content })),
          { kind: 'approval', content: `Task Brief ${brief.id} version ${brief.version} confirmed by user.` }
        ]
      });
      this.events.acceptCommitted(confirmationEvent);
    } else {
      this.events.create({
        sessionId,
        type: 'user_confirmation_resolved',
        sessionUserId: session.ownerId,
        content: '任务契约已确认。',
        metadata: createMetadata('system_notice', {
          confirmationId: resolvedConfirmationId,
          relatedBriefId: brief.id,
          status: 'approved',
          reason: 'confirm_task_brief'
        })
      });
    }
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
    const workflowConfirmationId = crypto.randomUUID();
    this.events.create({
      sessionId,
      type: 'user_confirmation_requested',
      priority: 'high',
      content: '请选择工作流后开始执行。',
      metadata: createMetadata('confirmation_card', {
        confirmationId: workflowConfirmationId,
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
    return { accepted: true, sessionId: session.id, status: session.status, confirmationId: workflowConfirmationId };
  }

  async selectWorkflow(
    sessionId: string,
    input: { workflowId: string; workflowVersion?: number; confirmationId: string }
  ) {
    const session = this.get(sessionId);
    const previousRun = this.workflowRuntime?.findBySession(sessionId);
    if (previousRun?.startIdempotencyKey === `${sessionId}:${input.confirmationId}`) {
      if (previousRun.workflowId !== input.workflowId || (input.workflowVersion !== undefined && previousRun.workflowVersion !== input.workflowVersion)) {
        throw new BadRequestException('Confirmation already started a different workflow version.');
      }
      return { session, workflow: this.workflows!.get(previousRun.workflowId), workflowRun: previousRun, createdTasks: this.tasks.list(sessionId).filter(task => task.workflowRunId === previousRun.id) };
    }
    /**
     * Durable replay: the start request outlives this process, so a retried
     * selection after a restart must resolve to the recorded run instead of
     * being refused for no longer being in WAIT_WORKFLOW_SELECT. Checked here,
     * before the status guard, for the same reason the in-memory replay is.
     */
    const recordedStart = this.workflowStarts
      .list(sessionId)
      .find((item) => item.binding.confirmationId === input.confirmationId && item.workflowRunId);
    if (recordedStart?.workflowRunId && this.workflows && this.workflowRuntime) {
      if (
        recordedStart.binding.workflowId !== input.workflowId ||
        (input.workflowVersion !== undefined && recordedStart.binding.workflowVersion !== input.workflowVersion)
      ) {
        throw new BadRequestException('Confirmation already started a different workflow version.');
      }
      const existing = this.workflowRuntime.get(recordedStart.workflowRunId);
      return {
        session,
        workflow: this.workflows.get(recordedStart.binding.workflowId),
        workflowRun: existing,
        createdTasks: this.tasks.list(sessionId).filter((task) => task.workflowRunId === existing.id)
      };
    }
    if (session.status !== 'WAIT_WORKFLOW_SELECT') {
      throw new BadRequestException(`Workflow selection requires WAIT_WORKFLOW_SELECT: ${session.status}`);
    }
    if (!this.workflows || !this.workflowRuntime) throw new BadRequestException('Workflow runtime is unavailable.');
    this.assertPendingConfirmation(sessionId, input.confirmationId, 'select_workflow');
    const workflow = this.workflows.get(input.workflowId);
    if (workflow.status !== 'published') throw new BadRequestException('Only published workflows can be executed.');
    const briefId = session.currentTaskBriefId;
    const brief = briefId ? this.orchestrator.getBrief(session.id, briefId) : undefined;
    if (!brief || !brief.confirmedByUser) throw new BadRequestException('Current confirmed brief is missing.');
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    const version = this.workflows.getVersion(workflow.id, input.workflowVersion);
    const mapping = evaluateWorkflowMemberMapping({
      involvedAgentIds: version.involvedAgentIds,
      participatingAgentIds: session.participatingAgentIds,
      findAgent: (id) => this.agents.findByIdOrKey(id)
    });
    if (mapping.status === 'mapping_required') {
      const mappingConfirmationId = crypto.randomUUID();
      this.events.create({
        sessionId: session.id,
        type: 'user_confirmation_requested',
        fromAgentId: coordinator.id,
        content: mapping.addable.length
          ? `工作流 ${workflow.name} 需要邀请以下 Agent 参与：${mapping.gaps.map((g) => g.agentName).join('、')}。`
          : `工作流 ${workflow.name} 涉及的部分 Agent 当前不可用：${mapping.gaps.map((g) => `${g.agentName}（${g.reason}）`).join('、')}。`,
        metadata: createMetadata('confirmation_card', {
          confirmationId: mappingConfirmationId,
          reason: 'confirm_workflow_member_mapping',
          title: mapping.addable.length ? `确认邀请 ${mapping.addable.length} 个 Agent` : '工作流成员不可用',
          description: mapping.addable.length
            ? `这些 Agent 尚未参与本会话，需要您明确同意后才能启动工作流。`
            : mapping.gaps.map((g) => `${g.agentName}：${g.reason === 'disabled' ? '已禁用' : '未找到'}`).join('；'),
          workflowId: workflow.id,
          workflowVersion: version.version,
          definitionHash: version.definitionHash,
          addableAgentIds: mapping.addable,
          gaps: mapping.gaps,
          options: mapping.addable.length
            ? [{ key: 'approve', label: '邀请并启动', style: 'primary' }, { key: 'decline', label: '取消', style: 'default' }]
            : [{ key: 'acknowledge', label: '知道了', style: 'default' }]
        })
      });
      throw new ConflictException({ code: 'capability_mapping_required', gaps: mapping.gaps, addable: mapping.addable });
    }
    if (this.isEmptyWorkspace(session) && session.workspaceMode !== 'bootstrap') {
      const confirmationId = crypto.randomUUID();
      session.workspaceMode = 'empty_pending_decision';
      session.pendingBootstrapWorkflow = {
        workflowId: workflow.id,
        workflowVersion: version.version,
        definitionHash: version.definitionHash,
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
    /**
     * Submit, then dispatch. The durable request carries every version the
     * decision depended on, so the pre-phase-4 `sessionId:confirmationId` key
     * can no longer let a revised document replay an approval the user gave for
     * an older one.
     */
    const confirmedDocument = session.activeWorkItemId
      ? this.requirementDocuments.latest(session.id, session.activeWorkItemId)
      : undefined;
    const activeWorkItem = this.contextManagement?.activeWorkItem?.(session);
    const binding: WorkflowStartBinding = {
      sessionId: session.id,
      workItemId: session.activeWorkItemId ?? brief.workItemId ?? brief.id,
      workItemRevision: confirmedDocument?.workItemRevision ?? activeWorkItem?.revision ?? 1,
      confirmationId: input.confirmationId,
      // Without a published document the confirmed brief version is the binding:
      // the start still refuses to replay across a revision, it just names the
      // brief instead of a document.
      documentId: confirmedDocument?.id ?? brief.id,
      documentRevision: confirmedDocument?.documentRevision ?? brief.version,
      contentHash: confirmedDocument?.contentHash ?? `brief:${brief.id}:${brief.version}`,
      workflowId: workflow.id,
      workflowVersion: version.version,
      definitionHash: version.definitionHash
    };
    const generation = this.lifecycle.generation(session.id);
    const submitted = await this.workflowStarts.submit({
      binding,
      ...(generation !== undefined ? { generation } : {})
    });
    if (submitted.status === 'rejected') throw new ConflictException(submitted.code);
    const request = submitted.request;
    if (request.workflowRunId) {
      // Already dispatched and recorded: hand back that run rather than starting
      // the requirement a second time.
      const existing = this.workflowRuntime.get(request.workflowRunId);
      session.workflowRunId = existing.id;
      this.setStatus(session, 'EXECUTING');
      return {
        session,
        workflow,
        workflowRun: existing,
        createdTasks: this.tasks.list(session.id).filter((task) => task.workflowRunId === existing.id)
      };
    }
    const claimed = await this.workflowStarts.claim(request.id, {
      workerId: `sessions:${process.pid}`,
      // A request left dispatched with no run is a crashed worker, not a live one.
      reclaimDispatched: request.status === 'dispatched'
    });
    if (claimed.status === 'already_claimed') throw new ConflictException('WORKFLOW_START_ALREADY_DISPATCHED');
    const run = await this.workflowRuntime.start({
      session,
      brief,
      coordinatorId: coordinator.id,
      workflowId: workflow.id,
      workflowVersion: version.version,
      // The exact version the mapping card was evaluated against. A republish
      // between approval and start must fail loudly rather than run a graph the
      // user never saw.
      definitionHash: version.definitionHash,
      confirmationId: input.confirmationId,
      sessionGeneration: generation
    });
    await this.workflowStarts.complete(request.id, { workflowRunId: run.id });
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
      ...(pending.definitionHash ? { definitionHash: pending.definitionHash } : {}),
      confirmationId: pending.selectionConfirmationId,
      sessionGeneration: this.lifecycle.generation(session.id)
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

  async applyQueuedExecutionOutcome(
    sessionId: string,
    outcome: ExecutionOutcome,
    expectedGeneration?: number
  ) {
    if (!this.lifecycle.matchesActiveGeneration(sessionId, expectedGeneration)) return;
    const session = this.sessions.get(sessionId);
    if (session?.activeFollowUpMessageId) {
      await this.applyFollowUpOutcome(sessionId, session.activeFollowUpMessageId, outcome, expectedGeneration);
      return;
    }
    if (await this.workflowRuntime?.acceptExecutionOutcome(sessionId, outcome)) return;
    this.applyOutcome(sessionId, outcome, expectedGeneration);
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
    // INTERRUPTED 不算"有活儿在跑"：中断意味着服务端已经丢了执行所有权，会话在等用户。
    // 把它算作在跑会让新消息被判 deferred，永远进不了调度——这是中断会话没有出口的一半原因。
    // 另一半在 processNextFollowUp 的早退，两处必须同批改。
    return Boolean(
      session.status === 'PAUSED' ||
      session.activeFollowUpMessageId ||
      this.followUpPlanningRuns.has(session.id) ||
      this.briefGenerationRuns.has(session.id) ||
      this.execution.isRunning(session.id) ||
      ACTIVE_INVOCATION_SESSION_STATUSES.has(session.status) ||
      this.hasLiveWorkflowRun(session)
    );
  }

  /**
   * A non-terminal workflow run still owns the main chain even while the Session
   * is parked on the user (e.g. WAIT_USER_DECISION for an Agent substitution).
   * Without this, the execution slot is already free and a plain chat message
   * would start a second brief + discussion + execution alongside the workflow.
   */
  private hasLiveWorkflowRun(session: SessionDetail) {
    if (!session.workflowRunId || !this.workflowRuntime) return false;
    try {
      return !['completed', 'failed', 'cancelled'].includes(
        this.workflowRuntime.get(session.workflowRunId).status
      );
    } catch {
      return false;
    }
  }

  private scheduleFollowUpPlanning(sessionId: string) {
    const lifecycleGeneration = this.lifecycle.generation(sessionId);
    if (this.followUpPlanningRuns.has(sessionId) || this.shuttingDown ||
      !this.lifecycle.isActive(sessionId, lifecycleGeneration)) return;
    const run = this.processNextFollowUp(sessionId)
      .catch((error) => {
        const session = this.sessions.get(sessionId);
        if (!session || this.deletingSessionIds.has(sessionId) ||
          !this.lifecycle.isActive(sessionId, lifecycleGeneration)) return;
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
    const lifecycleGeneration = this.lifecycle.generation(sessionId);
    if (!session || !this.lifecycle.isActive(sessionId, lifecycleGeneration) ||
      session.status === 'PAUSED' || session.activeFollowUpMessageId) return;
    if (
      this.briefGenerationRuns.has(sessionId) ||
      this.execution.isRunning(sessionId)
    ) {
      return;
    }
    const followUp = session.pendingFollowUpMessages?.find((item) => item.status === 'queued');
    if (!followUp) return;
    if (followUp.workItemId && followUp.workItemId !== session.activeWorkItemId && this.contextManagement) {
      const previousWorkItemId = session.activeWorkItemId;
      const activated = await this.contextManagement.activateWorkItem(session, followUp.workItemId);
      this.events.create({
        sessionId,
        type: 'work_item_activated',
        content: `Activated task context: ${activated.title}`,
        metadata: createMetadata('system_notice', {
          workItemId: activated.id,
          previousWorkItemId,
          reason: 'queued_follow_up_started'
        })
      });
    }
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
    await this.contextManagement?.saveFollowUp(sessionId, followUp);
    session.activeFollowUpMessageId = followUp.id;

    if (followUp.handlingPlan.failedExecutionAction === 'resume') {
      this.recordAgentRequirementContext(
        session,
        followUp.content,
        followUp.sourceEventId,
        this.relevantAgentIds(session, followUp.content, followUp.handlingPlan.affectedAgentIds)
      );
      await this.completeFollowUpRouting(session, followUp.id);
      this.retryFailedSession(session, followUp.sourceEventId);
      return;
    }

    const discussionRequired =
      followUp.mentionedAgentIds.length > 1 ||
      followUp.handlingPlan.requirementRelation === 'new_requirement' ||
      followUp.handlingPlan.failedExecutionAction === 'replan';
    this.setStatus(session, discussionRequired ? 'AGENT_DISCUSSING' : 'EXECUTING');
    this.events.create({
      sessionId,
      type: 'session_status_changed',
      content: discussionRequired
        ? followUp.mentionedAgentIds.length > 1
          ? '被 @ 的多个 Agent 开始讨论，随后由接收者拆分任务。'
          : '新需求或重规划已进入 Agent 讨论。'
        : '正在应用同一任务的补充指令并准备继续执行。',
      metadata: createMetadata('system_notice', {
        status: discussionRequired ? 'AGENT_DISCUSSING' : 'EXECUTING',
        reason: discussionRequired
          ? followUp.mentionedAgentIds.length > 1
            ? 'follow_up_multi_agent_discussion_started'
            : 'follow_up_discussion_started'
          : 'follow_up_continuation_planning_started',
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
        discussionRequired,
        requirementRelation: followUp.handlingPlan.requirementRelation
      }
    );
    if (!this.lifecycle.isActive(sessionId, lifecycleGeneration)) return;
    session.currentTaskBriefId = brief.id;
    followUp.status = 'executing';
    await this.contextManagement?.saveFollowUp(sessionId, followUp);
    this.setStatus(session, 'EXECUTING');
    this.execution.start(session, brief, tasks, (outcome) => {
      void this.applyFollowUpOutcome(sessionId, followUp.id, outcome, lifecycleGeneration).catch((error) => {
        this.logger.error(`Failed to persist follow-up completion for session ${sessionId}: ${String(error)}`);
      });
    }, lifecycleGeneration);
  }

  private normalizeFollowUpHandlingPlan(
    session: SessionDetail,
    plan: UserMessageHandlingPlan
  ): UserMessageHandlingPlan {
    const requirementRelation = plan.requirementRelation ?? 'continuation';
    // 中断会话强制走 replan：带内容的消息按定义有新内容要吸收，而 resume 那条路
    // （retryFailedSession -> generateBriefInBackground）不接收 followUp 内容，
    // 会静默丢掉用户新说的需求。replan 则落到 AGENT_DISCUSSING，由
    // prepareFollowUpExecution 带 requirementRelation 合并旧契约。
    // 裸「继续」不经此处：它在 sendMessage 就被精确命令词拦走。
    const interrupted = session.status === 'INTERRUPTED';
    const resumableFailure = session.status === 'FAILED' || interrupted || this.hasFailedWorkflowRun(session);
    const failedExecutionAction = resumableFailure && requirementRelation === 'continuation'
      ? interrupted || plan.failedExecutionAction === 'replan' ? 'replan' : 'resume'
      : 'none';
    return { ...plan, requirementRelation, failedExecutionAction };
  }

  private hasFailedWorkflowRun(session: SessionDetail) {
    if (!session.workflowRunId || !this.workflowRuntime) return false;
    try {
      return this.workflowRuntime.get(session.workflowRunId).status === 'failed';
    } catch {
      return false;
    }
  }

  private async completeFollowUpRouting(
    session: SessionDetail,
    followUpMessageId: string,
    status: 'completed' | 'failed' | 'cancelled' = 'completed'
  ) {
    const followUp = (session.pendingFollowUpMessages ?? []).find((item) => item.id === followUpMessageId);
    if (followUp) followUp.status = status;
    if (this.contextManagement) {
      await this.contextManagement.updateFollowUpStatus(session.id, followUpMessageId, status);
    }
    session.pendingFollowUpMessages = (session.pendingFollowUpMessages ?? []).filter(
      (item) => item.id !== followUpMessageId
    );
    if (session.activeFollowUpMessageId === followUpMessageId) {
      session.activeFollowUpMessageId = undefined;
    }
    this.touchSession(session);
  }

  private async applyPersistedRoutingAction(
    session: SessionDetail,
    routingId: string,
    followUp: SessionFollowUpMessage,
    action: 'pause' | 'cancel'
  ) {
    await this.contextManagement?.updateRoutingActionStatus(session.id, routingId, 'applying');
    const alreadyApplied = action === 'pause'
      ? session.status === 'PAUSED'
      : session.status === 'CANCELLED';
    if (!alreadyApplied && action === 'pause') {
      await this.pause(session.id, 'pause requested by intent routing');
    } else if (!alreadyApplied) {
      this.control(session.id, 'CANCELLED', 'cancel requested by intent routing');
    }
    await this.contextManagement?.updateRoutingActionStatus(session.id, routingId, 'applied');
    await this.completeFollowUpRouting(session, followUp.id, action === 'cancel' ? 'cancelled' : 'completed');
  }

  private async applyFollowUpOutcome(
    sessionId: string,
    followUpMessageId: string,
    outcome: ExecutionOutcome,
    expectedGeneration?: number
  ) {
    const session = this.sessions.get(sessionId);
    if (!session || !this.lifecycle.matchesActiveGeneration(sessionId, expectedGeneration)) return;
    await this.completeFollowUpRouting(
      session,
      followUpMessageId,
      outcome.kind === 'delivered' ? 'completed' : outcome.kind === 'cancelled' ? 'cancelled' : 'failed'
    );
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
    this.applyOutcome(sessionId, outcome, expectedGeneration);
  }

  /** Applied when the background execution pipeline finishes. */
  applyOutcome(sessionId: string, outcome: ExecutionOutcome, expectedGeneration?: number) {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      !this.lifecycle.isActive(sessionId, expectedGeneration) ||
      session.status === 'CANCELLED' ||
      session.status === 'COMPLETED' ||
      session.status === 'PAUSED'
    ) {
      return;
    }
    // 中断意味着服务端丢了这次调用的所有权：迟到的 failed / rework 不该盖掉中断标记
    // 和恢复卡（用户还要靠它决定怎么办）。但 delivered 是产物真的落地了，继续挂在
    // INTERRUPTED 会让一个已完成的任务永远卡在恢复卡后面。
    if (session.status === 'INTERRUPTED' && outcome.kind !== 'delivered') return;
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
    if (outcome.kind === 'work_item_budget_exhausted') {
      this.setStatus(session, 'WAIT_USER_DECISION');
      if (session.workflowRunId && this.workflowRuntime) {
        this.workflowRuntime.checkpointInterruptedExecution?.(session.workflowRunId, {
          code: 'WORK_ITEM_BUDGET_EXHAUSTED',
          message: outcome.reason
        });
      }
      this.events.create({
        sessionId,
        workItemId: outcome.workItemId,
        type: 'session_status_changed',
        priority: 'high',
        content: '当前需求的累计预算已用尽，等待用户拆分或缩小需求范围。',
        metadata: createMetadata('system_notice', {
          status: 'WAIT_USER_DECISION',
          outcome: outcome.kind,
          reason: 'work_item_budget_exhausted',
          taskId: outcome.taskId,
          workItemId: outcome.workItemId,
          runtimeError: outcome.error
        })
      });
      const confirmationId = `work-item-budget-exhausted:${outcome.workItemId ?? outcome.taskId ?? session.activeWorkItemId ?? 'session'}`;
      this.events.createOnce(`confirmation-request:${session.id}:${confirmationId}`, {
        sessionId,
        workItemId: outcome.workItemId,
        type: 'user_confirmation_requested',
        priority: 'high',
        content: '当前需求的预算已用尽，请提交拆分或缩小范围后的新需求。',
        metadata: createMetadata('confirmation_card', {
          confirmationId,
          reason: 'work_item_budget_exhausted',
          title: '需要拆分当前需求',
          description: `${outcome.reason}\n系统不会重试已耗尽预算的任务。请在下方输入拆分或缩小范围后的新需求，系统会创建关联的新任务上下文。`,
          relatedTaskId: outcome.taskId,
          options: [
            { key: 'submit_narrowed_requirement', label: '提交拆分需求', style: 'primary' },
            { key: 'cancel', label: '取消会话', style: 'default' }
          ]
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
    if (outcome.kind === 'delivered' && hasQueuedFollowUp) {
      // Hand ownership directly to the queued FollowUp without exposing a
      // terminal Session state between two executions.
      this.scheduleFollowUpPlanning(sessionId);
      return;
    }
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
      const substitution = outcome.workflowAgentSubstitution;
      if (!substitution && session.workflowRunId && this.workflowRuntime) {
        this.workflowRuntime.checkpointInterruptedExecution?.(session.workflowRunId, {
          code: 'WORKFLOW_USER_RECOVERY_REQUIRED',
          message: reason || 'Workflow execution requires an explicit user recovery action.'
        });
      }
      const checkpoint = substitution
        ? undefined
        : this.createRecoveryCheckpoint(session, 'coordinator_routing_needs_user_decision', {
            phase: 'coordinator_routing'
          });
      // 同一个工作流节点只保留一张改派卡：confirmationId 每次都新生成，会让
      // pendingConfirmationContext 因为存在多张未解决确认而返回 undefined，
      // 用户既点不动卡，也没法用「继续」命令推进。
      const substitutionConfirmationId = substitution
        ? `workflow-agent-substitution:${substitution.workflowRunId}:${substitution.taskId}`
        : undefined;
      if (substitution && substitutionConfirmationId && session.workflowRunId && this.workflowRuntime) {
        void this.workflowRuntime.requestAgentSubstitution?.({
          ...substitution,
          reason,
          confirmationId: substitutionConfirmationId
        }).catch((error: unknown) => this.failSession(session, error, 'workflow_agent_substitution'));
      }
      const confirmationId = substitutionConfirmationId ?? checkpoint?.confirmationId ?? crypto.randomUUID();
      this.events.createOnce(
        substitution
          ? `workflow-agent-substitution-confirmation:${substitution.workflowRunId}:${substitution.taskId}`
          : `confirmation-request:${confirmationId}`,
        {
        sessionId,
        type: 'user_confirmation_requested' as const,
        priority: 'high' as const,
        content: substitution
          ? '当前工作流 Agent 无法继续，请明确选择是否改派。'
          : 'Coordinator 自动处理未能继续推进，请确认下一步。',
        metadata: createMetadata('confirmation_card', {
          confirmationId,
          reason: substitution ? 'workflow_agent_substitution' : 'coordinator_routing_needs_user_decision',
          title: substitution ? '选择替代工作流 Agent' : '需要用户确认下一步',
          description: substitution
            ? `${reason}\n系统不会自动跨角色改派。请选择一个当前会话中可用于工作流的 Agent，或取消执行。`
            : reason || '任务在自动恢复后仍无法继续，需要用户确认是否继续执行或取消。',
          actions: outcome.actions,
          relatedTaskId: substitution?.taskId,
          workflowRunId: substitution?.workflowRunId,
          workflowNodeId: substitution?.workflowNodeId,
          candidateAgentIds: substitution?.candidates.map((agent) => agent.id),
          options: substitution
            ? [
                ...substitution.candidates.map((agent, index) => ({
                  key: `agent:${agent.id}`,
                  label: `改派给 ${agent.name}`,
                  style: index === 0 ? 'primary' as const : 'default' as const
                })),
                { key: 'skip_agent', label: '跳过当前 Agent', style: 'default' as const },
                { key: 'cancel', label: messages.reworkCancel, style: 'danger' as const }
              ]
            : [
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
      const workflowRun = this.workflowRuntime.get(session.workflowRunId);
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
          workflowRunId: workflowRun.id
        })
      });
      // 只返工最后一个 Agent 节点，不重放整条工作流定义：重新 start 会新建 run
      // 并从第一个节点跑起，把已通过的上游节点连同群聊全部重复一遍。
      void this.workflowRuntime
        .reworkLastAgentNode(workflowRun.id, reason || '复盘要求返工，请修正本阶段输出。', {
          session,
          brief,
          coordinatorId: coordinator.id
        })
        .then((reworked) => {
          if (!reworked) {
            this.failSession(
              session,
              new Error('当前工作流没有可返工的 Agent 节点，无法自动返工。'),
              'workflow_rework'
            );
          }
        })
        .catch((error) => this.failSession(session, error, 'workflow_rework'));
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
    const lifecycleGeneration = this.lifecycle.generation(session.id);
    this.execution.start(session, brief, this.tasks.unfinished(session.id),
      (outcome) => this.applyOutcome(session.id, outcome, lifecycleGeneration),
      lifecycleGeneration);
  }

  listBriefs(sessionId: string) {
    return this.orchestrator.listBriefs(sessionId);
  }

  async resolveWorkflowAgentSubstitution(
    sessionId: string,
    input: { confirmationId: string; taskId: string; agentId: string }
  ) {
    const session = this.get(sessionId);
    if (session.status !== 'WAIT_USER_DECISION') {
      throw new BadRequestException(`Workflow Agent substitution is not active: ${session.status}`);
    }
    if (!this.workflowRuntime || !session.workflowRunId) {
      throw new ServiceUnavailableException('Workflow Runtime is unavailable.');
    }
    const request = this.assertPendingConfirmation(sessionId, input.confirmationId, 'workflow_agent_substitution');
    const payload = request.metadata.payload as {
      relatedTaskId?: string;
      workflowRunId?: string;
      candidateAgentIds?: string[];
    } | undefined;
    if (payload?.relatedTaskId !== input.taskId || payload.workflowRunId !== session.workflowRunId) {
      throw new BadRequestException('Workflow Agent substitution target does not match the pending confirmation.');
    }
    if (!payload.candidateAgentIds?.includes(input.agentId)) {
      throw new BadRequestException(`Agent is not an approved substitution candidate: ${input.agentId}`);
    }
    const agent = this.agents.getForSurface(input.agentId, 'workflow');
    if (!session.participatingAgentIds.includes(agent.id)) {
      throw new BadRequestException(`Agent is not part of this session: ${agent.id}`);
    }
    await this.workflowRuntime.substituteCurrentAgent({
      runId: session.workflowRunId,
      taskId: input.taskId,
      agentId: agent.id,
      confirmationId: input.confirmationId
    });
    this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      priority: 'high',
      content: `用户选择将工作流任务改派给 ${agent.name}。`,
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: 'approved',
        selectedOptionKey: `agent:${agent.id}`,
        relatedTaskId: input.taskId,
        workflowRunId: session.workflowRunId,
        agentId: agent.id
      })
    });
    this.setStatus(session, 'EXECUTING');
    this.touchSession(session);
    return { session };
  }

  /**
   * Skips the workflow Agent that declined the current node and advances to the
   * next node. This is the card-driven counterpart of the typed skip command:
   * the substitution card must stay resolvable when every candidate Agent has
   * already been attempted, otherwise cancelling the run is the only exit.
   */
  async resolveWorkflowAgentSkip(
    sessionId: string,
    input: { confirmationId: string; taskId: string; reason?: string }
  ) {
    const session = this.get(sessionId);
    if (session.status !== 'WAIT_USER_DECISION') {
      throw new BadRequestException(`Workflow Agent skip is not active: ${session.status}`);
    }
    if (!this.workflowRuntime || !session.workflowRunId) {
      throw new ServiceUnavailableException('Workflow Runtime is unavailable.');
    }
    const request = this.assertPendingConfirmation(sessionId, input.confirmationId, 'workflow_agent_substitution');
    const payload = request.metadata.payload as {
      relatedTaskId?: string;
      workflowRunId?: string;
    } | undefined;
    if (payload?.relatedTaskId !== input.taskId || payload.workflowRunId !== session.workflowRunId) {
      throw new BadRequestException('Workflow Agent skip target does not match the pending confirmation.');
    }
    const reason = input.reason?.trim() || '用户跳过当前工作流 Agent，并从下一节点继续执行。';
    await this.workflowRuntime.skipCurrentAgent({
      runId: session.workflowRunId,
      taskId: input.taskId,
      reason,
      confirmationId: input.confirmationId
    });
    this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      priority: 'high',
      content: '用户已跳过当前工作流 Agent，工作流从下一节点继续执行。',
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: 'approved',
        selectedOptionKey: 'skip_agent',
        relatedTaskId: input.taskId,
        workflowRunId: session.workflowRunId
      })
    });
    this.setStatus(session, 'EXECUTING');
    this.touchSession(session);
    return { session };
  }

  /**
   * Sends a parked workflow node back to an upstream node the user picked, or
   * retries the parked node itself. Both are resolutions of the one
   * `workflow_upstream_rerun` card the Workflow Runtime emitted.
   */
  async resolveWorkflowUpstreamRerun(
    sessionId: string,
    input: { confirmationId: string; nodeId?: string; decision?: 'rerun_upstream' | 'retry_current'; instruction?: string }
  ) {
    const session = this.get(sessionId);
    if (!this.workflowRuntime || !session.workflowRunId) {
      throw new ServiceUnavailableException('Workflow Runtime is unavailable.');
    }
    const pending = this.workflowRuntime.pendingUpstreamRerun(session.workflowRunId);
    if (!pending) throw new BadRequestException('当前没有等待选择上游节点的工作流节点。');
    this.assertPendingConfirmation(sessionId, input.confirmationId, 'workflow_upstream_rerun');
    const decision = input.decision ?? (input.nodeId ? 'rerun_upstream' : 'retry_current');

    if (decision === 'retry_current') {
      await this.workflowRuntime.retryParkedNode({
        runId: session.workflowRunId,
        confirmationId: input.confirmationId
      });
      this.events.create({
        sessionId,
        type: 'user_confirmation_resolved',
        priority: 'high',
        content: '用户选择不退回上游节点，直接重试当前工作流节点。',
        metadata: createMetadata('system_notice', {
          confirmationId: input.confirmationId,
          status: 'approved',
          selectedOptionKey: 'retry_current',
          workflowRunId: session.workflowRunId,
          workflowNodeId: pending.nodeId
        })
      });
      this.setStatus(session, 'EXECUTING');
      this.touchSession(session);
      return { session };
    }

    const target = pending.candidates.find((candidate) => candidate.nodeId === input.nodeId);
    if (!target) {
      throw new BadRequestException(`上游节点不在可退回的候选列表中：${input.nodeId ?? '(未指定)'}`);
    }
    await this.workflowRuntime.rerunUpstreamNode({
      runId: session.workflowRunId,
      confirmationId: input.confirmationId,
      nodeId: target.nodeId,
      ...(input.instruction ? { instruction: input.instruction } : {})
    });
    this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      priority: 'high',
      content: `用户选择退回上游节点「${target.nodeName}」重新执行。`,
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: 'approved',
        selectedOptionKey: `node:${target.nodeId}`,
        workflowRunId: session.workflowRunId,
        workflowNodeId: target.nodeId,
        agentId: target.agentId,
        parkedNodeId: pending.nodeId
      })
    });
    this.setStatus(session, 'EXECUTING');
    this.touchSession(session);
    return { session };
  }

  async pause(sessionId: string, reason = '用户已停止会话', confirmationId?: string) {
    const session = this.get(sessionId);
    const admission = await this.lifecycle.closeForStop(sessionId, session.dataEpoch);
    if (admission.event) this.events.acceptCommitted(admission.event);
    const alreadyPaused = session.status === 'PAUSED';
    if (!alreadyPaused) {
      const pendingRouting = this.contextManagement?.listRoutingRecords(sessionId)
        .some(item => ['RECEIVED', 'SNAPSHOT_READY', 'CLASSIFYING', 'VALIDATING', 'APPLYING', 'PENDING_RETRY'].includes(item.status));
      if (!pendingRouting) this.assertControlTransition(session.status, 'PAUSED');
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
    this.cancelIntentRoutingRetries(sessionId);
    this.intentRoutingControllers.get(sessionId)?.abort(termination);
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

  async resume(sessionId: string, reason = '用户已继续会话', confirmationId?: string) {
    const session = this.get(sessionId);
    const history = this.events.list(sessionId);
    const pending = this.pendingConfirmationContext(sessionId);
    if (confirmationId) {
      if ((session.activeRecoveryCheckpoint && session.activeRecoveryCheckpoint.confirmationId !== confirmationId) ||
          (pending && pending.confirmationId !== confirmationId)) {
        throw new ConflictException('该确认已过期，请使用当前会话的确认卡片。');
      }
      const resolved = history.find(event => event.type === 'user_confirmation_resolved' &&
        (event.metadata.payload as { confirmationId?: string })?.confirmationId === confirmationId);
      if (resolved) {
        const payload = resolved.metadata.payload as { status?: string; selectedOptionKey?: string };
        if (payload.status !== 'approved' || payload.selectedOptionKey !== 'resume') {
          throw new ConflictException('该确认已结束，不能再次继续执行。');
        }
        return { session, event: resolved, confirmationEvent: resolved };
      }
      if (pending?.confirmationId !== confirmationId || !pending.options.some(option => option.key === 'resume')) {
        throw new ConflictException('当前确认不允许通过继续按钮执行，请使用对应的决策操作。');
      }
    }
    if (['AGENT_DISCUSSING', 'REVISING_BRIEF', 'EXECUTING', 'REWORKING', 'COMPLETED'].includes(session.status)) {
      return { session, event: history.at(-1), confirmationEvent: undefined };
    }
    if (this.runtime?.hasUnconfirmedStops?.(sessionId)) {
      throw new ConflictException('本地执行停止状态尚未确认，请先重试停止或检查本地助手。');
    }
    const lifecycle = this.lifecycle.get(sessionId);
    if (lifecycle?.state === 'active' && lifecycle.admission === 'closed') {
      try {
        const reopened = await this.lifecycle.reopen(sessionId);
        if (reopened.event) this.events.acceptCommitted(reopened.event);
      } catch (error) {
        if (String(error).includes('STOP_UNCONFIRMED')) {
          throw new ConflictException('本地执行停止状态尚未确认，请先重试停止或检查本地助手。');
        }
        throw error;
      }
    }
    if (
      session.status === 'WAIT_USER_DECISION' &&
      session.workflowRunId &&
      this.workflowRuntime &&
      (this.workflowRuntime.awaitsAgentSubstitution?.(session.workflowRunId) ||
        this.workflowRuntime.awaitsUpstreamRerun?.(session.workflowRunId))
    ) {
      const event = this.events.create({
        sessionId,
        type: 'session_status_changed',
        priority: 'high',
        content: '当前工作流仍在等待明确的用户决策，请选择改派、跳过、返工节点或取消。',
        metadata: createMetadata('system_notice', {
          status: 'WAIT_USER_DECISION',
          requestedStatus: 'EXECUTING',
          reason: 'workflow_decision_required'
        })
      });
      return { session, event, confirmationEvent: undefined };
    }
    const missingBriefRecovery = session.status === 'WAIT_USER_DECISION' && !session.currentTaskBriefId &&
      [...history].reverse().find(event => event.type === 'session_status_changed')?.metadata.payload?.reason === messages.resumeBriefMissing;
    if (session.status === 'FAILED' || session.status === 'INTERRUPTED' || missingBriefRecovery) {
      const effectiveConfirmationId = confirmationId ?? session.activeRecoveryCheckpoint?.confirmationId;
      this.retryFailedSession(session, history.at(-1)?.id ?? session.id, effectiveConfirmationId);
      const updated = this.events.list(sessionId);
      return { session, event: updated.at(-1), confirmationEvent: updated.find(event =>
        event.type === 'user_confirmation_resolved' &&
        (event.metadata.payload as { confirmationId?: string })?.confirmationId === effectiveConfirmationId) };
    }
    if (session.status !== 'PAUSED') {
      if (pending && (pending.requiresStructuredAction || !pending.options.some(option => option.key === 'resume'))) {
        throw new ConflictException('当前会话需要明确的用户决策，请使用对应的确认操作。');
      }
      if (!session.currentTaskBriefId) throw new ConflictException('当前任务契约尚未生成，请先完成当前需求确认或从失败阶段重试。');
      return this.control(sessionId, 'EXECUTING', reason, confirmationId);
    }
    this.assertControlTransition(session.status, 'EXECUTING');
    const previousStatus = session.pauseState?.previousStatus ?? 'EXECUTING';
    session.pauseState = undefined;
    session.interruption = undefined;
    const nextStatus = this.hasFinalDelivery(sessionId)
      ? 'COMPLETED'
      : previousStatus === 'AGENT_DISCUSSING' || previousStatus === 'REVISING_BRIEF'
        ? 'AGENT_DISCUSSING'
        : previousStatus.startsWith('WAIT_') || previousStatus === 'FAILED' || previousStatus === 'COMPLETED'
          ? previousStatus : !session.currentTaskBriefId ? 'AGENT_DISCUSSING' : 'EXECUTING';
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
    const pendingRoutes = this.contextManagement?.listRoutingRecords(sessionId)
      .filter(item => item.snapshotId && ['SNAPSHOT_READY', 'PENDING_RETRY'].includes(item.status)) ?? [];
    for (const routing of pendingRoutes) {
      const followUp = this.contextManagement?.listFollowUps(sessionId).find(item => item.routingId === routing.id);
      if (followUp) this.enqueueIntentRouting(sessionId, routing.id, routing.snapshotId!, followUp.id);
    }
    if (nextStatus === 'AGENT_DISCUSSING') this.generateBriefInBackground(session);
    else if (nextStatus === 'EXECUTING') this.resumeExecution(session);
    return { session, event, confirmationEvent };
  }

  control(sessionId: string, status: SessionStatus, reason?: string, confirmationId?: string) {
    const session = this.get(sessionId);
    this.assertControlTransition(session.status, status);
    const nextStatus = status === 'EXECUTING' && this.hasFinalDelivery(sessionId) ? 'COMPLETED' : status;
    if (nextStatus === 'EXECUTING') session.interruption = undefined;
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
    const effectiveConfirmationId = confirmationId ?? session.activeRecoveryCheckpoint?.confirmationId;
    const recoveryResolved = effectiveConfirmationId && this.resolveRecoveryCheckpoint(
      session,
      effectiveConfirmationId,
      status === 'CANCELLED' ? 'cancel' : 'resume'
    );
    const confirmationEvent = effectiveConfirmationId && !recoveryResolved
      ? this.events.create({
          sessionId,
          type: 'user_confirmation_resolved',
          content: status === 'CANCELLED' ? messages.userSelectedCancel : messages.userSelectedResume,
          metadata: createMetadata('system_notice', {
            confirmationId: effectiveConfirmationId,
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
    if (!session || !this.lifecycle.matchesActiveGeneration(update.sessionId, update.sessionGeneration)) return;
    session.workflowRunId = update.workflowRunId;
    if (update.kind === 'session_outcome') {
      this.applyOutcome(session.id, update.outcome);
      return;
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED', 'INTERRUPTED'].includes(session.status)) return;
    if (update.status === 'waiting_human') {
      const run = this.workflowRuntime?.get(update.workflowRunId);
      this.setStatus(
        session,
        run?.pendingAgentSubstitution || run?.pendingUpstreamRerun
          ? 'WAIT_USER_DECISION'
          : 'WAIT_WORKFLOW_STEP_CONFIRM'
      );
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

    const workItemStatus = this.workItemStatusForSessionStatus(status);
    if (workItemStatus) {
      void this.retryActiveWorkItemStatus(session, workItemStatus);
    }

    const terminalStatuses: SessionStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
    if (terminalStatuses.includes(status) && !terminalStatuses.includes(previousStatus)) {
      void this.persistence.releaseWorkspaceSessionLease(session.workspaceId, session.id).catch((error) => {
        this.logger.error(`Failed to release workspace session lease for ${session.workspaceId}: ${String(error)}`);
      });
    }
  }

  private async retryActiveWorkItemStatus(session: SessionDetail, status: WorkItem['status']) {
    if (!this.contextManagement) return;
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.workItemStatusForSessionStatus(session.status) !== status) return;
      try {
        await this.contextManagement.updateActiveWorkItemStatus(session, status);
        return;
      } catch (error) {
        const retryable = String(error).includes('PERSISTENCE_REVISION_CONFLICT');
        if (!retryable || attempt === maxAttempts) {
          this.logger.error(`Failed to update active WorkItem status for ${session.id}: ${String(error)}`);
          return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 100 * attempt);
          timer.unref?.();
        });
      }
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

      const runtimeCancellation = this.runtime?.cancelSessionAndWait(sessionId, termination) ??
        Promise.resolve({ requested: 0, completed: 0, timedOut: false });
      await Promise.all([
        this.execution.cancelAndWait(sessionId, termination),
        runtimeCancellation
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
    // Capture the pre-interruption status before anything below can move it.
    const previousStatus = session.status;
    if (session.workflowRunId && this.workflowRuntime) {
      this.workflowRuntime.checkpointInterruptedExecution?.(session.workflowRunId, {
        code: interruption.reason === 'local_runtime_disconnected'
          ? 'LOCAL_RUNTIME_DISCONNECTED'
          : 'SERVICE_SHUTDOWN',
        message: taskReason
      });
    }
    const checkpointReason = interruption.reason === 'local_runtime_disconnected'
      ? 'reconnect_local_runtime' as const
      : 'recover_interrupted_execution' as const;
    const checkpoint = this.createRecoveryCheckpoint(session, checkpointReason, {
      phase: 'execution_interrupted'
    });
    session.interruption = {
      reason: interruption.reason,
      invocationId: interruption.invocationId,
      occurredAt: interruption.occurredAt,
      wakeable: true,
      previousStatus,
      workItemId: session.activeWorkItemId,
      phase: INTERRUPTION_PHASE_BY_STATUS[previousStatus]
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
    this.createRecoveryConfirmation(session, checkpoint, {
      content: interruption.reason === 'local_runtime_disconnected'
        ? '本机 Runtime 已断开，请重新连接后继续当前任务。'
        : '服务重启已中断当前执行，请确认是否继续。',
      title: interruption.reason === 'local_runtime_disconnected'
        ? '本机 Runtime 已断开'
        : '执行已中断',
      description: interruption.reason === 'local_runtime_disconnected'
        ? '会话与工作流检查点已保留。重新启动本机 Runtime 后可继续执行。'
        : '会话与工作流检查点已保留，继续时会从当前节点创建新的执行尝试。'
    });
  }

  private failSession(session: SessionDetail, error: unknown, phase: string) {
    const runtimeError = extractRuntimeError(error);
    if (this.applyWorkItemBudgetExhaustion(session, runtimeError)) return;
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
    const checkpoint = this.createRecoveryCheckpoint(session, 'retry_failed_execution', { phase });
    this.createRecoveryConfirmation(session, checkpoint, {
      content: '当前执行失败，可以从保留的检查点重试。',
      title: '执行失败',
      description: `${message}\n继续时会重试当前阶段，不会重放已经完成的步骤。`
    });
  }

  private failSessionWithFullError(session: SessionDetail, error: unknown, phase: string) {
    const runtimeError = extractRuntimeError(error);
    if (this.applyWorkItemBudgetExhaustion(session, runtimeError)) return;
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
    const checkpoint = this.createRecoveryCheckpoint(session, 'retry_failed_execution', { phase: effectivePhase });
    this.createRecoveryConfirmation(session, checkpoint, {
      content: '当前执行失败，可以从保留的检查点重试。',
      title: '执行失败',
      description: `${fullMessage}\n继续时会重试当前阶段，不会重放已经完成的步骤。`
    });
  }

  private applyWorkItemBudgetExhaustion(session: SessionDetail, runtimeError: RuntimeError | undefined) {
    if (runtimeError?.code !== 'WORK_ITEM_BUDGET_EXHAUSTED') return false;
    this.applyOutcome(session.id, {
      kind: 'work_item_budget_exhausted',
      reason: runtimeError.message,
      ...(session.activeWorkItemId ? { workItemId: session.activeWorkItemId } : {}),
      error: runtimeError
    });
    return true;
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
      INTERRUPTED: ['EXECUTING', 'AGENT_DISCUSSING', 'CANCELLED'],
      COMPLETED: [],
      FAILED: ['EXECUTING', 'CANCELLED'],
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

  /** Phase 4 card: the coordinator needs user approval to add the workflow's agents. */
  async resolveWorkflowMemberMapping(
    sessionId: string,
    input: { confirmationId: string; decision: 'approve' | 'decline' }
  ) {
    const session = this.get(sessionId);
    const request = this.assertPendingConfirmation(sessionId, input.confirmationId, 'confirm_workflow_member_mapping');
    const payload = request.metadata.payload as Record<string, unknown> | undefined;
    const addable = Array.isArray(payload?.addableAgentIds) ? (payload.addableAgentIds as string[]) : [];
    this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      sessionUserId: session.ownerId,
      content: input.decision === 'approve' ? `已邀请 ${addable.length} 个 Agent。` : '已取消。',
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        reason: 'confirm_workflow_member_mapping',
        status: input.decision === 'approve' ? 'approved' : 'declined',
        selectedOptionKey: input.decision,
        addableAgentIds: addable
      })
    });
    if (input.decision !== 'approve') return session;
    for (const agentId of addable) {
      if (!session.participatingAgentIds.includes(agentId)) {
        session.participatingAgentIds.push(agentId);
      }
    }
    if (addable.length) this.persist();
    return session;
  }

  /** Phase 3 card: the coordinator asked to add a member; only the user can say yes. */
  async resolveMemberAddition(
    sessionId: string,
    input: { discussionId: string; confirmationId: string; decision: 'approve' | 'decline' }
  ) {
    const session = this.get(sessionId);
    const request = this.assertPendingConfirmation(sessionId, input.confirmationId, 'confirm_member_addition');
    const payload = request.metadata.payload as Record<string, unknown> | undefined;
    const targetAgentId = typeof payload?.targetAgentId === 'string' ? payload.targetAgentId : undefined;
    if (!targetAgentId || payload?.discussionId !== input.discussionId) {
      throw new BadRequestException('Member addition card does not match this discussion.');
    }
    this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      sessionUserId: session.ownerId,
      content: input.decision === 'approve' ? `已邀请 ${String(payload?.targetAgentKey ?? targetAgentId)} 参与讨论。` : `未邀请 ${String(payload?.targetAgentKey ?? targetAgentId)}。`,
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        reason: 'confirm_member_addition',
        status: input.decision === 'approve' ? 'approved' : 'declined',
        selectedOptionKey: input.decision === 'approve' ? 'approve_member' : 'decline_member',
        discussionId: input.discussionId,
        targetAgentId
      })
    });
    if (input.decision !== 'approve') return session;
    if (!session.participatingAgentIds.includes(targetAgentId)) {
      session.participatingAgentIds = [...session.participatingAgentIds, targetAgentId];
      await this.persist();
    }
    await this.orchestrator.consultApprovedMember(session, {
      discussionId: input.discussionId,
      agentId: targetAgentId,
      objective: String(payload?.objective ?? ''),
      expectedResult: String(payload?.expectedResult ?? '')
    });
    return session;
  }

  /** Phase 3 card: the coordinator listed what is unresolved; the user answers in chat or proceeds as-is. */
  async resolveDiscussionClarification(
    sessionId: string,
    input: { discussionId: string; confirmationId: string; decision: 'answer_in_chat' | 'proceed_anyway' }
  ) {
    const session = this.get(sessionId);
    const request = this.assertPendingConfirmation(sessionId, input.confirmationId, 'discussion_clarification');
    if ((request.metadata.payload as Record<string, unknown> | undefined)?.discussionId !== input.discussionId) {
      throw new BadRequestException('Clarification card does not match this discussion.');
    }
    this.events.create({
      sessionId,
      type: 'user_confirmation_resolved',
      sessionUserId: session.ownerId,
      content: input.decision === 'proceed_anyway' ? '按现有结论继续。' : '将在对话中回复。',
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        reason: 'discussion_clarification',
        status: 'approved',
        selectedOptionKey: input.decision,
        discussionId: input.discussionId
      })
    });
    if (input.decision === 'proceed_anyway') {
      await this.orchestrator.acceptDiscussionSynthesis(session, input.discussionId);
    }
    return session;
  }

  private isConfirmationApproved(sessionId: string, confirmationId: string) {
    return this.events.list(sessionId).some(
      (event) =>
        event.type === 'user_confirmation_resolved' &&
        (event.metadata.payload as { confirmationId?: string; status?: string } | undefined)?.confirmationId === confirmationId &&
        (event.metadata.payload as { status?: string } | undefined)?.status === 'approved'
    );
  }

  /**
   * The exact version a confirmation card asked the user to approve, as the
   * phase-0 binding. Cards issued before documents existed carry no binding
   * and confirm the brief as before.
   */
  private documentBindingFromCard(
    session: SessionDetail,
    confirmationId: string,
    payload: Record<string, unknown> | undefined
  ): RequirementConfirmationBinding | undefined {
    const documentId = payload?.documentId;
    if (typeof documentId !== 'string' || !session.activeWorkItemId) return undefined;
    return {
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
      workItemRevision: Number(payload?.workItemRevision),
      confirmationId,
      documentId,
      documentRevision: Number(payload?.documentRevision),
      contentHash: String(payload?.contentHash ?? ''),
      businessFingerprint: String(payload?.businessFingerprint ?? '')
    };
  }

  /**
   * Refuses an approval of something the user is no longer looking at. The
   * current binding is rebuilt from state — latest document version, current
   * requirement revision, current decision ledger — and compared field by
   * field; the response carries the current version so the client can show
   * the new difference instead of a bare error (AC3).
   */
  private assertConfirmationCurrent(session: SessionDetail, received: RequirementConfirmationBinding) {
    const latest = this.requirementDocuments.latest(session.id, received.workItemId);
    /**
     * The requirement version a confirmation is judged against is the one the
     * *document* was written for, not the live WorkItem counter. That counter
     * also moves on pure status transitions (WAIT_USER_CONFIRM bumps it via
     * updateActiveWorkItemStatus), which changes no requirement text — keying
     * on it made every legitimate approval read as stale. A real requirement
     * revision produces a new document version, which this check still catches
     * through documentRevision and contentHash.
     */
    const current: RequirementConfirmationBinding | undefined = latest ? {
      sessionId: session.id,
      workItemId: received.workItemId,
      workItemRevision: latest.workItemRevision,
      confirmationId: received.confirmationId,
      documentId: latest.id,
      documentRevision: latest.documentRevision,
      contentHash: latest.contentHash,
      businessFingerprint: requirementConfirmationFingerprint({
        workItemRevision: latest.workItemRevision,
        documentRevision: latest.documentRevision,
        contentHash: latest.contentHash,
        decisionLedgerRevision: session.decisionLedgerRevision ?? 0
      })
    } : undefined;
    if (current && matchesRequirementConfirmation(received, current)) return;
    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_resolved',
      sessionUserId: session.ownerId,
      content: '该确认对应的需求文档版本已变化，请查看最新版本后重新确认。',
      metadata: createMetadata('system_notice', {
        confirmationId: received.confirmationId,
        status: 'expired',
        resolution: 'stale_confirmation',
        reason: 'confirm_task_brief',
        received: { documentId: received.documentId, documentRevision: received.documentRevision, contentHash: received.contentHash },
        ...(current ? { current: { documentId: current.documentId, documentRevision: current.documentRevision, contentHash: current.contentHash, workItemRevision: current.workItemRevision } } : {})
      })
    });
    throw new ConflictException({
      code: 'stale_confirmation',
      received: { documentId: received.documentId, documentRevision: received.documentRevision, contentHash: received.contentHash, workItemRevision: received.workItemRevision },
      ...(current ? { current: { documentId: current.documentId, documentRevision: current.documentRevision, contentHash: current.contentHash, workItemRevision: current.workItemRevision } } : {})
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

  private retryFailedSession(
    session: SessionDetail,
    sourceEventId: string,
    confirmationId?: string
  ) {
    if (this.runtime?.hasUnconfirmedStops?.(session.id)) throw new ConflictException('上一次执行是否结束尚未确认，暂不能重新尝试。');
    this.resolveRecoveryCheckpoint(session, confirmationId);
    // 中断不写失败事件，`latestFailurePhase()` 对它恒返回 undefined，所以中断记下的
    // 阶段是唯一可靠来源。必须在清空 `interruption` 之前取出。
    const interruptedPhase = session.interruption?.phase;
    session.interruption = undefined;
    // 本机 Runtime 可能在会话失败之后才退出。此时直接重试只会在路由阶段硬失败,
    // 所以先停在用户决策上,等用户重启本机 Runtime 后再继续。
    if (this.localBridgeRuntimeOffline(session)) {
      this.requestLocalRuntimeReconnectDecision(session, 'failed_session_retry', sourceEventId);
      this.logger.warn(
        `[Session ${session.id}] Local Runtime is offline; retry waits for reconnect instead of rerunning the failed phase`
      );
      return;
    }
    // 崩溃前已入队的消息 + 用户重启后只打「继续」：直接 resume 会静默忽略那条排队消息。
    // 把控制权交给队列，由 processNextFollowUp 决定怎么处理（方案 A 下会重建契约）。
    const hasQueuedFollowUp = session.pendingFollowUpMessages?.some((item) => item.status === 'queued') ?? false;
    if (hasQueuedFollowUp) {
      this.events.create({
        sessionId: session.id,
        type: 'session_status_changed',
        priority: 'high',
        content: '收到继续指令，正在处理等待中的后续需求。',
        metadata: createMetadata('system_notice', {
          status: session.status,
          reason: 'resume_hands_over_to_queued_follow_up',
          sourceEventId
        })
      });
      this.scheduleFollowUpPlanning(session.id);
      return;
    }
    const failurePhase = interruptedPhase ?? this.latestFailurePhase(session.id);
    const shouldRetryBrief =
      !session.currentTaskBriefId ||
      ['discussion', 'brief_generation', 'brief_revision'].includes(failurePhase ?? '');
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

    if (!session.workflowRunId || !this.workflowRuntime) {
      for (const task of this.tasks.list(session.id)) {
        if (task.status === 'failed') {
          this.tasks.update(task, { status: 'pending', resultSummary: undefined,
            previousExecutionOperationId: task.executionOperationId, executionOperationId: undefined });
        }
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
    const lifecycleGeneration = this.lifecycle.generation(session.id);
    if (!this.lifecycle.isActive(session.id, lifecycleGeneration)) return;
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
          coordinatorId: coordinator.id,
          sessionGeneration: lifecycleGeneration
        })
        .then((resumed) => {
          if (!resumed) {
            // 这里不能再走 ask_user：ask_user 会重新发一张
            // coordinator_routing_needs_user_decision 确认卡，而用户点「继续执行」
            // 又会回到 resumeExecution，形成同一张卡无限重复。没有可恢复节点是
            // 确定性的终态，直接报错让用户看到真实原因。
            this.failSession(
              session,
              new Error('当前工作流没有可恢复的运行中节点，无法继续执行。'),
              'workflow_resume'
            );
          }
        })
        .catch((error) => this.failSession(session, error, 'workflow_resume'));
      return;
    }
    this.tasks.resetStaleRunning(session.id, session.activeWorkItemId);
    const unfinishedTasks = this.tasks.unfinished(session.id, session.activeWorkItemId);
    this.execution.start(session, brief, unfinishedTasks,
      (outcome) => this.applyOutcome(session.id, outcome, lifecycleGeneration), lifecycleGeneration);
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
    const lifecycleGeneration = this.lifecycle.generation(session.id);
    this.execution.start(session, brief, unfinishedTasks,
      (outcome) => this.applyOutcome(session.id, outcome, lifecycleGeneration), lifecycleGeneration);
  }

  private titleFromInput(input: string) {
    return input.trim().slice(0, 28) || '新协作会话';
  }

  private participatingAgents(session: SessionDetail) {
    const agents = session.participatingAgentIds
      .map((agentId) => this.agents.findByIdOrKey(agentId))
      .filter((agent): agent is Agent => Boolean(agent))
      .filter((agent) => agent.management?.allowedSurfaces.includes('chat') ?? true)
      .filter((agent) => agent.status === 'active');
    if (agents.length) return agents;
    const catalog = this.agents as unknown as {
      listForSurface?: (surface: 'chat') => Agent[];
      list?: () => Agent[];
    };
    return catalog.listForSurface?.('chat') ?? catalog.list?.() ?? [];
  }

  private pickSessionAgent(session: SessionDetail, preferredKeys: string[]) {
    const agents = this.participatingAgents(session);
    const catalog = this.agents as unknown as {
      findSystemByKey?: (key: string) => Agent | undefined;
    };
    for (const key of preferredKeys) {
      const preferred = catalog.findSystemByKey?.(key) ?? agents.find((agent) => agent.key === key);
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
      // 等待授权期间本机 Runtime 可能已经退出。此时恢复执行只会在路由阶段硬失败，
      // 所以先停在用户决策上，等用户重启本机 Runtime 后再继续。
      if (this.localBridgeRuntimeOffline(session)) {
        this.persist();
        this.requestLocalRuntimeReconnectDecision(session, 'capability_approved');
        this.logger.warn(
          `[Session ${sessionId}] Local Runtime is offline; invocation ${inv.invocationId} waits for reconnect instead of resuming`
        );
        continue;
      }
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

  /**
   * Mirrors the runtime router's local_bridge eligibility rule: the workspace must still be
   * registered by a connected CLI, and at least one allowed Runtime must be detected on it.
   */
  private localBridgeRuntimeOffline(session: SessionDetail) {
    if (session.workingDirectory?.kind !== 'local_bridge' || !this.localRuntime) return false;
    const candidates = this.localRuntime.listRuntimeCandidates(session.workingDirectory.id);
    const allowed = session.runtimePreference?.allowedRuntimeTypes;
    const usable = allowed?.length
      ? candidates.filter((candidate) => allowed.includes(candidate.runtimeType))
      : candidates;
    return usable.length === 0;
  }

  private requestLocalRuntimeReconnectDecision(
    session: SessionDetail,
    trigger: 'capability_approved' | 'failed_session_retry',
    sourceEventId?: string
  ) {
    const workspaceName = session.workingDirectory?.name ?? session.workspaceId;
    this.setStatus(session, 'WAIT_USER_DECISION');
    const checkpoint = this.createRecoveryCheckpoint(session, 'reconnect_local_runtime', {
      phase: trigger,
      ...(sourceEventId ? { sourceEventId } : {})
    });
    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_requested',
      priority: 'high',
      content: '本机 Runtime 已断开，无法继续执行，请重新启动本机 Runtime。',
      metadata: createMetadata('confirmation_card', {
        confirmationId: checkpoint.confirmationId,
        reason: 'reconnect_local_runtime',
        title: '本机 Runtime 已断开',
        description:
          `本机工作目录「${workspaceName}」当前没有可用 Runtime，` +
          (trigger === 'capability_approved'
            ? '能力授权已记录但任务无法继续。'
            : '无法重试上一次失败的执行。') +
          '请重新启动本机 Runtime，连接成功后点击「继续执行」。',
        options: [
          { key: 'resume', label: '继续执行', style: 'primary' },
          { key: 'cancel', label: '取消会话', style: 'default' }
        ],
        workspaceId: session.workingDirectory?.id ?? session.workspaceId,
        trigger
      })
    });
    this.persist();
  }

  /** Tells parked Sessions their local workspace went away, instead of letting them find out on resume. */
  private notifyLocalRuntimeOffline(workspaceId: string) {
    for (const session of this.sessions.values()) {
      if (session.workingDirectory?.kind !== 'local_bridge') continue;
      if (session.workingDirectory.id !== workspaceId) continue;
      if (!WAITING_USER_SESSION_STATUSES.has(session.status)) continue;
      this.events.create({
        sessionId: session.id,
        type: 'session_status_changed',
        priority: 'high',
        content: '本机 Runtime 已断开：重新启动本机 Runtime 后才能继续执行本会话。',
        metadata: createMetadata('system_notice', {
          status: session.status,
          reason: 'local_runtime_disconnected',
          workspaceId
        })
      });
    }
  }

  private persist() {
    this.persistence.setCollection('sessions', [...this.sessions.values()]);
  }

  private createRecoveryCheckpoint(
    session: SessionDetail,
    reason: SessionRecoveryCheckpoint['reason'],
    input: Pick<SessionRecoveryCheckpoint, 'phase' | 'sourceEventId'> = {}
  ): SessionRecoveryCheckpoint {
    const checkpoint: SessionRecoveryCheckpoint = {
      confirmationId: crypto.randomUUID(),
      reason,
      retryable: true,
      createdAt: nowIso(),
      ...(session.workflowRunId ? { workflowRunId: session.workflowRunId } : {}),
      ...(input.phase ? { phase: input.phase } : {}),
      ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {})
    };
    session.activeRecoveryCheckpoint = checkpoint;
    this.persist();
    return checkpoint;
  }

  private createRecoveryConfirmation(
    session: SessionDetail,
    checkpoint: SessionRecoveryCheckpoint,
    input: { content: string; title: string; description: string }
  ) {
    this.events.createOnce(`recovery-confirmation:${session.id}:${checkpoint.confirmationId}`, {
      sessionId: session.id,
      type: 'user_confirmation_requested',
      priority: 'high',
      content: input.content,
      metadata: createMetadata('confirmation_card', {
        confirmationId: checkpoint.confirmationId,
        reason: checkpoint.reason,
        title: input.title,
        description: input.description,
        workflowRunId: checkpoint.workflowRunId,
        options: [
          { key: 'resume', label: '继续执行', style: 'primary' },
          { key: 'cancel', label: '取消会话', style: 'default' }
        ]
      })
    });
  }

  private resolveRecoveryCheckpoint(
    session: SessionDetail,
    confirmationId?: string,
    selectedOptionKey: 'resume' | 'cancel' = 'resume'
  ) {
    const checkpoint = session.activeRecoveryCheckpoint;
    if (!checkpoint || (confirmationId && checkpoint.confirmationId !== confirmationId)) return false;
    const events = this.events.list(session.id);
    const resolved = events.some((event) => event.type === 'user_confirmation_resolved' &&
      (event.metadata.payload as { confirmationId?: unknown } | undefined)?.confirmationId === checkpoint.confirmationId);
    if (!resolved) {
      this.events.create({
        sessionId: session.id,
        type: 'user_confirmation_resolved',
        content: selectedOptionKey === 'cancel'
          ? '用户已取消当前恢复执行。'
          : '用户已选择继续恢复当前执行。',
        metadata: createMetadata('system_notice', {
          confirmationId: checkpoint.confirmationId,
          status: selectedOptionKey === 'cancel' ? 'rejected' : 'approved',
          selectedOptionKey
        })
      });
    }
    session.activeRecoveryCheckpoint = undefined;
    this.persist();
    return true;
  }

  private findPendingConfirmationId(
    sessionId: string,
    reason: string,
    predicate?: (payload: { relatedBriefId?: string }) => boolean
  ) {
    const events = this.events.list(sessionId);
    const resolvedIds = new Set(events
      .filter((event) => event.type === 'user_confirmation_resolved')
      .map((event) => (event.metadata.payload as { confirmationId?: unknown } | undefined)?.confirmationId)
      .filter((value): value is string => typeof value === 'string'));
    const requests = events.filter((event) => {
      if (event.type !== 'user_confirmation_requested') return false;
      const payload = event.metadata.payload as { confirmationId?: unknown; reason?: unknown; relatedBriefId?: unknown } | undefined;
      if (typeof payload?.confirmationId !== 'string' || payload.reason !== reason || resolvedIds.has(payload.confirmationId)) return false;
      return !predicate || predicate({ relatedBriefId: typeof payload.relatedBriefId === 'string' ? payload.relatedBriefId : undefined });
    });
    return requests.length === 1
      ? (requests[0]?.metadata.payload as { confirmationId: string }).confirmationId
      : undefined;
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

  private workItemStatusForSessionStatus(status: SessionStatus) {
    if (status === 'COMPLETED') return 'COMPLETED' as const;
    if (status === 'FAILED') return 'FAILED' as const;
    if (status === 'CANCELLED') return 'CANCELLED' as const;
    if (['EXECUTING', 'POST_REVIEW', 'REWORKING', 'APPLYING_CHANGES'].includes(status)) {
      return 'EXECUTING' as const;
    }
    if ([
      'WAIT_USER_CONFIRM',
      'WAIT_WORKFLOW_SELECT',
      'WAIT_WORKFLOW_STEP_CONFIRM',
      'WAIT_WORKSPACE_CONFLICT_RESOLUTION',
      'WAIT_USER_DECISION',
      'PAUSED',
      'INTERRUPTED'
    ].includes(status)) return 'WAITING_USER' as const;
    if (status === 'AGENT_DISCUSSING' || status === 'REVISING_BRIEF') return 'OPEN' as const;
    return undefined;
  }
}

function intentClarificationMetricReason(errors: string[]) {
  if (errors.includes('SNAPSHOT_STALE')) return 'snapshot_stale';
  if (errors.includes('REFERENCE_OUTSIDE_SNAPSHOT')) return 'invalid_reference';
  if (errors.includes('STATE_TRANSITION_INVALID')) return 'invalid_transition';
  if (errors.includes('REQUIRED_FIELDS_MISSING')) return 'missing_fields';
  if (errors.includes('HIGH_RISK_REQUIRES_CONFIRMATION')) return 'high_risk';
  if (errors.includes('CONFIRMATION_TARGET_REQUIRED')) return 'confirmation_target';
  if (errors.includes('INTENT_AMBIGUOUS')) return 'ambiguous';
  return 'other';
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
