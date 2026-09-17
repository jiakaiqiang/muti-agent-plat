import crypto from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import type {
  ActorRef,
  AgentDefinition as Agent,
  AgentMessageOutput,
  AgentRunPhase,
  AgentRunResult,
  AgentTask,
  Artifact,
  CollaborationEvent,
  ContextAssembly,
  ExpectedRuntimeOutput,
  InvocationPlan,
  PendingApprovalInfo,
  PendingInvocation,
  SummaryMemory,
  SummaryMemoryCheckpoint,
  TaskContext,
  FinalDeliveryOutput,
  PostReviewReportOutput,
  PostReviewAction,
  RuntimeArtifactOutput,
  RuntimeBudget,
  RuntimeContextFileRequest,
  RuntimeContextRequest,
  RuntimeError,
  RuntimeFileChange,
  RuntimeOutput,
  RuntimeOutputKind,
  RuntimePreference,
  RuntimeType,
  RuntimeWriteMode,
  ExecutionTermination,
  FileRevisionAgentResult,
  FileRevisionCandidateOutput,
  FileRevisionRun,
  SessionDetail,
  SupplementalContextPathFailureCode,
  SupplementalContextResolution,
  TaskEvidenceRef,
  SuggestedAgentTask,
  TaskAcceptanceDecisionOutput,
  TaskBrief,
  TaskBriefOutput,
  TaskExecutionResultOutput,
  UserMessageHandlingPlan,
  UserMessageHandlingPlanOutput,
  ValidationEvidenceReport,
  WorkspaceRevision,
  WorkspaceSnapshot
} from '@agent-cluster/shared';
import {
  createAgentMessageOutput,
  createRuntimeArtifactSystemEvidence,
  createMetadata,
  shouldPublishRuntimeEventToCollaboration,
  validateRuntimeOutput
} from '@agent-cluster/shared';
import { applyServerLocalFileChanges } from '../../common/server-file-changes.js';
import { detectWorkspaceStack } from '../../common/workspace-scanner.js';
import { messages } from '../../common/messages.js';
import {
  abortWithTermination,
  createExecutionTermination,
  isExecutionTermination,
  normalizeTerminatedResult,
  terminationFromSignal
} from '../../common/execution-termination.js';
import {
  globalDefaultRuntimeType,
  phaseTimeoutMs,
  projectPolicyRuntimeType,
  runtimeModeLabel
} from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { buildBudget, estimateTokens } from '../../common/token.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { AgentsService } from '../agents/agents.service.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { CapabilitiesService } from '../capabilities/capabilities.service.js';
import { EventsService } from '../events/events.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import { KnowledgeService } from '../rag/knowledge.service.js';
import { RuntimeService } from '../runtimes/runtime.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { AgentProfileCompilerService } from '../agent-profile/agent-profile-compiler.service.js';
import {
  ContextManagementService,
  type WorkItemContextSlice
} from '../context-management/context-management.service.js';
import { SystemAgentRuntimePolicyService } from '../agents/system-agent-runtime-policy.service.js';
import { buildEnvelopeFromContextAssembly } from '../context-v2/build-envelope-from-context-assembly.js';
import {
  evaluateGroundedEvidenceGate,
  requiresGroundedRuntimeEvidence
} from '../context-v2/grounded-evidence-gate.js';
import { ContextRouterService } from './context-router.service.js';
import { ProjectMapService } from './project-map.service.js';
import { consumeRuntimeEvents } from './runtime-stream-consumer.js';
import { structuredOutputGuard } from './structured-output-guard.js';
import { acceptanceFingerprint, explicitTaskPreflight } from './task-acceptance-preflight.js';
import { boundedConsultations, consultationConcurrency } from './bounded-consultation.js';
import { shouldEmitHeartbeat, shouldSuppressHeartbeat } from './runtime-heartbeat-policy.js';
import { smartRuntimePick } from './smart-runtime-pick.js';
import { buildCoverageSystemRule, buildWorkspaceManifest } from './workspace-manifest.js';
import {
  canRetryWithSupplementalContext,
  resolveContextInsufficientMaxRetries
} from './supplemental-context-retry.js';
import {
  collectSeenContextSignatures,
  trimToNovelContext
} from './supplemental-context-dedupe.js';
import { truncateContentForEvidence } from '../../common/evidence-truncation.js';
import { WorkspaceProviderResolver } from '../workspaces/workspace-provider-resolver.js';
import { WorkspaceWritebackService } from '../workspaces/workspace-writeback.service.js';
import { WorktreeExecutionService } from '../worktree-execution/worktree-execution.service.js';
import { workspaceProviderKindForDirectory } from '../workspaces/workspace-provider.js';
import {
  InvocationResolutionError,
  InvocationResolverService
} from '../runtime-routing/invocation-resolver.service.js';
import { InvocationWorkspaceBindingsService } from '../runtimes/invocation-workspace-bindings.service.js';
import { FileRevisionsService } from '../file-revisions/file-revisions.service.js';
import { applyRuntimeWriteModeOverride } from './runtime-write-mode-policy.js';

export type ExecutionOutcome =
  | { kind: 'delivered' }
  | { kind: 'rework'; reason: string }
  | {
      kind: 'ask_user';
      reason: string;
      actions?: PostReviewAction[];
      workflowAgentSubstitution?: WorkflowAgentSubstitutionRequest;
      workflowUpstreamIncomplete?: WorkflowUpstreamIncompleteSignal;
    }
  | { kind: 'approval_required'; reason: string }
  | { kind: 'workflow_step_completed'; taskId: string; resultSummary: string }
  | { kind: 'workspace_conflict'; reason: string }
  | { kind: 'cancelled'; reason: string; termination?: ExecutionTermination }
  | { kind: 'failed'; reason: string; error?: RuntimeError };

function cancelledExecutionOutcome(signal?: AbortSignal): ExecutionOutcome {
  const termination = terminationFromSignal(signal);
  return {
    kind: 'cancelled',
    reason: messages.cancelled,
    ...(termination ? { termination } : {})
  };
}

type TaskRunOutcome =
  | { ok: true }
  | {
      ok: false;
      message: string;
      approvalRequired?: boolean;
      workspaceConflict?: boolean;
      code?: RuntimeError['code'];
      retryable?: boolean;
      error?: RuntimeError;
      workflowAgentSubstitution?: WorkflowAgentSubstitutionRequest;
      workflowUpstreamIncomplete?: WorkflowUpstreamIncompleteSignal;
    };

/**
 * Raised when a workflow Agent node ran but could not finish because the input it
 * needed from an earlier stage is missing. Only the blocked node and its own
 * reason are reported here; the Workflow Runtime owns the definition graph and
 * resolves which upstream nodes can be re-run.
 */
export type WorkflowUpstreamIncompleteSignal = {
  taskId: string;
  workflowRunId: string;
  workflowNodeId?: string;
  reason: string;
  missingInputs: string[];
};

export type WorkflowAgentSubstitutionRequest = {
  taskId: string;
  workflowRunId: string;
  workflowNodeId?: string;
  currentAgentId: string;
  candidates: Array<Pick<Agent, 'id' | 'key' | 'name' | 'role'>>;
};

type RuntimeInvocationDraft = {
  recoveryCandidate?: InvocationPlan['recoveryCandidate'];
  submissionRepair?: boolean;
  operation?: InvocationPlan['operation'];
  invocationId: string;
  sessionId: string;
  taskId?: string;
  phase: AgentRunPhase;
  agent: Agent;
  contextAssembly: ContextAssembly;
  expectedOutput: ExpectedRuntimeOutput;
  budget: RuntimeBudget;
  excludedRuntimeTypes?: RuntimeType[];
  runtimeCandidateOverride?: RuntimeType;
  writeModeOverride?: RuntimeWriteMode;
  minimumOutputTokens?: number;
  attempt?: InvocationPlan['attempt'];
  supplementalContextAttempt?: number;
  supplementalContextDurationMs?: number;
};

type SuggestedAgentTaskDraft = Pick<SuggestedAgentTask, 'title' | 'description' | 'acceptanceCriteria'> &
  Partial<Omit<SuggestedAgentTask, 'title' | 'description' | 'acceptanceCriteria'>>;

function agentIdFromActor(actor?: ActorRef): string | undefined {
  return actor?.type === 'agent' ? actor.id : undefined;
}

export function usableAgentMessageOutput(value: unknown): value is AgentMessageOutput {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AgentMessageOutput>;
  return (
    candidate.kind === 'agent_message' &&
    typeof candidate.content === 'string' &&
    candidate.content.trim().length > 0 &&
    ['discussion', 'answer', 'handoff', 'progress', 'risk', 'decision', 'summary'].includes(
      String(candidate.messageKind)
    )
  );
}

export function artifactCreatedEventPayload(
  artifact: Artifact,
  workspaceExecution: AgentRunResult['workspaceExecution'],
  proposalOnly: boolean
) {
  return {
    artifactId: artifact.id,
    type: artifact.type,
    title: artifact.title,
    ...(proposalOnly
      ? { proposalOnly: true }
      : {
          contentSummary: artifact.contentSummary,
          runtimeProposals: artifact.runtimeProposals,
          systemEvidence: artifact.systemEvidence,
          workspaceExecution
        })
  };
}

export function effectiveStructuredOutputLimit(
  budgetLimit: number | undefined,
  runtimeLimit: number | undefined
) {
  const limits = [budgetLimit, runtimeLimit].filter((value): value is number => value !== undefined);
  return limits.length > 0 ? Math.min(...limits) : undefined;
}

// 慢模型（如本地 Ollama）单次调用可达数分钟，心跳让时间线可见"仍在生成"，
// 与"卡死"可区分。心跳事件不回流进 relevantEvents（见 createContextAssembly）。
const RUNTIME_HEARTBEAT_INTERVAL_MS = 30_000;
@Injectable()
export class OrchestratorService {
  private readonly briefsBySession = new Map<string, TaskBrief[]>();
  private readonly suggestedTasksByBriefId = new Map<string, SuggestedAgentTask[]>();
  private readonly runtimeProviderCircuits = new Map<RuntimeType, number>();
  private savePendingInvocationCallback?: (sessionId: string, invocation: PendingInvocation) => void;
  private readonly lifecycle: SessionLifecycleStore;

  constructor(
    private readonly agents: AgentsService,
    private readonly events: EventsService,
    private readonly runtime: RuntimeService,
    private readonly tasks: TasksService,
    private readonly knowledge: KnowledgeService,
    private readonly memories: MemoryService,
    private readonly artifacts: ArtifactsService,
    private readonly capabilities: CapabilitiesService,
    private readonly persistence: PersistenceService,
    private readonly contextRouter: ContextRouterService,
    private readonly projectMap: ProjectMapService,
    private readonly profileCompiler: AgentProfileCompilerService,
    @Optional() private readonly workspaceProviders?: WorkspaceProviderResolver,
    @Optional() private readonly invocationResolver?: InvocationResolverService,
    @Optional() private readonly workspaceBindings?: InvocationWorkspaceBindingsService,
    @Optional() private readonly fileRevisions?: FileRevisionsService,
    @Optional() private readonly workspaceWritebacks?: WorkspaceWritebackService,
    @Optional() private readonly worktreeExecution?: WorktreeExecutionService,
    @Optional() private readonly contextManagement?: ContextManagementService,
    @Optional() private readonly systemAgentPolicies?: SystemAgentRuntimePolicyService
  ) {
    this.lifecycle = new SessionLifecycleStore(persistence);
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

  registerSavePendingInvocationCallback(callback: (sessionId: string, invocation: PendingInvocation) => void) {
    this.savePendingInvocationCallback = callback;
  }

  async retryPendingApprovalInvocation(
    session: SessionDetail,
    inv: PendingInvocation
  ): Promise<AgentRunResult> {
    const taskAgent = await this.agents.findByIdOrKey(inv.agentId);
    if (!taskAgent) {
      throw new Error(`Agent ${inv.agentId} not found for retry`);
    }

    const task = inv.taskId ? this.tasks.find(inv.sessionId, inv.taskId) : undefined;
    const brief = this.briefsBySession.get(inv.sessionId)?.[0];

    // createContextAssembly internally calls createContinuationState which needs taskContext.agentResponsibilities
    // We must NOT call contextRouter.route before createContextAssembly because createContextAssembly does it internally
    // So just call createContextAssembly and let it build everything
    const contextAssembly = this.createContextAssembly(session, taskAgent, brief, task, inv.phase);

    return this.runRuntime(session, {
      invocationId: crypto.randomUUID(),
      sessionId: inv.sessionId,
      taskId: inv.taskId,
      phase: inv.phase,
      agent: taskAgent,
      contextAssembly,
      expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
      budget: contextAssembly.budget
    });
  }

  async discussAndCreateBrief(session: SessionDetail, signal?: AbortSignal) {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    await this.emitWorkspaceAnalyzedEvent(session, coordinator);
    throwIfAborted(signal);
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
    await this.runDiscussion(session, coordinator, signal);
    throwIfAborted(signal);
    const result = await this.runRuntime(session, {
      invocationId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'brief_generation',
      agent: coordinator,
      contextAssembly: this.createContextAssembly(session, coordinator, undefined, undefined, 'brief_generation'),
      expectedOutput: { kind: 'task_brief', schemaVersion: '1.0' },
      budget: buildBudget(session)
    }, signal);
    await this.emitWorkspaceAnalyzedEvent(session, coordinator);
    throwIfAborted(signal);
    const output = this.completedOutput<TaskBriefOutput>(result, 'task_brief');
    const suggestedTasks = this.selectSuggestedTasks(session, output.suggestedTasks);
    const allowGeneratedFileWrites = this.shouldWriteGeneratedFiles(session);

    const brief: TaskBrief = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
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
    // 每次讨论产出新契约时,同步会话级最新目标。originalInput 保留用户原始需求,
    // latestContractGoal 反映当前权威目标,供后续 Agent 上下文注入(见 createContextAssembly)。
    // 该赋值会在随后 sessions.service 的 setStatus/persist 中落库(同一 session 对象引用)。
    session.latestContractGoal = brief.goal;
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

    const briefFileChanges = allowGeneratedFileWrites ? this.briefFileChanges(brief, suggestedTasks) : [];
    const briefArtifact = this.artifacts.create({
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
      agentId: coordinator.id,
      type: 'markdown',
      title: `任务契约 v${brief.version}`,
      contentSummary: brief.goal,
      platformProjections: briefFileChanges,
      metadata: {
        phase: 'task_brief',
        briefId: brief.id
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
        platformProjections: briefFileChanges
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

  async recognizeFollowUpMessage(
    session: SessionDetail,
    content: string,
    mentionedAgentIds: string[],
    signal?: AbortSignal
  ): Promise<UserMessageHandlingPlan> {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    const contextAssembly = this.createContextAssembly(
      session,
      coordinator,
      undefined,
      undefined,
      'user_message_routing'
    );
    contextAssembly.systemRules = [
      ...contextAssembly.systemRules,
      'You are the receiver. For every existing-session message, first identify intent. Do not execute professional work.',
      'Your only responsibilities in this phase are intent recognition and preparing instructions for later task decomposition.',
      'Classify requirementRelation as continuation when the message refines, corrects, asks about, or continues the current requirement. Use new_requirement only when it introduces an independent goal.',
      'When the Session is FAILED and the message continues the same requirement, set failedExecutionAction=resume for an explicit continue/retry request, or replan when the user asks to change the approach or discuss again. Otherwise set failedExecutionAction=none.',
      'A currently running task must not be interrupted. Set shouldPause=false; execution deferral is controlled by the session queue.'
    ];
    contextAssembly.currentUserMessage = content;
    contextAssembly.constraints = [
      ...contextAssembly.constraints,
      `Explicitly mentioned agent ids: ${mentionedAgentIds.join(', ') || '(none)'}`
    ];
    contextAssembly.relevantEvents = [
      ...contextAssembly.relevantEvents,
      {
        eventId: `pending-user-message:${crypto.randomUUID()}`,
        type: 'user_message' as const,
        summary: content,
        createdAt: nowIso()
      }
    ].slice(-12);

    const result = await this.runRuntime(
      session,
      {
        invocationId: crypto.randomUUID(),
        sessionId: session.id,
        phase: 'user_message_routing',
        agent: coordinator,
        contextAssembly,
        expectedOutput: { kind: 'user_message_handling_plan', schemaVersion: '1.0' },
        budget: contextAssembly.budget
      },
      signal
    );
    const output = this.completedOutput<UserMessageHandlingPlanOutput>(result, 'user_message_handling_plan');
    return {
      intent: output.intent,
      requirementRelation: output.requirementRelation,
      failedExecutionAction: output.failedExecutionAction,
      priority: output.priority,
      shouldPause: false,
      affectedTaskIds: output.affectedTaskIds,
      affectedAgentIds: output.affectedAgentIds,
      requiresBriefRevision: output.requiresBriefRevision,
      requiresUserConfirmation: output.requiresUserConfirmation,
      coordinatorInstruction: output.coordinatorInstruction
    };
  }

  async prepareFollowUpExecution(
    session: SessionDetail,
    content: string,
    sourceEventId: string,
    mentionedAgentIds: string[],
    options: { discussionRequired?: boolean; requirementRelation?: UserMessageHandlingPlan['requirementRelation'] } = {},
    signal?: AbortSignal
  ): Promise<{ brief: TaskBrief; tasks: AgentTask[] }> {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    const mentionedAgents = this.participatingAgents(session).filter(
      (agent) => agent.id !== coordinator.id && mentionedAgentIds.includes(agent.id)
    );
    const discussionAgents = mentionedAgents.length
      ? mentionedAgents
      : this.participatingAgents(session).filter((agent) => agent.id !== coordinator.id);

    this.memories.create({
      sessionId: session.id,
      scope: 'session',
      content: `Receiver-recognized follow-up requirement (authoritative for this follow-up):\n${content}`,
      sourceEventId,
      confidence: 1
    });

    if (mentionedAgents.length > 1 || options.discussionRequired) {
      await this.runFollowUpDiscussion(session, coordinator, discussionAgents, content, signal);
    }

    const contextAssembly = this.createContextAssembly(
      session,
      coordinator,
      undefined,
      undefined,
      'brief_generation'
    );
    contextAssembly.systemRules = [
      ...contextAssembly.systemRules,
      'You are the receiver. Decompose this follow-up into executable tasks; do not execute those tasks yourself.',
      'When agents were explicitly mentioned, assign every suggested task only to one of those mentioned agents.',
      options.requirementRelation === 'new_requirement'
        ? 'This is a new independent requirement. Create a new task contract and do not treat the previous goal as authoritative.'
        : 'This follows the current requirement. Preserve relevant accepted constraints and completed work from the current task contract.',
      'If a task is rejected later, the receiver remains responsible for re-routing or re-decomposing it, never for professional execution.'
    ];
    contextAssembly.constraints = [
      ...contextAssembly.constraints,
      `Follow-up requirement: ${content}`,
      `Allowed mentioned agent keys: ${mentionedAgents.map((agent) => agent.key).join(', ') || '(receiver may route among participating agents)'}`
    ];
    const result = await this.runRuntime(
      session,
      {
        invocationId: crypto.randomUUID(),
        sessionId: session.id,
        phase: 'brief_generation',
        agent: coordinator,
        contextAssembly,
        expectedOutput: { kind: 'task_brief', schemaVersion: '1.0' },
        budget: contextAssembly.budget
      },
      signal
    );
    const output = this.completedOutput<TaskBriefOutput>(result, 'task_brief');
    let suggestedTasks = this.selectSuggestedTasks(session, output.suggestedTasks);
    if (mentionedAgents.length) {
      suggestedTasks = suggestedTasks.map((task, index) => {
        const agent = mentionedAgents[index % mentionedAgents.length];
        return {
          ...task,
          suggestedAgentKey: agent.key,
          assignmentReason: task.assignmentReason ?? `User explicitly mentioned ${agent.name} for this follow-up.`
        };
      });
    }

    const brief: TaskBrief = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
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
    session.latestContractGoal = brief.goal;
    this.persistBriefs();

    this.events.create({
      sessionId: session.id,
      type: 'brief_created',
      fromAgentId: coordinator.id,
      toAgentIds: mentionedAgents.map((agent) => agent.id),
      content: '接收者已完成后续需求的任务拆分。',
      metadata: createMetadata('brief_card', {
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
        requiresUserConfirmation: false,
        sourceEventId,
        followUp: true,
        requirementRelation: options.requirementRelation ?? 'continuation'
      })
    });

    return this.prepareExecution(session, brief.id, {
      eligibleAgentIds: mentionedAgents.length ? mentionedAgents.map((agent) => agent.id) : undefined
    });
  }

  async runDirectedBriefRevision(
    session: SessionDetail,
    oldBrief: TaskBrief,
    userModification: string,
    assignedAgentKeys: string[],
    sourceEventId: string,
    signal?: AbortSignal
  ): Promise<TaskBrief> {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);
    const allAgents = this.participatingAgents(session);
    const assignedAgents = allAgents.filter((agent) => assignedAgentKeys.includes(agent.key));

    if (!assignedAgents.length) {
      // 无指定 Agent 时直接由 coordinator 定稿
      return this.finalizeBriefRevisionByCoordinator(session, oldBrief, userModification, signal);
    }

    // 记录定向修订的 memory（只给指定 Agent）
    for (const agent of assignedAgents) {
      this.memories.create({
        sessionId: session.id,
        agentId: agent.id,
        scope: 'session',
        content: `用户对任务契约进行定向修订，指定你审阅以下修改内容（以此为权威基线，只做增量修订，不得推翻）：\n\n${userModification}`,
        sourceEventId,
        confidence: 1.0
      });
    }

    // 各指定 Agent 跑一轮 brief_revision
    throwIfAborted(signal);
    for (const agent of assignedAgents) {
      throwIfAborted(signal);
      const invocationId = crypto.randomUUID();
      const contextAssembly = this.createContextAssembly(session, agent, oldBrief, undefined, 'brief_revision');

      this.events.create({
        sessionId: session.id,
        type: 'agent_status_changed',
        fromAgentId: agent.id,
        content: `${agent.name} 正在审阅用户的契约修改...`,
        metadata: createMetadata('system_notice', {
          agentId: agent.id,
          status: 'thinking',
          thoughtSummary: '审阅用户修改',
          actionSummary: '基于用户修改提出增量修订意见'
        })
      });

      const result = await this.runRuntime(
        session,
        {
          invocationId,
          sessionId: session.id,
          phase: 'brief_revision',
          agent,
          contextAssembly,
          expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' },
          budget: buildBudget(session)
        },
        signal
      );
      throwIfAborted(signal);

      const output =
        result.status === 'completed' && usableAgentMessageOutput(result.output)
          ? (result.output as AgentMessageOutput)
          : createAgentMessageOutput({
              messageKind: 'risk',
              content: `${agent.name} 审阅失败：${result.error?.message ?? '未产出有效意见'}`
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
          relatedBriefId: oldBrief.id,
          runtimeInvocationId: invocationId
        })
      });
    }

    // coordinator 定稿
    throwIfAborted(signal);
    return this.finalizeBriefRevisionByCoordinator(session, oldBrief, userModification, signal);
  }

  private async finalizeBriefRevisionByCoordinator(
    session: SessionDetail,
    oldBrief: TaskBrief,
    userModification: string,
    signal?: AbortSignal
  ): Promise<TaskBrief> {
    const coordinator = this.pickSessionAgent(session, ['coordinator']);

    this.events.create({
      sessionId: session.id,
      type: 'agent_status_changed',
      fromAgentId: coordinator.id,
      content: `${coordinator.name} 正在基于用户修改和 Agent 意见定稿新契约...`,
      metadata: createMetadata('system_notice', {
        agentId: coordinator.id,
        status: 'thinking',
        thoughtSummary: '整合用户修改与 Agent 意见',
        actionSummary: '生成新版任务契约'
      })
    });

    const contextAssembly = this.createContextAssembly(session, coordinator, oldBrief, undefined, 'brief_generation');

    const result = await this.runRuntime(
      session,
      {
        invocationId: crypto.randomUUID(),
        sessionId: session.id,
        phase: 'brief_generation',
        agent: coordinator,
        contextAssembly,
        expectedOutput: { kind: 'task_brief', schemaVersion: '1.0' },
        budget: buildBudget(session)
      },
      signal
    );
    throwIfAborted(signal);

    const output = this.completedOutput<TaskBriefOutput>(result, 'task_brief');
    const suggestedTasks = this.selectSuggestedTasks(session, output.suggestedTasks);
    const allowGeneratedFileWrites = this.shouldWriteGeneratedFiles(session);

    const brief: TaskBrief = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
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
    session.latestContractGoal = brief.goal;
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

    const briefFileChanges = allowGeneratedFileWrites ? this.briefFileChanges(brief, suggestedTasks) : [];
    const briefArtifact = this.artifacts.create({
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
      agentId: coordinator.id,
      type: 'markdown',
      title: `任务契约 v${brief.version}（定向修订）`,
      contentSummary: brief.goal,
      platformProjections: briefFileChanges,
      metadata: {
        phase: 'task_brief',
        briefId: brief.id
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
        platformProjections: briefFileChanges
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

  /**
   * P2 契约持续探讨:在 WAIT_USER_CONFIRM 下,用户 @ 单个 Agent 就当前契约做轻量探讨。
   * 只调被 @ 的 Agent 一次,注入当前契约全文 + 本轮探讨对话历史,产出 agent_message,不修改契约。
   */
  async consultBriefWithAgent(
    session: SessionDetail,
    content: string,
    mentionedAgentIds: string[]
  ): Promise<{ userEvent: CollaborationEvent; consultedAgent: Agent; output: AgentMessageOutput }> {
    const briefId = session.currentTaskBriefId;
    if (!briefId) {
      throw new BadRequestException('当前会话没有可探讨的任务契约。');
    }
    const brief = this.getBrief(session.id, briefId);
    if (!brief) {
      throw new BadRequestException(`Brief not found: ${briefId}`);
    }

    const allAgents = this.participatingAgents(session);
    const consultedAgent = allAgents.find((agent) => mentionedAgentIds.includes(agent.id));
    if (!consultedAgent) {
      throw new BadRequestException('被 @ 的 Agent 未参与本会话');
    }

    const userEvent = this.events.create({
      sessionId: session.id,
      type: 'user_message',
      userMessageIntent: 'clarification',
      priority: 'normal',
      content,
      toAgentIds: [consultedAgent.id],
      metadata: createMetadata('chat_message', {
        text: content,
        mentionedAgentIds: [consultedAgent.id],
        relatedBriefId: briefId
      })
    });

    this.events.create({
      sessionId: session.id,
      type: 'agent_status_changed',
      fromAgentId: consultedAgent.id,
      content: `${consultedAgent.name} 正在就当前契约回应用户探讨...`,
      metadata: createMetadata('system_notice', {
        agentId: consultedAgent.id,
        status: 'thinking',
        thoughtSummary: '契约持续探讨',
        actionSummary: '针对用户问题提供建议或澄清'
      })
    });

    const invocationId = crypto.randomUUID();
    const contextAssembly = this.createContextAssembly(
      session,
      consultedAgent,
      brief,
      undefined,
      'brief_consultation'
    );

    // 注入本轮探讨对话历史(按 relatedBriefId 过滤最近的)
    const consultationHistory = this.events
      .list(session.id)
      .filter(
        (event) =>
          event.metadata?.relatedBriefId === brief.id &&
          (event.type === 'user_message' || event.type === 'agent_message')
      )
      .slice(-8);

    for (const event of consultationHistory) {
      const speaker =
        event.type === 'user_message'
          ? '用户'
          : event.fromAgentId
            ? allAgents.find((agent) => agent.id === event.fromAgentId)?.name ?? 'Agent'
            : 'System';
      this.memories.create({
        sessionId: session.id,
        agentId: consultedAgent.id,
        scope: 'session',
        content: `${speaker}：${event.content}`,
        sourceEventId: event.id,
        confidence: 0.9
      });
    }

    const result = await this.runRuntime(session, {
      invocationId,
      sessionId: session.id,
      phase: 'brief_consultation',
      agent: consultedAgent,
      contextAssembly,
      expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' },
      budget: buildBudget(session)
    });

    const output: AgentMessageOutput =
      result.status === 'completed' && usableAgentMessageOutput(result.output)
        ? (result.output as AgentMessageOutput)
        : createAgentMessageOutput({
            messageKind: 'risk',
            content: `${consultedAgent.name} 回应失败：${result.error?.message ?? '未产出有效回复'}`
          });

    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: consultedAgent.id,
      toAgentIds: [],
      content: output.content,
      metadata: createMetadata('chat_message', {
        messageKind: output.messageKind,
        mentionedAgentIds: output.mentionedAgentIds ?? [],
        relatedBriefId: brief.id,
        runtimeInvocationId: invocationId
      })
    });

    return { userEvent, consultedAgent, output };
  }

  private async emitWorkspaceAnalyzedEvent(session: SessionDetail, coordinator: Agent) {
    if (this.artifacts.listBySession(session.id).some((artifact) => artifact.metadata?.phase === 'workspace_analysis')) {
      return;
    }
    const snapshot = session.workspaceSnapshot;
    if (!snapshot) return;
    const focus = this.projectMap.workspaceFocus(session);
    const analysis = this.workspaceAnalysis(session, snapshot, focus);
    const fileChanges = this.shouldWriteGeneratedFiles(session) ? this.workspaceAnalysisFileChanges(analysis.markdown) : [];
    const artifact = this.artifacts.create({
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
      agentId: coordinator.id,
      type: 'markdown',
      title: '工作区架构分析',
      contentSummary: analysis.summary,
      platformProjections: fileChanges,
      metadata: {
        phase: 'workspace_analysis',
        workspace: analysis.payload
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
        platformProjections: fileChanges
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
        platformProjections: fileChanges
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

  prepareExecution(
    session: SessionDetail,
    briefId: string,
    options: { eligibleAgentIds?: string[] } = {}
  ): { brief: TaskBrief; tasks: AgentTask[] } {
    const brief = this.confirmBrief(session, briefId);

    const coordinator = this.pickSessionAgent(session, ['coordinator'], 0);
    const agentIdByKey = new Map(this.participatingAgents(session).map((agent) => [agent.key, agent.id]));
    const suggestions = this.suggestedTasksByBriefId.get(brief.id) ?? this.defaultSuggestedTasks(session);
    const tasks = this.tasks.createFromSuggestions(session.id, suggestions, agentIdByKey, {
      assignedBy: { type: 'agent', id: coordinator.id },
      routingMode: 'coordinator_controlled',
      workItemId: session.activeWorkItemId
    });
    if (options.eligibleAgentIds?.length) {
      const eligibleAgentIds = Array.from(new Set(options.eligibleAgentIds));
      for (const task of tasks) {
        this.tasks.update(task, { eligibleAgentIds });
      }
    }

    for (const task of tasks) {
      this.events.create({
        sessionId: session.id,
        type: 'task_created',
        taskId: task.id,
        content: messages.taskCreated(task.title),
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          assignedBy: task.assignedBy,
          assignee: task.assignee,
          eligibleAgentIds: task.eligibleAgentIds,
          routingMode: task.routingMode,
          autoResolutionAttempted: task.autoResolutionAttempted,
          assignmentReason: task.assignmentReason,
          contextRequirements: task.contextRequirements,
          verificationPlan: task.verificationPlan,
          riskNotes: task.riskNotes,
          requiresUserConfirmation: task.requiresUserConfirmation,
          acceptanceCriteria: task.acceptanceCriteria
        })
      });
      this.events.create({
        sessionId: session.id,
        type: 'task_assigned',
        taskId: task.id,
        fromAgentId: coordinator.id,
        toAgentIds: agentIdFromActor(task.assignee) ? [agentIdFromActor(task.assignee)!] : [],
        content: `Coordinator 已分配任务：${task.title}`,
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          description: task.description,
          status: 'assigned',
          assignedBy: { type: 'agent', id: coordinator.id },
          assignee: task.assignee,
          eligibleAgentIds: task.eligibleAgentIds,
          routingMode: task.routingMode,
          autoResolutionAttempted: task.autoResolutionAttempted,
          assignmentReason: task.assignmentReason,
          contextRequirements: task.contextRequirements,
          verificationPlan: task.verificationPlan,
          riskNotes: task.riskNotes,
          requiresUserConfirmation: task.requiresUserConfirmation,
          dependsOnTaskIds: task.dependsOnTaskIds,
          acceptanceCriteria: task.acceptanceCriteria
        })
      });
    }

    return { brief, tasks };
  }

  confirmBrief(session: SessionDetail, briefId: string) {
    const brief = this.getBrief(session.id, briefId);
    if (!brief) {
      throw new Error(`Brief not found: ${briefId}`);
    }
    if (!brief.confirmedByUser) {
      brief.confirmedByUser = true;
      brief.confirmedAt = nowIso();
      this.persistBriefs();
      this.events.create({
        sessionId: session.id,
        type: 'brief_confirmed',
        content: messages.briefConfirmed,
        metadata: createMetadata('system_notice', { briefId: brief.id })
      });
    }
    return brief;
  }

  async processFileRevision(session: SessionDetail, revisionId: string): Promise<FileRevisionRun> {
    const revisions = this.requireFileRevisions();
    const coordinator = this.requireDefaultFileRevisionReceiver();
    let run: FileRevisionRun = await revisions.markProcessing(session.id, revisionId);
    const brief = this.fileRevisionBrief(session, run);

    this.events.create({
      sessionId: session.id,
      type: 'file_revision_dispatched',
      fromAgentId: coordinator.id,
      toAgentIds: run.targetAgentIds,
      content: `已将用户确认的文件修订分发给 ${run.targetAgentIds.length} 个 Agent。`,
      metadata: createMetadata('system_notice', {
        revisionId: run.id,
        filePath: run.filePath,
        targetAgentIds: run.targetAgentIds,
        diffSummary: run.diffSummary
      })
    });

    const revisionTasks = run.targetAgentIds.map((agentId) => {
      const agent = this.agents.getByIdOrKey(agentId);
      if (agent.key === 'coordinator') {
        throw new BadRequestException('The receiver cannot perform professional file-revision processing.');
      }
      return this.createFileRevisionTask(session, run, brief, coordinator, agent);
    });

    const outcomes = await Promise.allSettled(
      revisionTasks.map(async (task) => ({ task, outcome: await this.runOneTask(session, brief, task) }))
    );
    const candidates: Array<{ task: AgentTask; content: string }> = [];
    for (let index = 0; index < outcomes.length; index += 1) {
      const settled = outcomes[index]!;
      const task = revisionTasks[index]!;
      const outcome = settled.status === 'fulfilled'
        ? settled.value.outcome
        : { ok: false as const, message: settled.reason instanceof Error ? settled.reason.message : String(settled.reason) };
      const artifactIds = this.artifacts.listBySession(session.id)
        .filter((artifact) => artifact.taskId === task.id)
        .map((artifact) => artifact.id);
      const candidateContent = outcome.ok ? this.fileRevisionCandidateContent(session.id, task.id, run.filePath) : undefined;
      const result: FileRevisionAgentResult = {
        id: crypto.randomUUID(),
        taskId: task.id,
        agentId: agentIdFromActor(task.assignee) ?? run.targetAgentIds[0]!,
        status: outcome.ok && candidateContent !== undefined ? 'completed' : 'failed',
        artifactIds,
        summary: outcome.ok && candidateContent !== undefined
          ? 'Agent completed a valid file revision proposal.'
          : 'Agent did not return a valid complete file revision proposal.',
        ...(candidateContent !== undefined
          ? { proposedContentRef: revisions.storeProposedContent(candidateContent, run.filePath) }
          : {}),
        completedAt: nowIso(),
        ...(!(outcome.ok && candidateContent !== undefined)
          ? { error: 'REVISION_AGENT_PROCESSING_FAILED' }
          : {})
      };
      await revisions.recordAgentResult(session.id, run.id, result);
      this.events.create({
        sessionId: session.id,
        type: 'file_revision_agent_completed',
        taskId: task.id,
        fromAgentId: result.agentId,
        toAgentIds: [coordinator.id],
        content: result.status === 'completed'
          ? 'Agent completed a file revision proposal.'
          : 'Agent file revision processing failed.',
        metadata: createMetadata('system_notice', {
          revisionId: run.id,
          taskId: task.id,
          agentId: result.agentId,
          status: result.status,
          artifactIds
        })
      });
      if (candidateContent !== undefined) candidates.push({ task, content: candidateContent });
    }

    if (candidates.length !== revisionTasks.length) {
      throw new Error(
        `REVISION_PARTIAL_AGENT_FAILURE: ${candidates.length}/${revisionTasks.length} selected Agents returned valid complete proposals.`
      );
    }

    return this.synthesizeFileRevisionCandidate(
      session,
      brief,
      coordinator,
      run,
      revisionTasks.map((task) => task.id),
      candidates.length,
      revisionTasks.length
    );
  }

  async continueFileRevisionAfterPartialFailure(
    session: SessionDetail,
    revisionId: string
  ): Promise<FileRevisionRun> {
    const revisions = this.requireFileRevisions();
    const run = revisions.getRun(session.id, revisionId);
    if (run.status !== 'processing') {
      throw new ConflictException(
        `REVISION_STATE_CONFLICT: cannot continue Receiver synthesis while ${run.status}.`
      );
    }
    const completedResults = run.agentResults.filter((result) => result.status === 'completed');
    const failedResults = run.agentResults.filter((result) => result.status === 'failed');
    if (completedResults.length === 0 || failedResults.length === 0) {
      throw new ConflictException(
        'REVISION_STATE_CONFLICT: continuation requires both successful and failed Agent results.'
      );
    }
    const coordinator = this.requireDefaultFileRevisionReceiver();
    return this.synthesizeFileRevisionCandidate(
      session,
      this.fileRevisionBrief(session, run),
      coordinator,
      run,
      completedResults.map((result) => result.taskId),
      completedResults.length,
      run.targetAgentIds.length
    );
  }

  private async synthesizeFileRevisionCandidate(
    session: SessionDetail,
    brief: TaskBrief,
    coordinator: Agent,
    sourceRun: FileRevisionRun,
    dependsOnTaskIds: string[],
    completedAgentCount: number,
    requestedAgentCount: number
  ): Promise<FileRevisionRun> {
    const revisions = this.requireFileRevisions();
    let run: FileRevisionRun = await revisions.markSynthesizing(session.id, sourceRun.id);
    const synthesisTask = this.createFileRevisionSynthesisTask(
      session,
      run,
      coordinator,
      dependsOnTaskIds
    );
    this.events.create({
      sessionId: session.id,
      type: 'file_revision_synthesis_started',
      taskId: synthesisTask.id,
      fromAgentId: coordinator.id,
      content: 'Receiver is synthesizing the complete file revision candidate.',
      metadata: createMetadata('system_notice', {
        chainId: run.chainId,
        revisionId: run.id,
        iteration: run.iteration,
        receiverAgentId: coordinator.id,
        agentResultCount: completedAgentCount,
        failedAgentCount: run.agentResults.filter((result) => result.status === 'failed').length
      })
    });
    const synthesisStartedAt = Date.now();
    let synthesized: { invocationId: string; output: FileRevisionCandidateOutput };
    try {
      synthesized = await this.runFileRevisionSynthesis(session, brief, run, coordinator, synthesisTask);
    } finally {
      workspaceMetrics.observe(
        'file_revision_synthesis_duration_ms',
        Date.now() - synthesisStartedAt
      );
    }

    const confirmationId = crypto.randomUUID();
    run = await revisions.markAwaitingConfirmation(session.id, run.id, {
      candidateContent: synthesized.output.content,
      confirmationId,
      receiverInvocationId: synthesized.invocationId,
      synthesisTaskId: synthesisTask.id
    });
    const chain = revisions.getChain(session.id, run.chainId);
    this.events.create({
      sessionId: session.id,
      type: 'file_revision_candidate_generated',
      fromAgentId: coordinator.id,
      toAgentIds: run.targetAgentIds,
      content: '接收者已完成证据校验和候选结果封装，等待用户决定是否写回。',
      metadata: createMetadata('system_notice', {
        chainId: run.chainId,
        revisionId: run.id,
        iteration: run.iteration,
        filePath: run.filePath,
        candidateChangeSetId: run.candidateChangeSetId,
        candidateHash: run.candidateHash,
        synthesisTaskId: synthesisTask.id,
        receiverInvocationId: synthesized.invocationId,
        completedAgentCount,
        requestedAgentCount
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_requested',
      fromAgentId: coordinator.id,
      content: 'Agent 已处理用户修订，是否将候选结果写回原文件？',
      metadata: createMetadata('confirmation_card', {
        confirmationId,
        reason: 'confirm_file_revision_apply',
        title: '确认文件修订处理结果',
        description: `候选结果将使用修订快照哈希校验后写回 ${run.filePath}。`,
        revisionId: run.id,
        chainId: run.chainId,
        iteration: run.iteration,
        filePath: run.filePath,
        candidateChangeSetId: run.candidateChangeSetId,
        candidateHash: run.candidateHash,
        stateVersion: chain.stateVersion,
        options: [
          { key: 'apply_candidate', label: '确认并写回', style: 'primary' },
          { key: 'abandon_revision', label: '放弃本次修订', style: 'danger' }
        ]
      })
    });
    return run;
  }

  private fileRevisionBrief(session: SessionDetail, run: FileRevisionRun): TaskBrief {
    return this.listBriefs(session.id).filter((item) => item.confirmedByUser).at(-1) ?? {
      id: crypto.randomUUID(),
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
      version: 1,
      goal: `Process the confirmed user revision of ${run.filePath}.`,
      scope: [run.filePath],
      outOfScope: [],
      constraints: ['Treat the revised snapshot as authoritative user input.', 'Do not write the source file directly.'],
      acceptanceCriteria: [`Return one complete update proposal for ${run.filePath}.`],
      risks: ['The live file may become stale before final application.'],
      openQuestions: [],
      confirmedByUser: true,
      confirmedAt: nowIso(),
      createdAt: nowIso()
    } satisfies TaskBrief;
  }

  private createFileRevisionTask(
    session: SessionDetail,
    run: FileRevisionRun,
    _brief: TaskBrief,
    coordinator: Agent,
    agent: Agent
  ) {
    const timestamp = nowIso();
    const task: AgentTask = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
      title: `处理用户对 ${run.filePath} 的修订`,
      description: [
        `Process file revision ${run.id}.`,
        'The current userDraft is authoritative. Use the base and deterministic diff only to understand intent.',
        ...(run.instruction ? [`User processing instruction: ${run.instruction}`] : []),
        `Return a task_execution_result containing one changedArtifacts metadata.fileChanges update for exactly ${run.filePath}.`,
        'The proposal content must be the complete final UTF-8 file. Do not write the live source file directly.'
      ].join(' '),
      status: 'assigned',
      assignedBy: { type: 'agent', id: coordinator.id },
      assignee: { type: 'agent', id: agent.id },
      eligibleAgentIds: [agent.id],
      routingMode: 'coordinator_controlled',
      autoResolutionAttempted: false,
      assignmentReason: 'User explicitly selected this Agent for the confirmed file revision.',
      contextRequirements: ['Frozen base content', 'Frozen authoritative user draft', 'Deterministic line diff'],
      verificationPlan: [`Verify the proposal updates exactly ${run.filePath}.`],
      riskNotes: ['The proposal must not overwrite a newer live-file revision.'],
      requiresUserConfirmation: false,
      executionPurpose: 'file_revision',
      fileRevisionId: run.id,
      dependsOnTaskIds: [],
      acceptanceCriteria: [
        'Use the current user draft as the authoritative content.',
        `Return one complete update proposal for ${run.filePath}.`,
        'Do not perform a direct source write.'
      ],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.tasks.add(task);
    this.emitFileRevisionTaskCreated(session, task, coordinator, agent);
    return task;
  }

  private requireFileRevisions() {
    if (!this.fileRevisions) throw new Error('FILE_REVISIONS_UNAVAILABLE: file revision service is not configured.');
    return this.fileRevisions;
  }

  private createFileRevisionSynthesisTask(
    session: SessionDetail,
    run: FileRevisionRun,
    coordinator: Agent,
    dependsOnTaskIds: string[]
  ) {
    const timestamp = nowIso();
    const task: AgentTask = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
      title: `汇总 ${run.filePath} 的多 Agent 修订结果`,
      description: [
        `Synthesize the completed Agent proposals for file revision ${run.id}.`,
        'Preserve the user revised snapshot as authority, reconcile only compatible improvements, and do not invent requirements.',
        ...(run.instruction ? [`User processing instruction: ${run.instruction}`] : []),
        'Return exactly one file_revision_candidate output bound to this revision, iteration, source draft hash, and evidence hash.',
        'Do not write the live source file directly.'
      ].join(' '),
      status: 'assigned',
      assignedBy: { type: 'agent', id: coordinator.id },
      assignee: { type: 'agent', id: coordinator.id },
      eligibleAgentIds: [coordinator.id],
      routingMode: 'coordinator_controlled',
      autoResolutionAttempted: false,
      assignmentReason: 'The default Receiver is the only Agent allowed to synthesize the final revision candidate.',
      contextRequirements: ['Frozen revision evidence', 'All successful Agent proposals'],
      verificationPlan: [`Verify the synthesized proposal updates exactly ${run.filePath}.`],
      riskNotes: ['Do not silently discard explicit user changes.'],
      requiresUserConfirmation: false,
      executionPurpose: 'revision_synthesis',
      fileRevisionId: run.id,
      dependsOnTaskIds,
      acceptanceCriteria: [
        'Preserve every explicit user revision unless a documented conflict requires otherwise.',
        `Return one complete update proposal for ${run.filePath}.`
      ],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.tasks.add(task);
    this.emitFileRevisionTaskCreated(session, task, coordinator, coordinator);
    return task;
  }

  private async runFileRevisionSynthesis(
    session: SessionDetail,
    brief: TaskBrief,
    run: FileRevisionRun,
    receiver: Agent,
    task: AgentTask
  ): Promise<{ invocationId: string; output: FileRevisionCandidateOutput }> {
    this.tasks.update(task, { status: 'running' });
    const invocationId = crypto.randomUUID();
    const contextAssembly = this.createContextAssembly(session, receiver, brief, task, 'revision_synthesis');
    const evidence = this.requireFileRevisions().evidence(session.id, run.id);
    const minimumOutputTokens = estimateTokens({
      schemaVersion: '1.0',
      kind: 'file_revision_candidate',
      revisionId: run.id,
      chainId: run.chainId,
      iteration: run.iteration,
      sourceDraftHash: run.userDraftHash,
      evidenceHash: run.contextSnapshotHash,
      content: evidence.userDraft.content,
      summary: 'Complete candidate synthesis.',
      incorporatedAgentResultIds: run.agentResults.filter((item) => item.status === 'completed').map((item) => item.id),
      unresolvedConflicts: []
    }) + 256;
    if (
      contextAssembly.budget.maxOutputTokens !== undefined &&
      minimumOutputTokens > contextAssembly.budget.maxOutputTokens
    ) {
      workspaceMetrics.increment('file_revision_model_capacity_rejected_total', 1, { phase: 'revision_synthesis' });
      throw new Error(
        `REVISION_MODEL_CAPACITY_INSUFFICIENT: candidate requires at least ${minimumOutputTokens} output tokens, ` +
        `but the Receiver budget allows ${contextAssembly.budget.maxOutputTokens}.`
      );
    }
    const result = await this.runRuntime(session, {
      invocationId,
      sessionId: session.id,
      taskId: task.id,
      phase: 'revision_synthesis',
      agent: receiver,
      contextAssembly,
      expectedOutput: { kind: 'file_revision_candidate', schemaVersion: '1.0' },
      budget: contextAssembly.budget,
      writeModeOverride: 'proposal_only',
      minimumOutputTokens
    });
    if (result.status !== 'completed') {
      const message = result.error?.message ?? result.status;
      if (message.startsWith('REVISION_MODEL_CAPACITY_INSUFFICIENT:')) throw new Error(message);
      throw new Error(`REVISION_SYNTHESIS_FAILED: ${message}`);
    }
    const output = this.completedOutput<FileRevisionCandidateOutput>(result, 'file_revision_candidate');
    if (
      output.revisionId !== run.id ||
      output.chainId !== run.chainId ||
      output.iteration !== run.iteration ||
      output.sourceDraftHash.value !== run.userDraftHash.value ||
      output.sourceDraftHash.algorithm !== run.userDraftHash.algorithm ||
      output.evidenceHash !== run.contextSnapshotHash
    ) {
      throw new Error('REVISION_SYNTHESIS_FAILED: Receiver output is not bound to the frozen revision evidence.');
    }
    const resultIds = new Set(run.agentResults.filter((item) => item.status === 'completed').map((item) => item.id));
    const incorporatedIds = new Set(output.incorporatedAgentResultIds);
    if (
      incorporatedIds.size !== resultIds.size ||
      [...incorporatedIds].some((id) => !resultIds.has(id))
    ) {
      throw new Error('REVISION_SYNTHESIS_FAILED: Receiver must incorporate every completed Agent result from this revision.');
    }
    if (output.unresolvedConflicts.length > 0) {
      throw new Error('REVISION_SYNTHESIS_FAILED: Receiver reported unresolved conflicts.');
    }
    if (!evidence.complete || evidence.truncated) {
      workspaceMetrics.increment('file_revision_context_incomplete_total', 1, { phase: 'revision_synthesis' });
      throw new Error('REVISION_CONTEXT_INCOMPLETE: Receiver used incomplete revision evidence.');
    }
    this.tasks.update(task, {
      status: 'completed',
      resultSummary: 'Receiver completed the file revision candidate synthesis.'
    });
    return { invocationId, output };
  }

  private emitFileRevisionTaskCreated(session: SessionDetail, task: AgentTask, coordinator: Agent, agent: Agent) {
    this.events.create({
      sessionId: session.id,
      type: 'task_created',
      taskId: task.id,
      fromAgentId: coordinator.id,
      toAgentIds: [agent.id],
      content: messages.taskCreated(task.title),
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: task.status,
        assignedBy: task.assignedBy,
        assignee: task.assignee,
        eligibleAgentIds: task.eligibleAgentIds,
        executionPurpose: task.executionPurpose,
        fileRevisionId: task.fileRevisionId
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'task_assigned',
      taskId: task.id,
      fromAgentId: coordinator.id,
      toAgentIds: [agent.id],
      content: `接收者已分配文件修订任务：${task.title}`,
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'assigned',
        assignedBy: task.assignedBy,
        assignee: task.assignee,
        eligibleAgentIds: task.eligibleAgentIds,
        executionPurpose: task.executionPurpose,
        fileRevisionId: task.fileRevisionId
      })
    });
  }

  private fileRevisionCandidateContent(sessionId: string, taskId: string, filePath: string) {
    const normalizedTarget = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    const artifacts = this.artifacts.listBySession(sessionId).filter((artifact) => artifact.taskId === taskId);
    for (const artifact of [...artifacts].reverse()) {
      for (const proposal of [...artifact.runtimeProposals].reverse()) {
        for (const change of [...(proposal.metadata?.fileChanges ?? [])].reverse()) {
          const normalizedPath = change.path.replace(/\\/g, '/').replace(/^\.\//, '');
          if (normalizedPath === normalizedTarget && change.operation === 'update' && typeof change.content === 'string') {
            return change.content;
          }
        }
      }
      for (const change of [...(artifact.systemEvidence?.workspaceChangeSet?.changes ?? [])].reverse()) {
        const normalizedPath = 'path' in change ? change.path.replace(/\\/g, '/').replace(/^\.\//, '') : '';
        if (normalizedPath === normalizedTarget && change.operation === 'update' && typeof change.content === 'string') {
          return change.content;
        }
      }
    }
    return undefined;
  }

  async runPipeline(
    session: SessionDetail,
    brief: TaskBrief,
    tasks: AgentTask[],
    signal?: AbortSignal
  ): Promise<ExecutionOutcome> {
    while (true) {
      if (signal?.aborted) {
        return cancelledExecutionOutcome(signal);
      }

      const allTasks = this.tasks.list(session.id);
      const executableTasks = this.executionScopeTasks(tasks, allTasks);
      const remaining = executableTasks.filter((task) => !this.isTerminalTask(task));
      if (!remaining.length) {
        break;
      }

      const readyTasks = remaining.filter((task) => this.isTaskReady(task, executableTasks));
      if (!readyTasks.length) {
        // A cancelled pipeline must not report ask_user; otherwise a user
        // interrupt that just called execution.cancel + execution.start would
        // race with this branch and trap the session at WAIT_USER_DECISION.
        if (signal?.aborted) {
          return cancelledExecutionOutcome(signal);
        }
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
        return cancelledExecutionOutcome(signal);
      }
      const failedTask = taskResults.find((item) => !item.result.ok);
      if (failedTask && !failedTask.result.ok) {
        if (failedTask.result.approvalRequired) {
          return { kind: 'approval_required', reason: failedTask.result.message };
        }
        if (failedTask.result.workspaceConflict) {
          return { kind: 'workspace_conflict', reason: failedTask.result.message };
        }
        if (failedTask.result.workflowAgentSubstitution) {
          return {
            kind: 'ask_user',
            reason: `${messages.taskFailed(failedTask.task.title)}: ${failedTask.result.message}`,
            workflowAgentSubstitution: failedTask.result.workflowAgentSubstitution
          };
        }
        if (failedTask.result.workflowUpstreamIncomplete) {
          return {
            kind: 'ask_user',
            reason: `${messages.taskFailed(failedTask.task.title)}: ${failedTask.result.message}`,
            workflowUpstreamIncomplete: failedTask.result.workflowUpstreamIncomplete
          };
        }
        if (this.isInfrastructureTaskFailure(failedTask.result)) {
          return {
            kind: 'failed',
            reason: `${messages.taskFailed(failedTask.task.title)}: ${failedTask.result.message}`,
            ...(failedTask.result.error ? { error: failedTask.result.error } : {})
          };
        }
        return { kind: 'ask_user', reason: `${messages.taskFailed(failedTask.task.title)}: ${failedTask.result.message}` };
      }
      const completedWorkflowStep = taskResults.find(
        ({ task, result }) =>
          result.ok &&
          ((task.workflowNodeRunId && task.workflowRunId) ||
            (session.workflowRun?.nodeTaskIds.includes(task.id) &&
              !session.workflowRun.completedTaskIds.includes(task.id)))
      );
      if (completedWorkflowStep) {
        return {
          kind: 'workflow_step_completed',
          taskId: completedWorkflowStep.task.id,
          resultSummary: completedWorkflowStep.task.resultSummary ?? messages.taskCompleted(completedWorkflowStep.task.title)
        };
      }
    }

    if (signal?.aborted) {
      return cancelledExecutionOutcome(signal);
    }

    const limitedDelivery = this.latestLimitedDeliveryAction(session.id);
    if (!limitedDelivery) {
      let review: PostReviewReportOutput;
      try {
        review = await this.runPostReview(session, brief, signal);
      } catch (error) {
        if (signal?.aborted) {
          return cancelledExecutionOutcome(signal);
        }
        throw error;
      }
      if (review.recommendation === 'rework') {
        return { kind: 'rework', reason: review.mismatchedItems.join('; ') || messages.reviewRework };
      }
      if (review.recommendation === 'ask_user') {
        return {
          kind: 'ask_user',
          reason: review.mismatchedItems.join('; ') || review.missingItems.join('; ') || messages.reviewAskUser,
          actions: review.actions
        };
      }
    }

    const alreadyDelivered = this.events.list(session.id).some((event) => {
      if (event.type !== 'final_delivery_created') return false;
      const payload = event.metadata.payload as { relatedBriefId?: string } | undefined;
      return payload?.relatedBriefId === brief.id;
    });
    if (!alreadyDelivered) {
      try {
        await this.runFinalDelivery(session, brief, signal, limitedDelivery?.limitations);
      } catch (error) {
        if (signal?.aborted) {
          return cancelledExecutionOutcome(signal);
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
    contextRetryCount = 0,
    runtimeRetryCount = 0
  ): Promise<TaskRunOutcome> {
    const isFileRevisionTask = task.executionPurpose === 'file_revision' || task.executionPurpose === 'revision_synthesis';
    const backend = this.pickSessionAgent(session, ['backend'], 0);
    const coordinator = isFileRevisionTask
      ? this.requireDefaultFileRevisionReceiver()
      : this.pickSessionAgent(session, ['coordinator'], 0);
    if (!agentIdFromActor(task.assignee) && this.isArchitectureAnalysisTask(session, task, brief)) {
      const message = '当前架构分析任务需要架构师执行，但本会话未选择架构师。请添加或选择架构师后继续。';
      this.tasks.update(task, { status: 'waiting', resultSummary: message });
      this.events.create({
        sessionId: session.id,
        type: 'task_waiting',
        taskId: task.id,
        fromAgentId: coordinator.id,
        content: message,
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          status: 'waiting',
          resultSummary: message,
          requiresUserConfirmation: true
        })
      });
      return { ok: false, message };
    }
    const taskAssigneeId = agentIdFromActor(task.assignee);
    const taskAgent = taskAssigneeId ? this.agents.getByIdOrKey(taskAssigneeId) : backend;
    const claim = await this.resolveTaskClaim(
      session,
      brief,
      task,
      taskAgent,
      coordinator,
      signal,
      attemptedAgentIds,
      contextRetryCount
    );
    if (!claim.ok) {
      return {
        ok: false,
        message: claim.message,
        error: claim.error,
        code: claim.error?.code,
        retryable: claim.error?.retryable,
        workflowAgentSubstitution: claim.workflowAgentSubstitution
      };
    }
    if (claim.agent.id !== taskAgent.id) {
      return this.runOneTask(session, brief, task, signal, attemptedAgentIds, contextRetryCount, runtimeRetryCount);
    }
    this.tasks.update(task, { status: 'accepted' });
    this.events.create({
      sessionId: session.id,
      type: 'task_accepted',
      taskId: task.id,
      fromAgentId: taskAgent.id,
      toAgentIds: [coordinator.id],
      content: `${taskAgent.name} 已接受任务：${task.title}`,
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'accepted',
        assignedBy: task.assignedBy,
        assignee: { type: 'agent', id: taskAgent.id },
        ...(isFileRevisionTask
          ? { executionPurpose: task.executionPurpose, fileRevisionId: task.fileRevisionId }
          : {
              routingMode: task.routingMode,
              autoResolutionAttempted: task.autoResolutionAttempted,
              assignmentReason: task.assignmentReason,
              contextRequirements: task.contextRequirements,
              verificationPlan: task.verificationPlan,
              riskNotes: task.riskNotes,
              requiresUserConfirmation: task.requiresUserConfirmation,
              dependsOnTaskIds: task.dependsOnTaskIds,
              acceptanceCriteria: task.acceptanceCriteria
            })
      })
    });
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
        assignedBy: task.assignedBy,
        assignee: { type: 'agent', id: taskAgent.id },
        ...(isFileRevisionTask
          ? { executionPurpose: task.executionPurpose, fileRevisionId: task.fileRevisionId }
          : {
              routingMode: task.routingMode,
              autoResolutionAttempted: task.autoResolutionAttempted,
              assignmentReason: task.assignmentReason,
              contextRequirements: task.contextRequirements,
              verificationPlan: task.verificationPlan,
              riskNotes: task.riskNotes,
              requiresUserConfirmation: task.requiresUserConfirmation,
              dependsOnTaskIds: task.dependsOnTaskIds,
              acceptanceCriteria: task.acceptanceCriteria
            })
      })
    });
    if (!isFileRevisionTask) this.events.create({
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
        acceptanceDecision: claim.decision,
        runtimeInvocationId: claim.invocationId
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
        assignee: task.assignee
      })
    });

    const invocationId = crypto.randomUUID();
    if (this.isArchitectureAnalysisTask(session, task, brief)) {
      await this.preloadArchitectureTaskContext(session, task, taskAgent.id);
    }
    const contextAssembly = this.createContextAssembly(session, taskAgent, brief, task, 'task_execution');
    if (!isFileRevisionTask) {
      this.emitMemoryUsedEvent(session.id, task.id, taskAgent.id, contextAssembly);
    }

    const result = await this.runRuntime(session, {
      invocationId: invocationId,
      sessionId: session.id,
      taskId: task.id,
      phase: 'task_execution',
      ...(this.runtime.operations ? { operation: await this.taskExecutionOperation(session, task, invocationId) } : {}),
      agent: taskAgent,
      contextAssembly,
      expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' },
      budget: contextAssembly.budget,
      ...(isFileRevisionTask ? { writeModeOverride: 'proposal_only' as const } : {})
    }, signal);
    const executionRuntimeType = result.runtimeType;
    if (result.executionCandidate) this.tasks.update(task, { executionCheckpoint: {
      operationId: task.executionOperationId, invocationId: result.invocationId,
      candidateId: result.executionCandidate.id, candidateHash: result.executionCandidate.manifestHash,
      stage: result.executionCandidate.stage } });

    if (signal?.aborted) {
      const message = messages.cancelled;
      this.markTaskCancelled(session.id, task, taskAgent.id, invocationId, message, executionRuntimeType);
      return { ok: false, message };
    }

    if (result.status !== 'completed') {
      const message = result.error?.message ?? result.status;
      const requestedContext = result.error?.requestedContext;
      const code = result.error?.code;
      const publicMessage = isFileRevisionTask
        ? this.fileRevisionRuntimeFailureMessage(code)
        : message;
      if (result.status === 'pending_approval' || code === 'HUMAN_APPROVAL_REQUIRED') {
        this.tasks.update(task, { status: 'waiting', resultSummary: publicMessage });
        this.events.create({
          sessionId: session.id,
          type: 'task_waiting',
          taskId: task.id,
          fromAgentId: taskAgent.id,
          content: `任务等待用户授权：${task.title}`,
          metadata: createMetadata('task_card', {
            taskId: task.id,
            title: task.title,
            status: 'waiting',
            resultSummary: publicMessage,
            reason: 'capability_approval_required'
          })
        });
        return {
          ok: false,
          message: publicMessage,
          approvalRequired: true,
          code: 'HUMAN_APPROVAL_REQUIRED',
          retryable: true,
          error: result.error
        };
      }
      if (this.canRetryRuntimeTimeout(result.error, runtimeRetryCount)) {
        this.recordRuntimeTimeoutRetry(session, task, taskAgent.id, invocationId, publicMessage, runtimeRetryCount + 1);
        this.tasks.update(task, { status: 'pending', resultSummary: `Retrying after runtime timeout: ${publicMessage}` });
        await this.backoffRuntimeRetry(runtimeRetryCount, signal);
        return this.runOneTask(
          session,
          brief,
          task,
          signal,
          new Set<string>(),
          contextRetryCount,
          runtimeRetryCount + 1
        );
      }
      this.markTaskFailed(
        session.id,
        task,
        taskAgent.id,
        invocationId,
        publicMessage,
        executionRuntimeType,
        code,
        isFileRevisionTask ? undefined : requestedContext,
        isFileRevisionTask ? undefined : result.error?.details,
        result.error?.retryable ?? false
      );
      if (!isFileRevisionTask && this.canRetryWithSupplementalContext(code, requestedContext, contextRetryCount)) {
        const novelContext = this.resolveRetryRequest(session, code, requestedContext, contextRetryCount);
        if (novelContext) {
          const resolution = await this.hydrateSupplementalContext(session, novelContext, { workItemId: task.workItemId ?? session.activeWorkItemId });
          this.recordSupplementalContextRequest(session, task, taskAgent.id, novelContext, resolution);
          if (this.hasUsableSupplementalContext(session, novelContext, resolution)) {
            this.tasks.update(task, { status: 'pending', resultSummary: `Retrying with supplemental context: ${message}` });
            return this.runOneTask(session, brief, task, signal, new Set<string>(), contextRetryCount + 1, 0);
          }
        } else {
          this.emitSupplementalContextRejected(session, task, taskAgent.id, requestedContext, 'duplicate_request');
        }
      }
      return { ok: false, message, code, retryable: result.error?.retryable, error: result.error };
    }

    const output = this.completedOutput<TaskExecutionResultOutput>(result, 'task_execution_result');
    const knowledgeQuery = this.taskKnowledgeQuery(session, brief, task);
    if (!isFileRevisionTask) this.events.create({
      sessionId: session.id,
      type: 'rag_retrieved',
      taskId: task.id,
      fromAgentId: taskAgent.id,
      content: messages.ragRetrieved,
      metadata: createMetadata('rag_card', {
        retrievalLogId: crypto.randomUUID(),
        agentId: taskAgent.id,
        query: knowledgeQuery,
        matchedChunks: this.searchAgentKnowledge(session, taskAgent, knowledgeQuery)
      })
    });

    // needs_review 是合法的"完成但需复盘重点检查"，不能走失败分支：
    // blocked 则始终表示尚未完成；requestedContext 只决定能否自动补读重试。
    const needsReview = output.status === 'needs_review';
    if (output.status !== 'completed' && !needsReview) {
      const code = output.status === 'blocked' ? 'CONTEXT_INSUFFICIENT' : 'MODEL_ERROR';
      const requestedContext = this.runtimeOutputContextRequest(output.requestedContext);
      const publicMessage = isFileRevisionTask
        ? this.fileRevisionRuntimeFailureMessage(code)
        : output.summary;
      this.markTaskFailed(
        session.id,
        task,
        taskAgent.id,
        invocationId,
        publicMessage,
        executionRuntimeType,
        code,
        isFileRevisionTask ? undefined : requestedContext
      );
      if (!isFileRevisionTask && this.canRetryWithSupplementalContext(code, requestedContext, contextRetryCount)) {
        const novelContext = this.resolveRetryRequest(session, code, requestedContext, contextRetryCount);
        if (novelContext) {
          const resolution = await this.hydrateSupplementalContext(session, novelContext, { workItemId: task.workItemId ?? session.activeWorkItemId });
          this.recordSupplementalContextRequest(session, task, taskAgent.id, novelContext, resolution);
          if (this.hasUsableSupplementalContext(session, novelContext, resolution)) {
            this.tasks.update(task, { status: 'pending', resultSummary: `Retrying with supplemental context: ${output.summary}` });
            return this.runOneTask(session, brief, task, signal, new Set<string>(), contextRetryCount + 1, 0);
          }
        } else {
          this.emitSupplementalContextRejected(session, task, taskAgent.id, requestedContext, 'duplicate_request');
        }
      }
      // A workflow Agent node that executed and then reported blocked has read its
      // inputs and found them insufficient. That is the downstream node detecting
      // that an earlier stage did not actually finish, so it is offered an
      // upstream re-run instead of a generic "confirm next step" card. Auto
      // supplemental-context recovery above has already been exhausted.
      if (
        output.status === 'blocked' &&
        !isFileRevisionTask &&
        task.workflowRunId &&
        task.workflowNodeType === 'agent'
      ) {
        return {
          ok: false,
          message: output.summary,
          code,
          retryable: false,
          workflowUpstreamIncomplete: {
            taskId: task.id,
            workflowRunId: task.workflowRunId,
            ...(task.workflowNodeId ? { workflowNodeId: task.workflowNodeId } : {}),
            reason: output.summary,
            missingInputs: this.upstreamMissingInputs(task, requestedContext)
          }
        };
      }
      return { ok: false, message: output.summary, code, retryable: false };
    }

    if (
      !isFileRevisionTask &&
      result.workspaceExecution &&
      !result.workspaceExecution.requiresUserConfirmation &&
      this.workspaceWritebacks
    ) {
      session.status = 'APPLYING_CHANGES';
      this.persistSessionState(session);
      let writeback;
      try {
        writeback = await this.workspaceWritebacks.enqueue({
          session,
          taskId: task.id,
          invocationId,
          execution: result.workspaceExecution,
          resultSummary: output.summary
        });
      } finally {
        this.worktreeExecution?.releaseWriteLease(result.workspaceExecution.changeSet.id);
      }
      result.workspaceExecution.writeback = writeback;
      if (writeback.status === 'applied') this.tasks.update(task, { executionCheckpoint: {
        ...task.executionCheckpoint, operationId: task.executionOperationId, invocationId: result.invocationId,
        stage: 'writeback_confirmed', writebackId: writeback.id } });
      session.workspaceWritebacks = this.workspaceWritebacks.list(session.id);
      const hasBlockingWriteback = session.workspaceWritebacks.some(
        (item) => item.status === 'conflicted' || item.status === 'failed'
      );
      if (writeback.status === 'conflicted' || writeback.status === 'failed') {
        const message = writeback.status === 'conflicted'
          ? `Workspace writeback needs conflict resolution (${writeback.conflicts.length} conflict(s)).`
          : `Workspace writeback failed: ${writeback.error ?? 'unknown error'}`;
        session.status = 'WAIT_WORKSPACE_CONFLICT_RESOLUTION';
        this.persistSessionState(session);
        this.tasks.update(task, { status: 'waiting', resultSummary: message });
        this.events.create({
          sessionId: session.id,
          type: 'task_waiting',
          taskId: task.id,
          fromAgentId: taskAgent.id,
          content: message,
          metadata: createMetadata('task_card', {
            taskId: task.id,
            title: task.title,
            status: 'waiting',
            workspaceWriteback: writeback,
            requiresUserConfirmation: true
          })
        });
        return { ok: false, message, workspaceConflict: true };
      }
      session.status = hasBlockingWriteback
        ? 'WAIT_WORKSPACE_CONFLICT_RESOLUTION'
        : session.workspaceWritebacks.some((item) => ['queued', 'merging', 'applying'].includes(item.status))
          ? 'APPLYING_CHANGES'
          : 'EXECUTING';
      this.persistSessionState(session);
    }

    const publicResultSummary = isFileRevisionTask
      ? 'Agent completed a proposal for the file revision.'
      : output.summary;
    this.tasks.update(task, { status: 'completed', resultSummary: publicResultSummary });
    const allowGeneratedFileWrites = isFileRevisionTask || this.shouldWriteGeneratedFiles(session, brief);
    const executionArtifact = this.createExecutionArtifact(
      session.id,
      task,
      taskAgent.id,
      output,
      result.systemEvidence,
      allowGeneratedFileWrites,
      result.workspaceExecution
    );
    const fileChanges = this.platformFileChangesForArtifact(executionArtifact);
    this.events.create({
      sessionId: session.id,
      type: 'artifact_created',
      taskId: task.id,
      fromAgentId: taskAgent.id,
      content: messages.artifactCreated(executionArtifact.title),
      metadata: createMetadata(
        'artifact_card',
        artifactCreatedEventPayload(executionArtifact, result.workspaceExecution, isFileRevisionTask)
      )
    });
    if (!isFileRevisionTask) {
      this.emitRuntimeAgentMessages(session, task, taskAgent, output.agentMessages ?? [], invocationId);
    }
    this.events.create({
      sessionId: session.id,
      workItemId: task.workItemId,
      type: 'runtime_completed',
      taskId: task.id,
      fromAgentId: taskAgent.id,
      content: messages.runtimeCompleted(taskAgent.name, runtimeModeLabel(executionRuntimeType)),
      metadata: createMetadata('system_notice', {
        runtimeInvocationId: invocationId,
        runtimeType: executionRuntimeType,
        status: 'completed',
        usage: result.usage
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'task_completed',
      taskId: task.id,
      fromAgentId: taskAgent.id,
      content: isFileRevisionTask
        ? messages.taskCompleted(task.title)
        : needsReview
          ? messages.taskCompletedNeedsReview(task.title)
          : messages.taskCompleted(task.title),
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'completed',
        needsReview: isFileRevisionTask ? false : needsReview,
        ...(isFileRevisionTask
          ? { executionPurpose: task.executionPurpose, fileRevisionId: task.fileRevisionId }
          : {
              resultSummary: output.summary,
              completedItems: output.completedItems,
              risks: output.risks
            })
      })
    });
    if (needsReview && !isFileRevisionTask) {
      const reviewer = this.pickSessionAgent(session, ['review', 'test'], 1);
      const reviewNoticeTargets = [...new Set([reviewer.id, coordinator.id])];
      this.events.create({
        sessionId: session.id,
        type: 'agent_message',
        taskId: task.id,
        fromAgentId: taskAgent.id,
        toAgentIds: reviewNoticeTargets,
        content: messages.taskNeedsReviewNotice(taskAgent.name, task.title, output.summary),
        metadata: createMetadata('chat_message', {
          messageKind: 'risk',
          phase: 'task_execution',
          relatedTaskIds: [task.id],
          mentionedAgentIds: reviewNoticeTargets,
          risks: output.risks,
          runtimeInvocationId: invocationId
        })
      });
    }
    if (!isFileRevisionTask) {
      this.emitTaskHandoff(session, task, taskAgent, output.summary);
      this.createSummaryMemoryCheckpoint(session, taskAgent, 'task_execution', brief, task);
    }
    if (!isFileRevisionTask) {
      await this.applyServerLocalArtifactChanges(session, fileChanges, {
        allowSourceFileChanges:
          !result.workspaceExecution &&
          allowGeneratedFileWrites &&
          this.canApplySourceFileChanges(taskAgent, executionRuntimeType)
      });
    }
    return { ok: true };
  }

  private async resolveTaskClaim(
    session: SessionDetail,
    brief: TaskBrief,
    task: AgentTask,
    candidate: Agent,
    coordinator: Agent,
    signal: AbortSignal | undefined,
    attemptedAgentIds: Set<string>,
    contextRetryCount = 0
  ): Promise<
    | { ok: true; agent: Agent; decision: TaskAcceptanceDecisionOutput; invocationId: string }
    | {
        ok: false;
        message: string;
        error?: RuntimeError;
        workflowAgentSubstitution?: WorkflowAgentSubstitutionRequest;
      }
  > {
    if (attemptedAgentIds.has(candidate.id) && contextRetryCount === 0) {
      return {
        ok: false,
        message: `Task acceptance was already attempted for ${candidate.name}; refusing an implicit acceptance fallback.`
      };
    }
    if (contextRetryCount === 0) {
      attemptedAgentIds.add(candidate.id);
    }
    const invocationId = crypto.randomUUID();
    const assembled = this.createContextAssembly(session, candidate, brief, task, 'task_acceptance');
    const contextAssembly = { ...assembled, systemRules: [...assembled.systemRules ?? [],
      'Make only a concise acceptance decision for the assigned responsibility and supplied evidence. Do not implement or test the task.'],
      budget: { ...assembled.budget, maxOutputTokens: Math.min(assembled.budget?.maxOutputTokens ?? 800, 800) } };
    const isFileRevisionTask = task.executionPurpose === 'file_revision' || task.executionPurpose === 'revision_synthesis';
    let inputFingerprint: string | undefined;
    if (this.invocationResolver && candidate.status === 'active') {
      try {
        const plan = this.invocationResolver.resolve({ invocationId, sessionId: session.id, taskId: task.id,
          taskKind: contextAssembly.taskContext.intent, phase: 'task_execution', agent: candidate,
          taskRequiresCodeChanges: contextAssembly.taskContext.requiresCodeChanges,
          workspace: this.invocationWorkspace(session),
          sessionPreference: this.runtimePreferenceForAgent(candidate, session.runtimePreference),
          projectPolicyRuntime: projectPolicyRuntimeType(), globalDefaultRuntime: globalDefaultRuntimeType(),
          smartRouterPick: smartRuntimePick({ phase: 'task_execution', requiresCodeChanges: contextAssembly.taskContext.requiresCodeChanges }),
          contextEnvelopeFactory: ({ identity, toolCatalog }) => buildEnvelopeFromContextAssembly({ session,
            phase: 'task_execution', contextAssembly, identity, toolCatalogHash: toolCatalog.catalogHash }),
          expectedOutput: { kind: 'task_execution_result', schemaVersion: '1.0' }, budget: contextAssembly.budget,
          ...(isFileRevisionTask ? { writeModeOverride: 'proposal_only' as const } : {}) });
        inputFingerprint = acceptanceFingerprint(task, plan, this.taskDependencyArtifacts(session, task));
        const checkpoint = task.acceptanceCheckpoint;
        if (!plan.pendingApprovals?.length && checkpoint?.inputFingerprint === inputFingerprint &&
          checkpoint.agentId === candidate.id && checkpoint.decision.status === 'accepted') {
          return { ok: true, agent: candidate, decision: checkpoint.decision, invocationId: checkpoint.invocationId };
        }
        const grounded = evaluateGroundedEvidenceGate({ envelope: plan.contextEnvelope,
          requiresEvidence: session.workspaceMode !== 'bootstrap' && requiresGroundedRuntimeEvidence('task_execution',
            contextAssembly.taskContext.requiresCodeChanges, contextAssembly.taskContext.evidenceSelection.strategy) });
        const dependenciesReady = task.dependsOnTaskIds.every(id => this.tasks.find(session.id, id)?.status === 'completed');
        const decision = grounded.ok && !isFileRevisionTask && checkpoint?.decision.status !== 'blocked' && checkpoint?.decision.status !== 'rejected'
          ? explicitTaskPreflight(task, plan, dependenciesReady) : undefined;
        if (decision) {
          this.tasks.update(task, { acceptanceCheckpoint: { inputFingerprint, agentId: candidate.id,
            decisionSource: 'rule', decision, invocationId, createdAt: nowIso() } });
          this.emitTaskAcceptanceDecisionEvent(session, task, candidate, coordinator, decision, invocationId, plan.executionTarget.runtimeType);
          return { ok: true, agent: candidate, decision, invocationId };
        }
      } catch (error) {
        if (error instanceof InvocationResolutionError) return { ok: false, message: error.message,
          error: { code: 'CAPABILITY_BLOCKED', message: error.message, retryable: false } };
        throw error;
      }
    }
    const result = await this.runRuntime(
      session,
      {
        invocationId: invocationId,
        sessionId: session.id,
        taskId: task.id,
        phase: 'task_acceptance',
        agent: candidate,
        contextAssembly,
        expectedOutput: { kind: 'task_acceptance_decision', schemaVersion: '1.0' },
        budget: contextAssembly.budget,
        ...(isFileRevisionTask ? { writeModeOverride: 'proposal_only' as const } : {})
      },
      signal
    );
    if (signal?.aborted) {
      return { ok: false, message: messages.cancelled };
    }
    if (result.status !== 'completed') {
      const message = result.error?.message ?? `Task acceptance Runtime ended with status ${result.status}.`;
      const runtimeError: RuntimeError = result.error ?? {
        code: 'UNKNOWN_ERROR',
        message,
        retryable: false,
        details: { phase: 'task_acceptance', status: result.status }
      };
      if (
        !isFileRevisionTask &&
        this.canRetryWithSupplementalContext(runtimeError.code, runtimeError.requestedContext, contextRetryCount)
      ) {
        const novelContext = this.resolveRetryRequest(
          session,
          runtimeError.code,
          runtimeError.requestedContext,
          contextRetryCount
        );
        if (novelContext) {
          const resolution = await this.hydrateSupplementalContext(session, novelContext, {
            workItemId: task.workItemId ?? session.activeWorkItemId
          });
          this.recordSupplementalContextRequest(session, task, candidate.id, novelContext, resolution);
          if (this.hasUsableSupplementalContext(session, novelContext, resolution)) {
            this.tasks.update(task, {
              status: 'assigned',
              resultSummary: `Retrying ${candidate.name} acceptance with supplemental context.`
            });
            return this.resolveTaskClaim(
              session,
              brief,
              task,
              candidate,
              coordinator,
              signal,
              attemptedAgentIds,
              contextRetryCount + 1
            );
          }
        }
      }
      const publicMessage = isFileRevisionTask
        ? 'File revision task acceptance failed.'
        : message;
      const publicError: RuntimeError = isFileRevisionTask
        ? {
            code: runtimeError.code,
            message: publicMessage,
            retryable: runtimeError.retryable
          }
        : runtimeError;
      this.markTaskFailed(
        session.id,
        task,
        candidate.id,
        invocationId,
        publicMessage,
        result.runtimeType,
        runtimeError.code,
        isFileRevisionTask ? undefined : runtimeError.requestedContext,
        isFileRevisionTask ? undefined : runtimeError.details,
        runtimeError.retryable
      );
      return {
        ok: false,
        message: publicMessage,
        error: publicError
      };
    }
    const decision = this.completedOutput<TaskAcceptanceDecisionOutput>(
      result,
      'task_acceptance_decision'
    );
    if (inputFingerprint) this.tasks.update(task, { acceptanceCheckpoint: { inputFingerprint,
      agentId: candidate.id, decisionSource: 'model', decision, invocationId, createdAt: nowIso() } });

    if (!isFileRevisionTask) {
      this.emitTaskAcceptanceDecisionEvent(session, task, candidate, coordinator, decision, invocationId, result.runtimeType);
      this.emitRuntimeAgentMessages(session, task, candidate, decision.agentMessages, invocationId);
    }

    if (decision.status === 'accepted') {
      return { ok: true, agent: candidate, decision, invocationId };
    }

    const isArchitectureTask = this.isArchitectureAnalysisTask(session, task, brief);
    const requestedContext = this.acceptanceDecisionRequestedContext(session, task, decision, isArchitectureTask);
    const isWorkflowTask = Boolean(task.workflowRunId && task.workflowNodeRunId);
    if ((isArchitectureTask || isWorkflowTask) && requestedContext) {
      if (this.canRetryWithSupplementalContext('CONTEXT_INSUFFICIENT', requestedContext, contextRetryCount)) {
        const novelContext = this.resolveRetryRequest(session, 'CONTEXT_INSUFFICIENT', requestedContext, contextRetryCount);
        if (novelContext) {
          const resolution = await this.hydrateSupplementalContext(session, novelContext, { workItemId: task.workItemId ?? session.activeWorkItemId });
          this.recordSupplementalContextRequest(session, task, candidate.id, novelContext, resolution);
          if (this.hasUsableSupplementalContext(session, novelContext, resolution)) {
            this.tasks.update(task, {
              status: 'assigned',
              resultSummary: `Retrying architect acceptance with supplemental context: ${decision.reason}`
            });
            return this.resolveTaskClaim(
              session,
              brief,
              task,
              candidate,
              coordinator,
              signal,
              attemptedAgentIds,
              contextRetryCount + 1
            );
          }
        } else {
          this.emitSupplementalContextRejected(session, task, candidate.id, requestedContext, 'duplicate_request');
        }
      }
    }

    const hasUsableUpstreamArtifacts = this.taskDependencyArtifacts(session, task).length > 0;
    const canAutoResolve =
      !isFileRevisionTask &&
      !isWorkflowTask &&
      task.autoResolutionAttempted !== true &&
      (session.workspaceMode !== 'bootstrap' || hasUsableUpstreamArtifacts);
    const alternative = canAutoResolve ? this.findAlternativeClaimAgent(session, task, decision, attemptedAgentIds) : undefined;
    const blockedSummary = isFileRevisionTask
      ? 'File revision task acceptance was blocked.'
      : decision.reason;
    this.tasks.update(task, {
      status: 'blocked',
      autoResolutionAttempted: canAutoResolve ? true : task.autoResolutionAttempted,
      resultSummary: blockedSummary
    });
    this.emitTaskBlockedEvent(session, task, candidate, coordinator, decision);

    if (!alternative) {
      return {
        ok: false,
        message: blockedSummary,
        ...(isWorkflowTask && task.workflowRunId
          ? {
              workflowAgentSubstitution: {
                taskId: task.id,
                workflowRunId: task.workflowRunId,
                workflowNodeId: task.workflowNodeId,
                currentAgentId: candidate.id,
                candidates: this.workflowSubstitutionCandidates(session, attemptedAgentIds)
              }
            }
          : {})
      };
    }

    this.tasks.update(task, {
      status: 'assigned',
      assignee: { type: 'agent', id: alternative.id },
      resultSummary: `${candidate.name} cannot accept; receiver reassigned to ${alternative.name}. ${decision.reason}`
    });
    this.events.create({
      sessionId: session.id,
      type: 'task_reassigned',
      taskId: task.id,
      fromAgentId: coordinator.id,
      toAgentIds: [alternative.id, coordinator.id],
      content: `接收者自动改派任务：${task.title} -> ${alternative.name}`,
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'assigned',
        assignedBy: { type: 'agent', id: coordinator.id },
        assignee: { type: 'agent', id: alternative.id },
        eligibleAgentIds: task.eligibleAgentIds,
        routingMode: task.routingMode,
        autoResolutionAttempted: task.autoResolutionAttempted,
        assignmentReason: task.assignmentReason,
        contextRequirements: task.contextRequirements,
        verificationPlan: task.verificationPlan,
        riskNotes: task.riskNotes,
        requiresUserConfirmation: task.requiresUserConfirmation,
        previousAssignee: { type: 'agent', id: candidate.id },
        resultSummary: decision.reason,
        handoffSuggestion: decision.handoffSuggestion
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'task_assigned',
      taskId: task.id,
      fromAgentId: coordinator.id,
      toAgentIds: [alternative.id],
      content: `接收者已分配任务：${task.title}`,
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'assigned',
        assignedBy: { type: 'agent', id: coordinator.id },
        assignee: { type: 'agent', id: alternative.id },
        ...(isFileRevisionTask
          ? { executionPurpose: task.executionPurpose, fileRevisionId: task.fileRevisionId }
          : {
              description: task.description,
              eligibleAgentIds: task.eligibleAgentIds,
              routingMode: task.routingMode,
              autoResolutionAttempted: task.autoResolutionAttempted,
              assignmentReason: task.assignmentReason,
              contextRequirements: task.contextRequirements,
              verificationPlan: task.verificationPlan,
              riskNotes: task.riskNotes,
              requiresUserConfirmation: task.requiresUserConfirmation,
              dependsOnTaskIds: task.dependsOnTaskIds,
              acceptanceCriteria: task.acceptanceCriteria
            })
      })
    });
    return { ok: true, agent: alternative, decision, invocationId };
  }

  private emitTaskAcceptanceDecisionEvent(
    session: SessionDetail,
    task: AgentTask,
    candidate: Agent,
    coordinator: Agent,
    decision: TaskAcceptanceDecisionOutput,
    invocationId: string,
    runtimeType: RuntimeType
  ) {
    if (task.executionPurpose === 'file_revision' || task.executionPurpose === 'revision_synthesis') {
      return;
    }
    const alternativeAgentIds = this.acceptanceDecisionAlternativeIds(session, decision);
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      taskId: task.id,
      fromAgentId: candidate.id,
      toAgentIds: Array.from(new Set([coordinator.id, ...alternativeAgentIds])),
      content: decision.reason,
      metadata: createMetadata('chat_message', {
        messageKind: decision.status === 'accepted' ? 'decision' : 'handoff',
        phase: decision.status === 'accepted' ? 'task_acceptance_decision' : 'task_acceptance_blocked',
        relatedTaskIds: [task.id],
        mentionedAgentIds: alternativeAgentIds.length ? alternativeAgentIds : [coordinator.id],
        acceptanceDecision: decision,
        decisionSource: task.acceptanceCheckpoint?.decisionSource ?? 'model',
        handoffSuggestion: decision.handoffSuggestion,
        runtimeInvocationId: invocationId,
        runtimeType
      })
    });
  }

  private emitTaskBlockedEvent(
    session: SessionDetail,
    task: AgentTask,
    candidate: Agent,
    coordinator: Agent,
    decision: TaskAcceptanceDecisionOutput
  ) {
    const isFileRevisionTask = task.executionPurpose === 'file_revision' || task.executionPurpose === 'revision_synthesis';
    this.events.create({
      sessionId: session.id,
      type: decision.status === 'rejected' ? 'task_rejected' : 'task_blocked',
      taskId: task.id,
      fromAgentId: candidate.id,
      toAgentIds: [coordinator.id],
      content: decision.status === 'rejected'
        ? `${candidate.name} 拒绝接单：${task.title}`
        : `${candidate.name} 暂时无法接单：${task.title}`,
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: 'blocked',
        assignedBy: task.assignedBy,
        assignee: { type: 'agent', id: candidate.id },
        ...(isFileRevisionTask
          ? {
              executionPurpose: task.executionPurpose,
              fileRevisionId: task.fileRevisionId,
              resultSummary: 'File revision task acceptance was blocked.'
            }
          : {
              description: task.description,
              routingMode: task.routingMode,
              autoResolutionAttempted: task.autoResolutionAttempted,
              assignmentReason: task.assignmentReason,
              contextRequirements: task.contextRequirements,
              verificationPlan: task.verificationPlan,
              riskNotes: task.riskNotes,
              requiresUserConfirmation: task.requiresUserConfirmation,
              resultSummary: decision.reason,
              missingContext: decision.missingContext,
              requestedContext: decision.requestedContext,
              handoffSuggestion: decision.handoffSuggestion
            })
      })
    });
  }

  private acceptanceDecisionRequestedContext(
    session: SessionDetail,
    task: AgentTask,
    decision: TaskAcceptanceDecisionOutput,
    isArchitectureTask: boolean
  ): RuntimeContextRequest | undefined {
    if (decision.requestedContext) {
      return this.runtimeOutputContextRequest(decision.requestedContext);
    }
    if (!isArchitectureTask || !decision.missingContext?.length) {
      return undefined;
    }
    const requestedPaths = this.architectureSupplementalContextPaths(session, decision.missingContext);
    if (!requestedPaths.length) {
      return undefined;
    }
    return {
      reason: decision.reason,
      requestedRefs: [],
      requestedFiles: requestedPaths.map((path) => ({ path })),
      followUpInstruction: `Retry architecture task "${task.title}" after reading the requested entrypoint, config, module boundary, and runtime files.`
    };
  }

  private runtimeOutputContextRequest(
    value: TaskExecutionResultOutput['requestedContext'] | TaskAcceptanceDecisionOutput['requestedContext']
  ): RuntimeContextRequest | undefined {
    if (!value) return undefined;
    return {
      reason: value.reason,
      requestedRefs: value.requestedRefs.map((ref) => ({
        type: ref.type,
        label: ref.label,
        ...(ref.ref === null ? {} : { ref: ref.ref }),
        ...(ref.estimatedTokens === null ? {} : { estimatedTokens: ref.estimatedTokens }),
        ...(ref.selectionReason === null ? {} : { selectionReason: ref.selectionReason }),
        ...(ref.omissionReason === null ? {} : { omissionReason: ref.omissionReason })
      })),
      requestedFiles: value.requestedPaths.map((path) => ({ path })),
      requestedDirectories: value.requestedDirectories?.map((item) => ({
        path: item.path,
        ...(item.depth === null ? {} : { depth: item.depth })
      })),
      requestedSearches: value.requestedSearches?.map((item) => ({
        query: item.query,
        ...(item.path === null ? {} : { path: item.path }),
        ...(item.include === null ? {} : { include: item.include }),
        ...(item.exclude === null ? {} : { exclude: item.exclude })
      })),
      requestedCommands: value.requestedCommands,
      ...(value.followUpInstruction === null ? {} : { followUpInstruction: value.followUpInstruction })
    };
  }

  private architectureSupplementalContextPaths(session: SessionDetail, missingContext: string[]) {
    const availablePaths = new Set(this.workspaceNavigationFilePaths(session));
    if (!availablePaths.size) return [];
    const mentionedPaths = missingContext
      .flatMap((item) => item.match(/[A-Za-z0-9_.@/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|json|md|yml|yaml|toml|css|scss)/g) ?? [])
      .map((path) => path.replace(/\\/g, '/'))
      .filter((path) => availablePaths.has(path));
    return this.uniqueFirstStrings([...mentionedPaths, ...this.defaultArchitectureContextPaths(session)], 16);
  }

  private defaultArchitectureContextPaths(session: SessionDetail) {
    return this.workspaceNavigationFilePaths(session)
      .map((path) => ({ path, score: this.architectureContextPathScore(path) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .map((item) => item.path)
      .slice(0, 16);
  }

  private async preloadArchitectureTaskContext(session: SessionDetail, task: AgentTask, agentId: string) {
    const revisionId = session.workspaceIndex?.revision.id ?? session.workspaceContext?.indexRevision?.id;
    const hydrated = new Set(
      (session.workspaceSnapshot?.files ?? [])
        .filter((file) => file.content !== undefined && (!revisionId || file.revision?.id === revisionId))
        .map((file) => file.path)
    );
    const requestedPaths = this.defaultArchitectureContextPaths(session)
      .filter((path) => !hydrated.has(path))
      .slice(0, 8);
    if (!requestedPaths.length) return;

    const requestedContext: RuntimeContextRequest = {
      reason: 'Load the bounded entrypoint and configuration evidence required by the architecture task.',
      requestedRefs: requestedPaths.map((path) => ({
        type: 'workspace_file',
        label: path,
        ref: path
      })),
      requestedFiles: requestedPaths.map((path) => ({ path })),
      followUpInstruction: 'Continue with partial evidence if the bounded preload deadline is reached.'
    };
    try {
      const resolution = await this.hydrateSupplementalContext(session, requestedContext, {
        ...(task.workItemId ?? session.activeWorkItemId ? { workItemId: task.workItemId ?? session.activeWorkItemId } : {}),
        deadlineMs: 1_500,
        maxOperations: 8,
        maxContentBytes: 256 * 1024
      });
      this.recordSupplementalContextRequest(session, task, agentId, requestedContext, resolution);
    } catch {
      // Architecture execution remains available with the partial index when the Provider is slow or offline.
    }
  }

  private workspaceNavigationFilePaths(session: SessionDetail): string[] {
    if (session.workspaceIndex) {
      return session.workspaceIndex.entries
        .filter((entry) => entry.kind === 'file' && !entry.generated && !entry.sensitive)
        .map((entry) => entry.path);
    }
    return session.workspaceSnapshot?.files.map((file) => file.path) ?? [];
  }

  private architectureContextPathScore(path: string) {
    const lower = path.toLowerCase();
    const fileName = lower.split('/').at(-1) ?? lower;
    let score = 0;
    if (['package.json', 'readme.md', 'agents.md', 'claude.md', 'tsconfig.json', 'nest-cli.json'].includes(fileName)) {
      score += 110;
    }
    if (/^(vite|webpack|rollup|eslint|vitest|playwright)\.config\.(ts|js|mjs|cjs)$/.test(fileName)) {
      score += 96;
    }
    if (/(^|\/)(main|index|app|server|bootstrap)\.(ts|tsx|js|jsx|mjs|cjs|vue)$/.test(lower)) {
      score += 120;
    }
    if (/\/(modules?|services?|runtimes?|orchestrator|sessions?|tasks?|agents?|events?|intent|router|routes|stores?|api|contracts?|types?|schemas?)\//.test(lower)) {
      score += 82;
    }
    if (/\/(runtime|service|controller|module|provider|store|router|route|contract|schema|types?)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) {
      score += 54;
    }
    if (/^docs\/(ai-agent-context|design|product|contracts|quality)\//.test(lower)) {
      score += 58;
    }
    if (/(^|\/)(tests?|e2e|__tests__)\//.test(lower) || /\.(test|spec)\./.test(lower)) {
      score -= 48;
    }
    return score;
  }

  private findAlternativeClaimAgent(
    session: SessionDetail,
    task: AgentTask,
    decision: TaskAcceptanceDecisionOutput,
    attemptedAgentIds: Set<string>
  ) {
    if (task.workflowRunId) return undefined;
    const eligibleAgentIds = task.eligibleAgentIds?.length ? new Set(task.eligibleAgentIds) : undefined;
    const participants = this.participatingAgents(session).filter(
      (agent) => !eligibleAgentIds || eligibleAgentIds.has(agent.id)
    );
    if (this.isArchitectureAnalysisTask(session, task)) {
      const architect = participants.find((candidate) => candidate.key === 'architect');
      return architect && !attemptedAgentIds.has(architect.id) ? architect : undefined;
    }
    const hints = [
      decision.handoffSuggestion?.targetAgentId,
      decision.handoffSuggestion?.targetAgentKey,
      ...(decision.alternativeAgentIds ?? []),
      ...(decision.alternativeAgentKeys ?? [])
    ].filter((hint): hint is string => Boolean(hint));
    for (const hint of hints) {
      const agent = participants.find((candidate) => candidate.id === hint || candidate.key === hint);
      if (agent && !attemptedAgentIds.has(agent.id) && !['coordinator', 'notification'].includes(agent.key)) {
        return agent;
      }
    }

    const taskText = `${task.title} ${task.description}`;
    const isReviewTask = /复核|复盘|review|审查|审核|检查|把关|评审|质量/i.test(taskText);
    const isValidationTask = this.isValidationSuggestedTask({ title: task.title, description: task.description } as any);

    if (isReviewTask || isValidationTask) {
      const preferredKeys = isValidationTask ? ['test', 'review'] : ['review', 'test'];
      for (const key of preferredKeys) {
        const agent = participants.find((candidate) => candidate.key === key);
        if (agent && !attemptedAgentIds.has(agent.id)) {
          return agent;
        }
      }
      return undefined;
    }

    const domain = session.taskDomain ?? (session.workingDirectory ? 'mixed' : 'non_coding');
    const isPlanningTask = /plan|planning|requirement|analysis|scope|需求|计划|规划|分析|范围/i.test(taskText);
    const preferredKeys =
      domain === 'non_coding' || isPlanningTask
        ? ['requirements', 'product-manager', 'review', 'test', 'backend', 'frontend']
        : ['backend', 'frontend', 'requirements', 'test', 'review'];
    for (const key of preferredKeys) {
      const agent = participants.find((candidate) => candidate.key === key);
      if (agent && !attemptedAgentIds.has(agent.id)) {
        return agent;
      }
    }

    return participants.find(
      (agent) => !attemptedAgentIds.has(agent.id) && !['coordinator', 'notification'].includes(agent.key)
    );
  }

  private acceptanceDecisionAlternativeIds(session: SessionDetail, decision: TaskAcceptanceDecisionOutput) {
    const participants = this.participatingAgents(session);
    return [
      decision.handoffSuggestion?.targetAgentId,
      decision.handoffSuggestion?.targetAgentKey,
      ...(decision.alternativeAgentIds ?? []),
      ...(decision.alternativeAgentKeys ?? [])
    ]
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
      .map((task) => agentIdFromActor(task.assignee))
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

    const reviewContextAssembly = this.createContextAssembly(session, review, brief, undefined, 'post_review');
    const reviewRun = await this.runRuntime(session, {
      invocationId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'post_review',
      agent: review,
      contextAssembly: reviewContextAssembly,
      expectedOutput: { kind: 'post_review_report', schemaVersion: '1.0' },
      budget: reviewContextAssembly.budget
    }, signal);
    if (signal?.aborted) {
      throw new Error(messages.cancelled);
    }
    const reviewOutput = this.completedOutput<PostReviewReportOutput>(reviewRun, 'post_review_report');
    const allowGeneratedFileWrites = this.shouldWriteGeneratedFiles(session, brief);
    const reviewFileChanges = allowGeneratedFileWrites ? this.reviewFileChanges(reviewOutput) : [];
    const reviewArtifact = this.artifacts.create({
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
      agentId: review.id,
      type: 'test_report',
      title: messages.reviewReportTitle,
      contentSummary: reviewOutput.recommendation,
      platformProjections: reviewFileChanges,
      metadata: {
        phase: 'post_review'
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
        platformProjections: reviewFileChanges
      })
    });
    await this.applyServerLocalArtifactChanges(session, reviewFileChanges);
    this.createSummaryMemoryCheckpoint(session, review, 'post_review', brief);
    return reviewOutput;
  }

  private latestLimitedDeliveryAction(sessionId: string) {
    const events = this.events.list(sessionId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type !== 'user_confirmation_resolved') continue;
      const payload = event.metadata.payload as { action?: PostReviewAction } | undefined;
      if (payload?.action?.action === 'deliver_with_limitations') {
        return payload.action;
      }
    }
    return undefined;
  }

  private async runFinalDelivery(
    session: SessionDetail,
    brief: TaskBrief,
    signal?: AbortSignal,
    limitations: string[] = []
  ): Promise<void> {
    const review = this.pickSessionAgent(session, ['review', 'test'], 1);
    const coordinator = this.pickSessionAgent(session, ['coordinator'], 0);
    const finalContextAssembly = this.createContextAssembly(session, coordinator, brief, undefined, 'final_delivery');
    if (limitations.length) {
      finalContextAssembly.constraints = [
        ...finalContextAssembly.constraints,
        'The user selected limited delivery. Preserve every listed limitation in the final delivery risks and do not claim it was verified.',
        ...limitations.map((limitation) => `Limited delivery: ${limitation}`)
      ];
    }
    const finalRun = await this.runRuntime(session, {
      invocationId: crypto.randomUUID(),
      sessionId: session.id,
      phase: 'final_delivery',
      agent: coordinator,
      contextAssembly: finalContextAssembly,
      expectedOutput: { kind: 'final_delivery', schemaVersion: '1.0' },
      budget: finalContextAssembly.budget
    }, signal);
    if (signal?.aborted) {
      throw new Error(messages.cancelled);
    }
    const finalOutput = this.completedOutput<FinalDeliveryOutput>(finalRun, 'final_delivery');
    const isArchitectureAnalysis = this.isArchitectureAnalysisSession(session, brief);
    const allowGeneratedFileWrites = this.shouldWriteGeneratedFiles(session, brief);
    const deliveryFileChanges = isArchitectureAnalysis
      ? this.finalDeliveryFileChanges(session, brief, finalOutput)
      : allowGeneratedFileWrites
        ? this.finalDeliveryFileChanges(session, brief, finalOutput)
        : [];
    const reportChange = isArchitectureAnalysis
      ? deliveryFileChanges.find((change) => change.path === 'agent-output/project-architecture-analysis.md')
      : undefined;
    const report = reportChange?.content
      ? {
          title: '完整系统架构说明',
          format: 'markdown' as const,
          content: reportChange.content,
          suggestedPath: reportChange.path,
          requiresUserConfirmation: true as const
        }
      : undefined;
    const deliveryArtifact = this.artifacts.create({
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
      agentId: coordinator.id,
      type: 'markdown',
      title: isArchitectureAnalysis ? '完整系统架构说明' : messages.finalDeliveryTitle,
      contentSummary: finalOutput.summary,
      platformProjections: deliveryFileChanges,
      metadata: {
        phase: 'final_delivery',
        limitations,
        ...(report ? { report } : {})
      }
    });
    const notification = isArchitectureAnalysis ? undefined : this.pickSessionAgent(session, ['notification'], 0);
    const notificationFileChanges =
      notification && allowGeneratedFileWrites ? this.notificationDraftFileChanges(brief, finalOutput) : [];
    const notificationDraft = notification
      ? this.artifacts.create({
          sessionId: session.id,
          workItemId: session.activeWorkItemId,
          agentId: notification.id,
          type: 'feishu_draft',
          title: messages.notificationDraftTitle,
          contentSummary: messages.notificationDraftSummary,
          platformProjections: notificationFileChanges,
          metadata: {
            phase: 'notification_draft',
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
              risks: [...finalOutput.risks, ...limitations]
            },
            sourceArtifactId: deliveryArtifact.id
          }
        })
      : undefined;
    const artifactRefs = [...this.artifacts.listBySession(session.id).map((artifact) => artifact.id)];
    this.events.create({
      sessionId: session.id,
      type: 'final_delivery_created',
      fromAgentId: coordinator.id,
      content: messages.finalDeliveryCreated,
      metadata: createMetadata('delivery_card', {
        ...finalOutput,
        relatedBriefId: brief.id,
        limitations,
        artifactRefs,
        ...(notificationDraft ? { notificationDraftArtifactId: notificationDraft.id } : {}),
        ...(report ? { report: { ...report, artifactId: deliveryArtifact.id } } : {})
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
        ...(report
          ? {
              report: {
                kind: 'project_architecture_analysis',
                title: report.title,
                content: report.content
              }
            }
          : {}),
        platformProjections: report ? [] : deliveryFileChanges
      })
    });
    if (report) {
      this.events.create({
        sessionId: session.id,
        type: 'user_confirmation_requested',
        fromAgentId: coordinator.id,
        content: '完整系统架构说明已生成，请确认是否保存到本地工作区。',
        metadata: createMetadata('confirmation_card', {
          confirmationId: crypto.randomUUID(),
          reason: 'confirm_local_report_save',
          title: '是否保存系统架构说明',
          description: `报告全文已在群聊中展示。确认后才会写入 ${report.suggestedPath}；选择不保存则只保留在当前会话。`,
          relatedArtifactId: deliveryArtifact.id,
          targetPath: report.suggestedPath,
          options: [
            { key: 'save_local', label: '保存到本地', style: 'primary' },
            { key: 'keep_in_session', label: '暂不保存', style: 'default' }
          ]
        })
      });
    } else if (notification && notificationDraft) {
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
          platformProjections: notificationFileChanges
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
    this.createSummaryMemoryCheckpoint(session, coordinator, 'final_delivery', brief);
  }

  private emitMemoryUsedEvent(sessionId: string, taskId: string, agentId: string, contextAssembly: ContextAssembly) {
    if (!contextAssembly.relevantMemories.length) {
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
        memoryIds: contextAssembly.relevantMemories.map((memory) => memory.id),
        memories: contextAssembly.relevantMemories
      })
    });
  }

  private async runFollowUpDiscussion(
    session: SessionDetail,
    coordinator: Agent,
    participants: Agent[],
    content: string,
    signal?: AbortSignal
  ) {
    await this.runtime.refreshRuntimeAvailability?.();
    const consultations = participants.map(agent => {
      const contextAssembly = this.createContextAssembly(session, agent, undefined, undefined, 'discussion');
      contextAssembly.systemRules = [
        ...contextAssembly.systemRules,
        'Discuss only the explicitly supplied follow-up requirement. Return your recommendation to the receiver.',
        'Do not execute the task in the discussion phase.'
      ];
      contextAssembly.constraints = [...contextAssembly.constraints, `Follow-up requirement: ${content}`];
      return { agent, invocationId: crypto.randomUUID(), contextAssembly };
    });
    const results = await boundedConsultations(consultations, consultationConcurrency(),
      item => this.runDiscussionRuntime(session, item.agent, item.invocationId, item.contextAssembly, signal),
      result => result.status !== 'completed' || !usableAgentMessageOutput(result.output), signal);
    for (const [index, { agent, invocationId }] of consultations.entries()) {
      throwIfAborted(signal);
      const result = results[index];
      if (!result) break;
      const output =
        result.status === 'completed' && usableAgentMessageOutput(result.output)
          ? result.output
          : createAgentMessageOutput({
              messageKind: 'risk',
              content: `${agent.name} 未能完成本轮讨论：${result.error?.message ?? result.status}`
            });
      this.events.create({
        sessionId: session.id,
        type: 'agent_message',
        fromAgentId: agent.id,
        toAgentIds: [coordinator.id],
        content: output.content,
        metadata: createMetadata('chat_message', {
          messageKind: output.messageKind,
          mentionedAgentIds: participants.map((participant) => participant.id),
          relatedTaskIds: [],
          runtimeInvocationId: invocationId,
          phase: 'follow_up_discussion',
          runtimeError: result.error
        })
      });
      if (result.status !== 'completed' || !usableAgentMessageOutput(result.output)) {
        throw new Error(`Required discussion by ${agent.name} did not complete: ${result.error?.message ?? result.status}`);
      }
    }
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: coordinator.id,
      toAgentIds: participants.map((agent) => agent.id),
      content: '接收者已汇总被 @Agent 的讨论结果，开始进行任务拆分。',
      metadata: createMetadata('chat_message', {
        messageKind: 'summary',
        phase: 'follow_up_discussion_completed',
        mentionedAgentIds: participants.map((agent) => agent.id)
      })
    });
  }

  private async runDiscussion(session: SessionDetail, coordinator: Agent, signal?: AbortSignal) {
    await this.runtime.refreshRuntimeAvailability?.();
    throwIfAborted(signal);
    const participants = this.discussionParticipants(session, coordinator);
    const rounds = this.discussionMaxRounds();
    for (let round = 1; round <= rounds; round += 1) {
      const consultations = participants.map(agent => ({ agent, invocationId: crypto.randomUUID(),
        contextAssembly: this.createContextAssembly(session, agent, undefined, undefined, 'discussion') }));
      const results = await boundedConsultations(consultations, consultationConcurrency(), async ({ agent, invocationId, contextAssembly }) => {
        throwIfAborted(signal);
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
        return this.runDiscussionRuntime(session, agent, invocationId, contextAssembly, signal);
      }, result => result.status !== 'completed' || !usableAgentMessageOutput(result.output), signal);
      for (const [index, { agent, invocationId }] of consultations.entries()) {
        throwIfAborted(signal);
        const result = results[index];
        if (!result) break;
        const timedOut = result.error?.code === 'RUNTIME_TIMEOUT';
        const discussionRuntimeError: RuntimeError | undefined = result.error ?? (
          result.status === 'completed' && !usableAgentMessageOutput(result.output)
            ? {
                code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION',
                message: 'Discussion Runtime returned an invalid or empty agent_message output.',
                retryable: false,
                details: { expectedKind: 'agent_message' }
              }
            : undefined
        );
        const discussionFailed = Boolean(discussionRuntimeError) || result.status !== 'completed';
        const output =
          result.status === 'completed' && usableAgentMessageOutput(result.output)
            ? (result.output as AgentMessageOutput)
            : createAgentMessageOutput({
                messageKind: 'risk',
                content: timedOut
                  ? messages.discussionTimedOutMessage(agent.name)
                  : messages.discussionFailedMessage(
                      agent.name,
                      result.error?.message ??
                        (result.status === 'completed' ? 'invalid or empty agent_message output' : result.status)
                    )
              }) satisfies AgentMessageOutput;
        this.events.create({
          sessionId: session.id,
          type: 'agent_status_changed',
          fromAgentId: agent.id,
          content: timedOut
            ? messages.discussionTimedOutStatus(agent.name)
            : discussionFailed
              ? messages.discussionFailedStatus(agent.name)
              : messages.discussionCompletedStatus(agent.name),
          metadata: createMetadata('system_notice', {
            agentId: agent.id,
            status: timedOut ? 'waiting' : discussionFailed ? 'failed' : 'thinking',
            thoughtSummary: timedOut
              ? messages.discussionTimedOutThought
              : discussionFailed
                ? messages.discussionFailedThought
                : messages.discussionCompletedThought,
            actionSummary: output.content,
            waitingFor: timedOut ? [coordinator.id] : [],
            runtimeError: discussionRuntimeError
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
            runtimeInvocationId: invocationId,
            runtimeError: discussionRuntimeError,
            round
          })
        });
        if (discussionRuntimeError) {
          throw Object.assign(new Error(discussionRuntimeError.message), {
            cause: discussionRuntimeError,
            runtimeError: discussionRuntimeError
          });
        }
        if (discussionFailed) throw new Error(`Required discussion did not complete: ${agent.name}`);
      }
    }
  }
  private async runDiscussionRuntime(
    session: SessionDetail,
    agent: Agent,
    invocationId: string,
    contextAssembly: ContextAssembly,
    signal?: AbortSignal
  ) {
    contextAssembly = { ...contextAssembly,
      systemRules: [...contextAssembly.systemRules ?? [],
        'Read-only consultation: identify unresolved requirements, constraints and risks for your assigned role.',
        'Refer to supplied upstream evidence instead of repeating it. Do not implement code or repeat other roles. Keep the recommendation concise.'],
      budget: { ...contextAssembly.budget, maxOutputTokens: Math.min(contextAssembly.budget.maxOutputTokens ?? 1200, 1200) } };
    return this.runRuntime(session, {
      invocationId,
      sessionId: session.id,
      phase: 'discussion',
      agent,
      contextAssembly,
      expectedOutput: { kind: 'agent_message', schemaVersion: '1.0' },
      budget: contextAssembly.budget
    }, signal);
  }

  private normalizeDiscussionTimeoutResult(result: AgentRunResult, agentName: string, timeoutMs: number): AgentRunResult {
    return normalizeTerminatedResult(
      result,
      createExecutionTermination({
        kind: 'phase_timeout',
        source: 'orchestrator',
        scope: 'phase',
        phase: 'discussion',
        timeout: { mode: 'deadline', timeoutMs },
        diagnosticRef: agentName
      })
    );
  }

  private discussionParticipants(session: SessionDetail, coordinator: Agent) {
    const sessionParticipants = this.participatingAgents(session).filter(
      (agent) => agent.id !== coordinator.id
    );
    const configured = process.env.DISCUSSION_AGENT_KEYS?.trim();
    if (!configured) {
      return sessionParticipants;
    }
    const allowKeys = new Set(
      configured
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
    );
    if (!allowKeys.size) {
      return sessionParticipants;
    }
    const filtered = sessionParticipants.filter((agent) => allowKeys.has(agent.key));
    return filtered.length ? filtered : sessionParticipants;
  }

  private discussionMaxRounds() {
    const parsed = Number(process.env.DISCUSSION_MAX_ROUNDS ?? 1);
    if (!Number.isFinite(parsed)) {
      return 1;
    }
    return Math.max(0, Math.min(3, Math.floor(parsed)));
  }

  private isFatalDiscussionRuntimeError(error: RuntimeError) {
    return error.code === 'RUNTIME_INVOCATION_ERROR' ||
      error.code === 'RUNTIME_OUTPUT_CONTRACT_VIOLATION' ||
      error.code === 'CAPABILITY_BLOCKED' ||
      error.details?.providerFailure === true ||
      typeof error.details?.httpStatus === 'number';
  }

  private isTerminalTask(task: AgentTask) {
    return ['completed', 'cancelled', 'failed', 'rejected'].includes(task.status);
  }

  private executionScopeTasks(requestedTasks: AgentTask[], allTasks: AgentTask[]) {
    if (!requestedTasks.length) return allTasks;
    const byId = new Map(allTasks.map((task) => [task.id, task]));
    const scoped = new Map(requestedTasks.map((task) => [task.id, task]));
    const pending = [...requestedTasks];
    while (pending.length) {
      const task = pending.pop();
      if (!task) continue;
      for (const dependencyId of task.dependsOnTaskIds) {
        const dependency = byId.get(dependencyId);
        if (!dependency || scoped.has(dependency.id)) continue;
        scoped.set(dependency.id, dependency);
        pending.push(dependency);
      }
    }
    return [...scoped.values()];
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
    invocationId: string,
    message: string,
    runtimeType: RuntimeType,
    code: RuntimeError['code'] = 'MODEL_ERROR',
    requestedContext?: RuntimeContextRequest,
    details?: Record<string, unknown>,
    retryable = false
  ) {
    const needsMoreContext = code === 'CONTEXT_INSUFFICIENT';
    const taskStatus: AgentTask['status'] = needsMoreContext ? 'waiting' : 'failed';
    const isFileRevisionTask = task.executionPurpose === 'file_revision' || task.executionPurpose === 'revision_synthesis';
    const publicMessage = isFileRevisionTask ? 'File revision Runtime failed.' : message;
    const publicRequestedContext = isFileRevisionTask ? undefined : requestedContext;
    const publicDetails = isFileRevisionTask ? undefined : details;
    this.tasks.update(task, { status: taskStatus, resultSummary: publicMessage });
    this.events.create({
      sessionId,
      workItemId: task.workItemId,
      type: 'runtime_failed',
      taskId: task.id,
      fromAgentId: agentId,
      content: needsMoreContext ? `Runtime requested more context for task: ${task.title}` : messages.runtimeFailed(task.title),
      metadata: createMetadata('error_card', {
        runtimeInvocationId: invocationId,
        runtimeType,
        taskId: task.id,
        title: task.title,
        status: needsMoreContext ? 'blocked' : 'failed',
        code,
        message: publicMessage,
        requestedContext: publicRequestedContext,
        details: publicDetails,
        runtimeError: {
          code,
          message: publicMessage,
          retryable,
          ...(publicRequestedContext ? { requestedContext: publicRequestedContext } : {}),
          ...(publicDetails ? { details: publicDetails } : {})
        } satisfies RuntimeError
      })
    });
    this.events.create({
      sessionId,
      type: needsMoreContext ? 'task_waiting' : 'task_failed',
      taskId: task.id,
      fromAgentId: agentId,
      content: needsMoreContext ? `Task is waiting for more context: ${task.title}` : messages.taskFailed(task.title),
      metadata: createMetadata('task_card', {
        taskId: task.id,
        title: task.title,
        status: taskStatus,
        resultSummary: publicMessage,
        requestedContext: publicRequestedContext
      })
    });
  }

  private markTaskCancelled(
    sessionId: string,
    task: AgentTask,
    agentId: string,
    invocationId: string,
    message: string,
    runtimeType: RuntimeType
  ) {
    this.tasks.update(task, { status: 'waiting', resultSummary: message });
    this.events.create({
      sessionId,
      workItemId: task.workItemId,
      type: 'runtime_failed',
      taskId: task.id,
      fromAgentId: agentId,
      content: messages.runtimeFailed(task.title),
      metadata: createMetadata('error_card', {
        runtimeInvocationId: invocationId,
        runtimeType,
        taskId: task.id,
        title: task.title,
        status: 'cancelled',
        code: 'RUNTIME_CANCELLED',
        message,
        runtimeError: {
          code: 'RUNTIME_CANCELLED',
          message,
          retryable: false
        } satisfies RuntimeError
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

  private async taskExecutionOperation(session: SessionDetail, task: AgentTask, invocationId: string) {
    let operation = await this.runtime.operations.begin({ id: task.executionOperationId ?? invocationId,
      sessionId: session.id, taskId: task.id, phase: 'task_execution', previousId: task.previousExecutionOperationId });
    if (operation.status === 'paused') operation = await this.runtime.operations.resume(session.id, operation.id);
    if (!task.executionOperationId) this.tasks.update(task, { executionOperationId: operation.id });
    return operation;
  }

  private canRetryRuntimeTimeout(error: AgentRunResult['error'] | undefined, runtimeRetryCount: number) {
    return error?.code === 'RUNTIME_TIMEOUT' &&
      error.retryable === true &&
      error.details?.providerFailure !== true &&
      !error.details?.operationFailure && !error.details?.stopUnconfirmed &&
      runtimeRetryCount < 1;
  }

  private recordRuntimeTimeoutRetry(
    session: SessionDetail,
    task: AgentTask,
    agentId: string,
    invocationId: string,
    message: string,
    nextAttempt: number
  ) {
    this.events.create({
      sessionId: session.id,
      workItemId: task.workItemId,
      type: 'runtime_progress',
      taskId: task.id,
      fromAgentId: agentId,
      content: `运行时超时，正在自动重试任务：${task.title}`,
      metadata: createMetadata('system_notice', {
        runtimeInvocationId: invocationId,
        code: 'RUNTIME_TIMEOUT_RETRY',
        taskId: task.id,
        title: task.title,
        nextAttempt,
        message
      })
    });
  }

  private async backoffRuntimeRetry(attempt: number, signal?: AbortSignal) {
    const delayMs = 1_000 * 2 ** attempt;
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, delayMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }

  private canRetryWithSupplementalContext(
    code: RuntimeError['code'] | undefined,
    requestedContext: RuntimeContextRequest | undefined,
    contextRetryCount: number
  ) {
    return canRetryWithSupplementalContext(
      code,
      requestedContext,
      contextRetryCount,
      resolveContextInsufficientMaxRetries()
    );
  }

  /**
   * Trims duplicates from a runtime's CONTEXT_INSUFFICIENT request against the
   * session's prior supplemental requests. Returns the trimmed novel-only
   * context if a retry is allowed, otherwise undefined (no new refs/paths/
   * commands or retry budget exhausted).
   */
  private resolveRetryRequest(
    session: SessionDetail,
    code: RuntimeError['code'] | undefined,
    requestedContext: RuntimeContextRequest | undefined,
    contextRetryCount: number
  ): RuntimeContextRequest | undefined {
    if (!requestedContext) return undefined;
    const currentRevisionId = session.workspaceIndex?.revision.id ?? session.workspaceContext?.indexRevision?.id;
    const seen = collectSeenContextSignatures(session.supplementalContextRequests, currentRevisionId);
    const novelContext = trimToNovelContext(requestedContext, seen);
    if (!novelContext) return undefined;
    if (!this.canRetryWithSupplementalContext(code, novelContext, contextRetryCount)) {
      return undefined;
    }
    return novelContext;
  }

  private recordSupplementalContextRequest(
    session: SessionDetail,
    task: AgentTask | undefined,
    agentId: string,
    requestedContext: RuntimeContextRequest | undefined,
    resolution: SupplementalContextResolution,
    phase: AgentRunPhase = 'task_execution'
  ) {
    if (!requestedContext) return;
    session.supplementalContextRequests = [
      ...(session.supplementalContextRequests ?? []),
      {
        id: crypto.randomUUID(),
        ...(task ? { taskId: task.id } : {}),
        agentId,
        phase,
        requestedContext,
        resolution,
        createdAt: nowIso()
      }
    ].slice(-12);
    const requestedRefs = requestedContext.requestedRefs
      .map((ref) => `${ref.type}:${ref.ref ?? ref.label}`)
      .filter(Boolean)
      .join(', ');
    const requestedPaths = [
      ...(requestedContext.requestedFiles ?? []).map((item) => item.path),
      ...(requestedContext.requestedPaths ?? [])
    ].join(', ') || 'none';
    const requestedCommands = requestedContext.requestedCommands?.join(', ') || 'none';
    const content = [
      task
        ? `Supplemental context request for task "${task.title}".`
        : `Supplemental context request for phase "${phase}".`,
      `Reason: ${requestedContext.reason}`,
      `Requested refs: ${requestedRefs || 'none'}`,
      `Requested paths: ${requestedPaths}`,
      `Requested commands: ${requestedCommands}`,
      `Hydrated paths: ${resolution.hydratedPaths.join(', ') || 'none'}`,
      `Resolved refs: ${(resolution.resolvedRefs ?? []).map((item) => `${item.type}:${item.ref ?? item.label}`).join(', ') || 'none'}`,
      `Failed refs: ${(resolution.failedRefs ?? []).map((item) => `${item.type}:${item.ref ?? item.label}:${item.code}`).join(', ') || 'none'}`,
      `Failed paths: ${resolution.failedPaths.map((item) => `${item.path}:${item.code}`).join(', ') || 'none'}`,
      `Deferred paths: ${resolution.deferredPaths.join(', ') || 'none'}`,
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
    const eventContent = resolution.outcome === 'resolved'
      ? `Supplemental context hydrated for retry: ${requestedContext.reason}`
      : resolution.outcome === 'partial'
        ? `Supplemental context was partially hydrated for retry: ${requestedContext.reason}`
        : resolution.outcome === 'cancelled'
          ? `Supplemental context request was cancelled: ${requestedContext.reason}`
          : `Supplemental context could not be hydrated: ${requestedContext.reason}`;
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      ...(task ? { taskId: task.id } : {}),
      fromAgentId: agentId,
      content: eventContent,
      metadata: createMetadata('chat_message', {
        messageKind: 'progress',
        phase: 'context_supplement',
        relatedTaskIds: task ? [task.id] : [],
        runtimePhase: phase,
        memoryId: memory.id,
        requestedContext,
        resolution
      })
    });
  }

  /**
   * Emits a session-visible signal when a CONTEXT_INSUFFICIENT request was
   * rejected without retry (e.g. because every requested ref/path/command was
   * already supplied in a prior round). This keeps the rejection reason
   * observable on the session even though no new request is persisted.
   */
  private emitSupplementalContextRejected(
    session: SessionDetail,
    task: AgentTask,
    agentId: string,
    requestedContext: RuntimeContextRequest | undefined,
    reasonCode: 'duplicate_request'
  ) {
    if (!requestedContext) return;
    this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      taskId: task.id,
      fromAgentId: agentId,
      content: `Supplemental context request rejected (${reasonCode}): ${requestedContext.reason}`,
      metadata: createMetadata('chat_message', {
        messageKind: 'progress',
        phase: 'context_supplement',
        relatedTaskIds: [task.id],
        requestedContext,
        rejectionReason: reasonCode
      })
    });
  }

  private createExecutionArtifact(
    sessionId: string,
    task: AgentTask,
    agentId: string,
    output: TaskExecutionResultOutput,
    systemEvidence: AgentRunResult['systemEvidence'],
    allowFileChanges = true,
    _workspaceExecution?: AgentRunResult['workspaceExecution']
  ) {
    const testAgent = this.agents.findByIdOrKey('test');
    const outputForMetadata = allowFileChanges
      ? output
      : {
          ...output,
          changedArtifacts: this.withoutRuntimeArtifactFileChanges(output.changedArtifacts)
        };
    const proposalsForPersistence = outputForMetadata.changedArtifacts;
    const platformProjections = allowFileChanges
      ? this.runtimeStageFileChangeProjections(proposalsForPersistence)
      : [];
    return this.artifacts.create({
      sessionId,
      workItemId: task.workItemId,
      taskId: task.id,
      agentId,
      type: testAgent && agentId === testAgent.id ? 'test_report' : 'json',
      title: `${task.title}执行结果`,
      contentSummary: output.summary,
      runtimeProposals: proposalsForPersistence,
      platformProjections,
      systemEvidence,
      metadata: {
        phase: 'task_execution',
        status: output.status
      }
    });
  }

  private withoutRuntimeArtifactFileChanges(artifacts: RuntimeArtifactOutput[]) {
    return artifacts.map((artifact) =>
      artifact.metadata?.fileChanges
        ? {
            ...artifact,
            metadata: {
              ...artifact.metadata,
              fileChanges: []
            }
          }
        : artifact
    );
  }

  private runtimeStageFileChangeProjections(artifacts: RuntimeArtifactOutput[]): RuntimeFileChange[] {
    return artifacts.flatMap((artifact) =>
      (artifact.metadata.fileChanges ?? [])
        .filter((change) => this.isStageArtifactFileChange(change))
        .map((change) => ({
          path: change.path,
          operation: change.operation,
          encoding: change.encoding,
          source: 'stage_artifact' as const,
          ...(typeof change.content === 'string' ? { content: change.content } : {}),
          ...(change.previousContent !== undefined ? { previousContent: change.previousContent } : {})
        }))
    );
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
          path: 'agent-output/project-architecture-analysis.md',
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
      '# 完整系统架构说明',
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
        ? ['## 详细架构分析正文', '', report.content].join('\n')
        : '## 详细架构分析正文\n\n- 未在当前会话产物中找到项目架构分析报告正文，请检查任务执行阶段是否成功生成 agent-output/project-architecture-analysis.md。'
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
    const modificationPlan = this.workspaceModificationPlan(impactedFiles, session.originalInput);
    const summary = `已分析 ${snapshot.rootName}：索引包含 ${snapshot.fileCount} 个条目，本次按需读取 ${readableFiles.length} 个文本文件。`;
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
      rationale: focus?.rationale ?? '基于工作区元数据索引、按需读取的文件证据和用户需求关键词完成初步架构分析，并形成多文件影响面。'
    };
    const markdown = [
      '# 工作区架构分析',
      '',
      `会话需求：${session.originalInput}`,
      `工作区：${snapshot.rootName}`,
      `索引与取证时间：${snapshot.scannedAt}`,
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
      '## 索引与取证统计',
      `- 索引条目：${snapshot.fileCount}`,
      `- 本次按需读取文件：${readableFiles.length}`,
      `- 过滤条目：${snapshot.skipped.length}`,
      `- 本次证据字节数：${snapshot.totalBytes}`,
      '',
      '## 过滤原因',
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
          `索引条目：${snapshot.fileCount}，本次按需读取：${readableFiles.length}，过滤：${snapshot.skipped.length}`,
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

  private workspaceModificationPlan(paths: string[], requirement: string) {
    const groups = new Map<string, string[]>();
    for (const path of paths) {
      const action = this.workspaceModificationAction(path);
      groups.set(action, [...(groups.get(action) ?? []), path]);
    }
    const requirementLabel = this.shortRequirement(requirement);
    return [...groups.entries()].map(
      ([action, groupPaths]) => `${action}：${groupPaths.join('、')}，确保与需求“${requirementLabel}”一致。`
    );
  }

  private workspaceModificationAction(path: string) {
    const fileName = path.split('/').at(-1) ?? path;
    const lower = fileName.toLowerCase();
    return lower.endsWith('.css') || lower.endsWith('.scss')
      ? '调整样式或布局相关实现'
      : lower.endsWith('.vue') || lower.endsWith('.tsx') || lower.endsWith('.jsx')
        ? '调整页面组件、状态展示或交互逻辑'
        : lower.endsWith('.ts') || lower.endsWith('.js')
          ? '调整业务逻辑、类型或运行时处理'
          : lower.endsWith('.md')
            ? '同步更新文档和阶段说明'
            : '按需求补充或更新文件内容';
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

  private platformFileChangesForArtifact(artifact: Artifact): RuntimeFileChange[] {
    const byPath = new Map(artifact.platformProjections.map((change) => [change.path, { ...change }]));
    for (const change of artifact.systemEvidence?.workspaceChangeSet?.changes ?? []) {
      if (change.operation === 'move') continue;
      byPath.set(change.path, {
        path: change.path,
        operation: change.operation,
        source: 'actual_filesystem_snapshot' as const,
        ...(change.operation === 'create' || change.operation === 'update'
          ? { content: change.content, encoding: change.encoding }
          : {})
      });
    }
    return [...byPath.values()];
  }

  private projectArchitectureAnalysisFileChange(sessionId: string) {
    for (const artifact of this.artifacts.listBySession(sessionId)) {
      const fileChanges = this.platformFileChangesForArtifact(artifact);
      const report = fileChanges.find((change) => change.path === 'agent-output/project-architecture-analysis.md');
      if (report) return report;

      const runtimeReport = artifact.runtimeProposals.find(
        (item) =>
          /项目架构|系统架构|architecture/i.test(item.title)
      );
      if (runtimeReport?.content?.trim()) {
        return {
          path: 'agent-output/project-architecture-analysis.md',
          operation: 'create' as const,
          encoding: 'utf-8' as const,
          content: runtimeReport.content
        };
      }
    }
    return undefined;
  }

  async decideLocalReportSave(
    session: SessionDetail,
    input: {
      confirmationId: string;
      artifactId: string;
      decision: 'save_local' | 'keep_in_session';
    }
  ) {
    const request = this.events.list(session.id).find((event) => {
      if (event.type !== 'user_confirmation_requested') return false;
      const payload = event.metadata.payload as Record<string, unknown> | undefined;
      return (
        payload?.confirmationId === input.confirmationId &&
        payload.reason === 'confirm_local_report_save' &&
        payload.relatedArtifactId === input.artifactId
      );
    });
    const alreadyResolved = this.events.list(session.id).some((event) => {
      if (event.type !== 'user_confirmation_resolved') return false;
      const payload = event.metadata.payload as Record<string, unknown> | undefined;
      return payload?.confirmationId === input.confirmationId;
    });
    if (!request || alreadyResolved) {
      throw new BadRequestException('Local report save confirmation is missing or already resolved.');
    }

    const artifact = this.artifacts.get(input.artifactId);
    if (artifact.sessionId !== session.id) {
      throw new BadRequestException('Report artifact does not belong to this session.');
    }
    const report = artifact.metadata.report as
      | {
          title?: string;
          format?: string;
          content?: string;
          suggestedPath?: string;
        }
      | undefined;
    if (report?.format !== 'markdown' || !report.content?.trim() || !report.suggestedPath?.trim()) {
      throw new BadRequestException('Report artifact does not contain a saveable Markdown body.');
    }

    if (input.decision === 'save_local') {
      if (session.workingDirectory?.kind !== 'server_local' || !session.workingDirectory.path) {
        throw new BadRequestException('Saving this report requires a server_local working directory.');
      }
      try {
        await applyServerLocalFileChanges(session.workingDirectory.path, [
          {
            path: report.suggestedPath,
            operation: 'create',
            encoding: 'utf-8',
            content: report.content,
            previousContent: null
          }
        ]);
      } catch (error) {
        throw new BadRequestException(
          `Failed to save local report: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const approved = input.decision === 'save_local';
    const resolvedEvent = this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_resolved',
      content: approved ? '用户确认将系统架构说明保存到本地。' : '用户选择暂不将系统架构说明保存到本地。',
      metadata: createMetadata('system_notice', {
        confirmationId: input.confirmationId,
        status: approved ? 'approved' : 'rejected',
        selectedOptionKey: input.decision,
        reason: 'confirm_local_report_save',
        artifactId: artifact.id,
        targetPath: report.suggestedPath
      })
    });
    const resultEvent = this.events.create({
      sessionId: session.id,
      type: 'agent_message',
      content: approved
        ? `完整系统架构说明已保存到 ${report.suggestedPath}。`
        : '完整系统架构说明已保留在当前会话中，未写入本地工作区。',
      metadata: createMetadata('chat_message', {
        messageKind: 'decision',
        phase: 'final_delivery',
        artifactId: artifact.id,
        targetPath: report.suggestedPath,
        saved: approved
      })
    });
    return { artifact, resolvedEvent, resultEvent, saved: approved, path: report.suggestedPath };
  }

  ensureArchitectureReportSaveConfirmation(session: SessionDetail) {
    if (
      session.status !== 'COMPLETED' ||
      session.workingDirectory?.kind !== 'server_local' ||
      !this.isArchitectureAnalysisSession(session)
    ) {
      return false;
    }
    const sessionEvents = this.events.list(session.id);
    const alreadyPrepared = sessionEvents.some((event) => {
      if (event.type !== 'user_confirmation_requested') return false;
      const payload = event.metadata.payload as Record<string, unknown> | undefined;
      return payload?.reason === 'confirm_local_report_save';
    });
    if (alreadyPrepared) return false;

    const sourceReport = this.projectArchitectureAnalysisFileChange(session.id);
    if (!sourceReport?.content?.trim()) return false;
    const finalDeliveryEvent = [...sessionEvents].reverse().find((event) => event.type === 'final_delivery_created');
    const finalPayload = finalDeliveryEvent?.metadata.payload as Partial<FinalDeliveryOutput> | undefined;
    const brief = this.listBriefs(session.id).at(-1);
    const reportContent = brief && finalPayload?.summary
      ? this.architectureAnalysisDeliveryMarkdown(
          brief,
          {
            schemaVersion: '1.0',
            kind: 'final_delivery',
            summary: finalPayload.summary,
            completedItems: finalPayload.completedItems ?? [],
            incompleteItems: finalPayload.incompleteItems ?? [],
            risks: finalPayload.risks ?? [],
            artifactRefs: finalPayload.artifactRefs ?? []
          },
          sourceReport
        )
      : sourceReport.content;
    const coordinator = this.pickSessionAgent(session, ['coordinator'], 0);
    const artifact = this.artifacts.create({
      sessionId: session.id,
      workItemId: session.activeWorkItemId,
      agentId: coordinator.id,
      type: 'markdown',
      title: '完整系统架构说明',
      contentSummary: finalPayload?.summary ?? '已从历史运行产物恢复完整系统架构说明。',
      metadata: {
        phase: 'final_delivery',
        recoveredFromHistoricalRuntimeArtifact: true,
        report: {
          title: '完整系统架构说明',
          format: 'markdown',
          content: reportContent,
          suggestedPath: 'agent-output/project-architecture-analysis.md',
          requiresUserConfirmation: true
        }
      }
    });

    const pendingFeishu = [...sessionEvents].reverse().find((event) => {
      if (event.type !== 'user_confirmation_requested') return false;
      const payload = event.metadata.payload as Record<string, unknown> | undefined;
      if (payload?.reason !== 'confirm_feishu_notification' || typeof payload.confirmationId !== 'string') return false;
      return !sessionEvents.some((candidate) => {
        if (candidate.type !== 'user_confirmation_resolved') return false;
        const resolved = candidate.metadata.payload as Record<string, unknown> | undefined;
        return resolved?.confirmationId === payload.confirmationId;
      });
    });
    if (pendingFeishu) {
      const payload = pendingFeishu.metadata.payload as Record<string, unknown>;
      this.events.create({
        sessionId: session.id,
        type: 'user_confirmation_resolved',
        content: '架构分析交付改为本地报告保存确认，旧飞书通知确认已关闭。',
        metadata: createMetadata('system_notice', {
          confirmationId: payload.confirmationId,
          status: 'rejected',
          selectedOptionKey: 'superseded_by_local_report_save',
          reason: 'confirm_feishu_notification'
        })
      });
    }

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
        report: {
          kind: 'project_architecture_analysis',
          title: artifact.title,
          content: reportContent
        },
        platformProjections: []
      })
    });
    this.events.create({
      sessionId: session.id,
      type: 'user_confirmation_requested',
      fromAgentId: coordinator.id,
      content: '完整系统架构说明已恢复，请确认是否保存到本地工作区。',
      metadata: createMetadata('confirmation_card', {
        confirmationId: crypto.randomUUID(),
        reason: 'confirm_local_report_save',
        title: '是否保存系统架构说明',
        description:
          '报告全文已在群聊中展示。确认后才会写入 agent-output/project-architecture-analysis.md；选择不保存则只保留在当前会话。',
        relatedArtifactId: artifact.id,
        targetPath: 'agent-output/project-architecture-analysis.md',
        options: [
          { key: 'save_local', label: '保存到本地', style: 'primary' },
          { key: 'keep_in_session', label: '暂不保存', style: 'default' }
        ]
      })
    });
    return true;
  }

  private isArchitectureAnalysisSession(session: SessionDetail, brief?: TaskBrief) {
    return this.isArchitectureAnalysisText(`${session.originalInput}\n${brief?.goal ?? ''}`);
  }

  private isArchitectureAnalysisTask(session: SessionDetail, task: AgentTask, brief?: TaskBrief) {
    return this.isArchitectureAnalysisText(
      [
        session.originalInput,
        brief?.goal,
        task.title,
        task.description,
        task.assignmentReason,
        ...(task.contextRequirements ?? []),
        ...(task.acceptanceCriteria ?? [])
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  private isArchitectureAnalysisText(text: string) {
    return /architecture|architect|project structure|project analysis|main execution|main flow|main path|架构|结构|目录|熟悉|分析项目|项目分析|了解项目|主链路/i.test(
      text
    );
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

  private canApplySourceFileChanges(agent: Agent, runtimeType: RuntimeType) {
    return agent.capabilityIds.includes('cap-file-write') && ['claude_code', 'codex'].includes(runtimeType);
  }

  private isStageArtifactFileChange(change: { path: string }) {
    const normalizedPath = change.path.replace(/\\/g, '/').replace(/^\.\//, '');
    return normalizedPath.startsWith('agent-output/');
  }

  private isTrustedActualSourceFileChange(change: RuntimeFileChange) {
    return !this.isStageArtifactFileChange(change) && change.source === 'actual_filesystem_snapshot';
  }

  private uniqueMemories<TMemory extends { id: string }>(memories: TMemory[]) {
    const seen = new Set<string>();
    return memories.filter((memory) => {
      if (seen.has(memory.id)) {
        return false;
      }
      seen.add(memory.id);
      return true;
    });
  }

  private createContextAssembly(
    session: SessionDetail,
    agent: Agent,
    brief?: TaskBrief,
    task?: AgentTask,
    phase: AgentRunPhase = 'discussion'
  ): ContextAssembly {
    const workItemId = task?.workItemId ?? brief?.workItemId ?? session.activeWorkItemId;
    const contextSlice = this.createWorkItemContextSlice(session, workItemId);
    const workItem = contextSlice.workItem;
    const inheritedDecisionIds = contextSlice.inheritedDecisionIds;
    const inheritedArtifactIds = contextSlice.inheritedArtifactIds;
    const decisionRecords = contextSlice.decisions;
    const decisionSetHash = decisionRecords.length
      ? crypto.createHash('sha256').update(decisionRecords.map((item) => `${item.id}:${item.revision}:${item.content}`).join('|')).digest('hex')
      : undefined;
    const scopedArtifacts = contextSlice.artifacts;
    const scopedEvents = contextSlice.events;
    const ragSnippets = task
      ? this.searchAgentKnowledge(session, agent, this.taskKnowledgeQuery(session, brief, task))
      : [];
    const searchedMemories = this.memories.search(
      session.id,
      [session.originalInput, session.latestContractGoal, brief?.goal, task?.title, task?.description]
        .filter(Boolean)
        .join(' '),
      agent.id
    ).filter((memory) => contextSlice.memories.some((item) => item.id === memory.id));
    // task_execution 一直无条件纳入最近 session memory;discussion/brief_generation
    // 阶段也纳入,因为用户对契约的修改内容以 session memory 形式落库,不能只靠
    // 关键词检索命中(检索 query 仍以原始需求为主,新增需求词很容易召不回)。
    // brief_consultation 同样纳入,因为探讨对话历史存为 session memory。
    const includeRecentSessionMemories =
      phase === 'task_execution' ||
      phase === 'discussion' ||
      phase === 'brief_generation' ||
      phase === 'brief_consultation';
    const recentAgentSessionMemories = includeRecentSessionMemories
      ? this.memories
          .list(session.id)
          .filter((memory) =>
            memory.scope === 'session' &&
            (!memory.agentId || memory.agentId === agent.id) &&
            contextSlice.memories.some((item) => item.id === memory.id)
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, 4)
      : [];
    const relevantMemories = this.uniqueMemories([...searchedMemories, ...recentAgentSessionMemories]).map((memory) =>
      this.memories.toRuntimeMemory(memory)
    );
    const workspaceFocus = this.projectMap.workspaceFocus(session);
    const projectMap = this.projectMap.buildProjectMap(session, workspaceFocus);
    const taskContext = this.contextRouter.route({
      session,
      currentGoal: workItem?.goal ?? session.originalInput,
      brief,
      task,
      phase,
      projectMap,
      workspaceFocus,
      relevantMemories,
      ragSnippets,
      artifacts: scopedArtifacts,
      events: scopedEvents,
      participatingAgentKeys: this.participatingAgents(session).map((item) => item.key)
    });
    const summaryMemory = this.createSummaryMemory(session, brief, task, phase, contextSlice);
    const compiledIdentity = this.compileAgentIdentity(agent);
    const coverageRule = buildCoverageSystemRule(session.workspaceSnapshot);
    const bootstrapRules = session.workspaceMode === 'bootstrap'
      ? [
          'The selected workspace is intentionally empty and the user authorized creating a new project from scratch.',
          'Do not request files merely because conventional project files do not exist yet; propose create operations for the required project structure.',
          'File creation is authorized as a proposed ChangeSet. Dependency installation and command execution still require separate user confirmation.'
        ]
      : [];
    const contextAssembly: ContextAssembly = {
      systemRules: [
        'Return structured JSON matching the expected RuntimeOutput kind.',
        'Do not perform external side effects unless explicitly allowed by capability policy.',
        'Use workspaceManifest for project structure and selectedEvidenceContents for readable evidence content.',
        'Treat taskContext.evidenceRefs as the selected minimal evidence set; request more context instead of inferring omitted file contents.',
        compiledIdentity.systemPrompt,
        ...bootstrapRules,
        ...(coverageRule ? [coverageRule] : [])
      ],
      sessionGoal: workItem?.goal ?? session.originalInput,
      workItemId,
      inheritedDecisionIds,
      inheritedArtifactIds,
      decisionSetHash,
      // 契约仍在协商的阶段(discussion/brief_generation/brief_revision)不注入
      // latestContractGoal:此时它还是旧契约的 goal,注入会强化旧目标、阻碍采纳
      // 用户修改。仅在基于已确认契约执行的阶段把它作为当前权威目标注入。
      // brief_consultation 也不注入:探讨是基于已确认契约,但目标是探讨本身,
      // 不是重新协商目标,上下文已在 consultBrief 里注入契约全文。
      currentContractGoal:
        phase === 'discussion' ||
        phase === 'brief_generation' ||
        phase === 'brief_revision' ||
        phase === 'brief_consultation'
          ? undefined
          : session.latestContractGoal,
      taskContext,
      summaryMemory,
      continuationState: this.createContinuationState(
        session,
        agent,
        task,
        phase,
        taskContext,
        summaryMemory,
        contextSlice
      ),
      workingDirectory: session.workingDirectory,
      workspaceSnapshot: this.runtimeWorkspaceSnapshot(session.workspaceSnapshot),
      workspaceManifest: buildWorkspaceManifest(session.workspaceSnapshot),
      selectedEvidenceContents: this.createSelectedEvidenceContents(session, taskContext, workItemId),
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
      agentProfile: compiledIdentity,
      relevantEvents: scopedEvents
        .filter((event) => {
          const payload = event.metadata?.payload as { code?: unknown; visibility?: unknown } | undefined;
          if (payload?.code === 'RUNTIME_HEARTBEAT') return false;
          return shouldPublishRuntimeEventToCollaboration({
            type: event.type,
            visibility: payload?.visibility,
            code: payload?.code
          });
        })
        .slice(-12)
        .map((event) => ({
        eventId: event.id,
        type: event.type,
        summary: event.content,
        createdAt: event.createdAt
      })),
      relevantMemories,
      ragSnippets,
      artifacts: scopedArtifacts.map((artifact) => ({
        artifactId: artifact.id,
        type: artifact.type,
        title: artifact.title,
        summary: artifact.contentSummary
      })),
      capabilities: this.capabilities.resolve(agent.capabilityIds),
      constraints: [
        ...(brief?.constraints ?? []),
        ...decisionRecords.map((decision) => `Confirmed decision (${decision.kind}): ${decision.content}`)
      ],
      budget: buildBudget(session)
    };
    if (task?.fileRevisionId) {
      const fileRevisions = this.requireFileRevisions();
      const revisionRun = fileRevisions.getRun(session.id, task.fileRevisionId);
      const revisionEvidence = fileRevisions.evidence(session.id, task.fileRevisionId);
      contextAssembly.fileRevisionEvidence = [revisionEvidence];
      contextAssembly.systemRules = [
        ...contextAssembly.systemRules,
        'For a file-revision task, ContextEnvelopeV2.L3.fileRevisions is the authoritative immutable evidence.',
        'Treat userDraft.content as the current user-authoritative input; base.content and diff.hunks are comparison evidence only.',
        'Do not write the live source file. Return a complete Runtime file-change proposal for the exact revision filePath.',
        ...(task.executionPurpose === 'revision_synthesis'
          ? ['Semantically synthesize the hydrated agentResults proposals without weakening explicit user revisions.']
          : [])
      ];
      contextAssembly.constraints = [
        ...contextAssembly.constraints,
        `File revision id: ${revisionEvidence.revisionId}`,
        `Exact target path: ${revisionEvidence.filePath}`,
        `Expected user-draft SHA-256: ${revisionEvidence.userDraft.hash.value}`,
        `Revision chain id: ${revisionEvidence.chainId}`,
        `Revision iteration: ${revisionEvidence.iteration}`,
        `Frozen evidence hash: ${revisionEvidence.evidenceHash}`,
        ...(revisionRun.instruction
          ? [`User processing instruction: ${revisionRun.instruction}`]
          : [])
      ];
    }
    return contextAssembly;
  }

  private workflowSubstitutionCandidates(session: SessionDetail, attemptedAgentIds: Set<string>) {
    const participantIds = new Set(session.participatingAgentIds);
    return this.agents
      .listForSurface('workflow')
      .filter((agent) => participantIds.has(agent.id))
      .filter((agent) => !attemptedAgentIds.has(agent.id))
      .filter((agent) => !['coordinator', 'notification'].includes(agent.key))
      .map(({ id, key, name, role }) => ({ id, key, name, role }));
  }

  private createWorkItemContextSlice(session: SessionDetail, workItemId?: string): WorkItemContextSlice {
    if (!this.contextManagement ||
      typeof this.contextManagement.buildWorkItemContextSlice !== 'function' ||
      typeof this.memories.list !== 'function' ||
      typeof this.artifacts.listBySession !== 'function' ||
      typeof this.events.list !== 'function') {
      if (workItemId) {
        return {
          decisions: [],
          tasks: [],
          events: [],
          memories: [],
          artifacts: [],
          inheritedDecisionIds: [],
          inheritedArtifactIds: []
        };
      }
      const tasks = typeof this.tasks.list === 'function' ? this.tasks.list(session.id) : [];
      const events = typeof this.events.list === 'function' ? this.events.list(session.id) : [];
      const memories = typeof this.memories.list === 'function' ? this.memories.list(session.id) : [];
      const artifacts = typeof this.artifacts.listBySession === 'function' ? this.artifacts.listBySession(session.id) : [];
      return {
        decisions: [],
        tasks,
        events,
        memories,
        artifacts,
        inheritedDecisionIds: [],
        inheritedArtifactIds: []
      };
    }
    return this.contextManagement.buildWorkItemContextSlice({
      session,
      workItemId,
      tasks: this.tasks.list(session.id),
      events: this.events.list(session.id),
      memories: this.memories.list(session.id),
      artifacts: this.artifacts.listBySession(session.id)
    });
  }

  async hydrateSupplementalContext(
    session: SessionDetail,
    requestedContext: RuntimeContextRequest,
    options: { deadlineMs?: number; maxOperations?: number; maxContentBytes?: number; workItemId?: string } = {}
  ): Promise<SupplementalContextResolution> {
    const contextSlice = this.contextManagement &&
      typeof this.contextManagement.buildWorkItemContextSlice === 'function' &&
      typeof this.memories.list === 'function' &&
      typeof this.artifacts.listBySession === 'function' &&
      typeof this.events.list === 'function'
      ? this.createWorkItemContextSlice(session, options.workItemId ?? session.activeWorkItemId)
      : (options.workItemId ?? session.activeWorkItemId)
        ? { decisions: [], tasks: [], events: [], memories: [], artifacts: [], inheritedDecisionIds: [], inheritedArtifactIds: [] }
        : undefined;
    const fileRequests: RuntimeContextFileRequest[] = [
      ...(requestedContext.requestedFiles ?? []),
      ...(requestedContext.requestedPaths ?? []).map((path) => ({ path }))
    ];
    const requestedFiles = Array.from(new Map<string, RuntimeContextFileRequest>(fileRequests
      .filter((item) => item.path?.trim()).map((item) => [
      JSON.stringify([item.path.trim(), item.startLine ?? null, item.endLine ?? null, item.maxBytes ?? null]),
      { ...item, path: item.path.trim() }
    ])).values()).slice(0, 32);
    const requestedRefs = Array.from(new Map((requestedContext.requestedRefs ?? []).map((ref) => [
      `${ref.type}:${ref.ref ?? ref.label}`,
      ref
    ])).values()).slice(0, 16);
    const resolvedRefs: TaskEvidenceRef[] = [];
    const failedRefs: NonNullable<SupplementalContextResolution['failedRefs']> = [];
    const requestedDirectories = Array.from(
      new Map((requestedContext.requestedDirectories ?? []).map((item) => [`${item.path}:${item.depth ?? 1}`, item])).values()
    ).slice(0, 8);
    const requestedSearches = Array.from(
      new Map((requestedContext.requestedSearches ?? []).map((item) => [JSON.stringify(item), item])).values()
    ).slice(0, 8);
    const hydratedPaths: string[] = [];
    const listedDirectories: string[] = [];
    const completedSearches: string[] = [];
    const evidenceRevisions: NonNullable<SupplementalContextResolution['evidenceRevisions']> = {};
    const failedPaths: SupplementalContextResolution['failedPaths'] = [];
    let contentBytes = 0;
    for (const requestedRef of requestedRefs) {
      const resolved = this.resolveSupplementalEvidenceRef(session, requestedRef, contextSlice);
      if ('failure' in resolved) {
        failedRefs.push(resolved.failure);
        continue;
      }
      resolvedRefs.push(resolved.ref);
      contentBytes += resolved.contentBytes;
    }
    const provider = this.workspaceProviders?.resolve(session);
    const files = [...(session.workspaceSnapshot?.files ?? [])];
    const maxOperations = Math.min(8, Math.max(1, Math.floor(options.maxOperations ?? 8)));
    const maxContentBytes = Math.min(512 * 1024, Math.max(1, Math.floor(options.maxContentBytes ?? 512 * 1024)));
    const deadlineMs = Math.min(
      this.supplementalContextDeadlineMs(),
      Math.max(1, Math.floor(options.deadlineMs ?? this.supplementalContextDeadlineMs()))
    );
    const deadlineAt = Date.now() + deadlineMs;
    const currentRevision = provider?.capabilities().read
      ? await this.withSupplementalDeadline(provider.getRevision(), deadlineAt).catch(() => undefined)
      : undefined;
    const operations = [
      ...requestedFiles.map((file) => ({ kind: 'file' as const, path: file.path, file })),
      ...requestedDirectories.map((directory) => ({ kind: 'directory' as const, directory })),
      ...requestedSearches.map((search) => ({ kind: 'search' as const, search }))
    ];
    let attemptedCount = 0;
    const storeEvidence = (
      path: string,
      content: string,
      summary: string,
      revision?: WorkspaceRevision
    ): boolean => {
      const remaining = maxContentBytes - contentBytes;
      if (remaining <= 0) return false;
      const raw = Buffer.from(content, 'utf8');
      const selected = raw.byteLength > remaining ? raw.subarray(0, remaining).toString('utf8') : content;
      const size = Buffer.byteLength(selected, 'utf8');
      const existingIndex = files.findIndex((file) => file.path === path);
      const next = {
        path,
        size,
        content: selected,
        summary: raw.byteLength > remaining ? `${summary} (truncated).` : summary,
        ...(revision ? { revision } : {})
      };
      if (existingIndex >= 0) files[existingIndex] = { ...files[existingIndex], ...next };
      else files.push(next);
      if (revision) evidenceRevisions[path] = revision;
      contentBytes += size;
      return size > 0;
    };
    for (const operation of operations.slice(0, maxOperations)) {
      if (Date.now() >= deadlineAt) {
        attemptedCount += 1;
        const path = operation.kind === 'file'
          ? operation.path
          : operation.kind === 'directory'
            ? operation.directory.path
            : `search:${operation.search.query}`;
        failedPaths.push({
          path,
          code: 'DEADLINE_EXCEEDED',
          retryable: false,
          message: 'Supplemental workspace context deadline exceeded.'
        });
        break;
      }
      if (contentBytes >= maxContentBytes) break;
      attemptedCount += 1;
      if (operation.kind === 'file') {
        const existing = files.find((file) =>
          file.path === operation.path &&
          Boolean(file.content) &&
          Boolean(currentRevision && file.revision?.id === currentRevision.id) &&
          (operation.file.startLine === undefined || file.startLine === operation.file.startLine) &&
          (operation.file.endLine === undefined || file.endLine === operation.file.endLine)
        );
        if (existing?.content) {
          hydratedPaths.push(operation.path);
          evidenceRevisions[operation.path] = existing.revision!;
          contentBytes = Math.min(maxContentBytes, contentBytes + Buffer.byteLength(existing.content, 'utf8'));
          continue;
        }
      }
      if (!provider || !provider.capabilities().read) {
        const path = operation.kind === 'file'
          ? operation.path
          : operation.kind === 'directory'
            ? operation.directory.path
            : `search:${operation.search.query}`;
        failedPaths.push({ path, code: 'READ_UNAVAILABLE', retryable: true, message: 'Workspace provider is unavailable or does not grant read access.' });
        continue;
      }
      try {
        if (operation.kind === 'file') {
          const path = operation.path;
          const read = await this.readStableWorkspaceEvidence(
            provider,
            operation.file,
            Math.min(operation.file.maxBytes ?? 64 * 1024, maxContentBytes - contentBytes),
            deadlineAt
          );
          if (!read.content) {
            failedPaths.push({ path, code: 'READ_ERROR', retryable: false, message: 'Workspace file is empty.' });
            continue;
          }
          if (storeEvidence(
            read.path,
            read.content,
            read.truncated ? 'Supplemental workspace read (truncated).' : 'Supplemental workspace read.',
            read.revision
          )) {
            const stored = files.find((file) => file.path === read.path);
            if (stored) Object.assign(stored, {
              hash: read.hash ?? read.rangeHash,
              revision: read.revision,
              ...(read.startLine ? { startLine: read.startLine } : {}),
              ...(read.endLine ? { endLine: read.endLine } : {})
            });
            hydratedPaths.push(read.path);
          }
          continue;
        }
        if (operation.kind === 'directory') {
          const { path, depth = 1 } = operation.directory;
          const listed = await this.withSupplementalDeadline(provider.listDirectory({
            path,
            recursive: depth > 0,
            maxDepth: Math.min(4, Math.max(0, depth)),
            limit: 500,
            deadlineMs: Math.max(1, deadlineAt - Date.now())
          }), deadlineAt);
          const content = JSON.stringify(listed.entries.map((entry) => ({
            path: entry.path,
            kind: entry.kind,
            ...(entry.kind === 'file' ? { size: entry.size, language: entry.language } : {})
          })), null, 2);
          const evidencePath = `${path.replace(/\/+$/, '') || '.'}/`;
          if (storeEvidence(evidencePath, content, 'Supplemental workspace directory listing.', listed.revision)) {
            const normalized = path.replace(/\/+$/, '') || '.';
            listedDirectories.push(path);
            hydratedPaths.push(evidencePath);
          }
          continue;
        }
        const signature = JSON.stringify([
          operation.search.query,
          operation.search.path ?? '.',
          operation.search.include ?? [],
          operation.search.exclude ?? []
        ]);
        const searched = await this.withSupplementalDeadline(provider.searchText({
          ...operation.search,
          maxResults: 100,
          deadlineMs: Math.max(1, deadlineAt - Date.now())
        }), deadlineAt);
        const evidencePath = `search:${operation.search.query}`;
        const content = JSON.stringify(searched.matches, null, 2);
        if (storeEvidence(
          evidencePath,
          content || '[]',
          searched.truncated ? 'Supplemental workspace search (truncated).' : 'Supplemental workspace search.',
          searched.revision
        )) {
          completedSearches.push(signature);
          hydratedPaths.push(evidencePath);
        }
      } catch (error) {
        const path = operation.kind === 'file'
          ? operation.path
          : operation.kind === 'directory'
            ? operation.directory.path
            : `search:${operation.search.query}`;
        failedPaths.push(this.supplementalPathFailure(path, error));
      }
    }
    const deferredPaths = operations.slice(attemptedCount).map((operation) => operation.kind === 'file'
      ? operation.path
      : operation.kind === 'directory'
        ? `${operation.directory.path}/`
        : `search:${operation.search.query}`);
    const snapshot = session.workspaceSnapshot ?? {
      rootName: session.workingDirectory?.name ?? 'workspace',
      scannedAt: nowIso(),
      fileCount: 0,
      totalBytes: 0,
      tree: [],
      files: [],
      skipped: []
    };
    const boundedFiles = this.boundWorkspaceEvidenceCache(
      files,
      hydratedPaths,
      currentRevision,
      32,
      maxContentBytes
    );
    session.workspaceSnapshot = {
      ...snapshot,
      files: boundedFiles,
      fileCount: Math.max(snapshot.fileCount, boundedFiles.length),
      entrypoints: session.workspaceIndex?.entrypoints ?? snapshot.entrypoints,
      detectedStack: this.uniqueFirstStrings([
        ...(session.workspaceIndex?.detectedStack ?? []),
        ...detectWorkspaceStack(boundedFiles)
      ], 16)
    };
    return {
      requestedFiles,
      hydratedPaths,
      resolvedRefs,
      failedRefs,
      evidenceRevisions,
      listedDirectories,
      completedSearches,
      failedPaths,
      deferredPaths,
      contentBytes,
      outcome: hydratedPaths.length + resolvedRefs.length === 0
        ? 'exhausted'
        : failedPaths.length + failedRefs.length + deferredPaths.length > 0
          ? 'partial'
          : 'resolved',
      attempt: 1,
      maxAttempts: 1
    };
  }

  private boundWorkspaceEvidenceCache(
    files: NonNullable<SessionDetail['workspaceSnapshot']>['files'],
    preferredPaths: string[],
    currentRevision: WorkspaceRevision | undefined,
    maxFiles: number,
    maxContentBytes: number
  ) {
    const preferred = new Set(preferredPaths);
    const ordered = [...files].sort((left, right) => Number(preferred.has(right.path)) - Number(preferred.has(left.path)));
    const bounded: typeof files = [];
    const seen = new Set<string>();
    let contentBytes = 0;
    for (const file of ordered) {
      if (bounded.length >= maxFiles || seen.has(file.path)) continue;
      seen.add(file.path);
      const stale = Boolean(file.content && currentRevision && file.revision?.id !== currentRevision.id);
      const { content: originalContent, ...metadata } = file;
      if (!originalContent || stale || contentBytes >= maxContentBytes) {
        bounded.push({
          ...metadata,
          ...(stale ? { summary: 'Cached content omitted because the workspace revision changed.' } : {})
        });
        continue;
      }
      const remaining = maxContentBytes - contentBytes;
      const raw = Buffer.from(originalContent, 'utf8');
      const selected = raw.subarray(0, remaining).toString('utf8');
      contentBytes += Buffer.byteLength(selected, 'utf8');
      bounded.push({
        ...metadata,
        content: selected,
        ...(raw.byteLength > remaining ? { summary: `${file.summary ?? 'Cached workspace evidence'} (truncated).` } : {})
      });
    }
    return bounded;
  }

  private supplementalContextDeadlineMs(): number {
    const configured = Number(process.env.AGENT_CLUSTER_SUPPLEMENTAL_CONTEXT_DEADLINE_MS ?? 10_000);
    return Number.isFinite(configured) ? Math.max(1, Math.min(10_000, Math.floor(configured))) : 10_000;
  }

  private async withSupplementalDeadline<T>(operation: Promise<T>, deadlineAt: number): Promise<T> {
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WORKSPACE_CONTEXT_DEADLINE_EXCEEDED')), remainingMs);
      operation.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }

  private async readStableWorkspaceEvidence(
    provider: NonNullable<ReturnType<WorkspaceProviderResolver['resolve']>>,
    request: RuntimeContextFileRequest,
    maxBytes: number,
    deadlineAt: number
  ) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const read = await this.withSupplementalDeadline(provider.readFile({ ...request, maxBytes }), deadlineAt);
      const currentRevision = await this.withSupplementalDeadline(provider.getRevision(), deadlineAt);
      if (read.revision.id === currentRevision.id) return read;
    }
    const error = new Error('Workspace revision changed repeatedly while reading evidence.');
    Object.assign(error, { code: 'WORKSPACE_REVISION_UNSTABLE' });
    throw error;
  }

  private hasUsableSupplementalContext(
    session: SessionDetail,
    requestedContext: RuntimeContextRequest,
    resolution: SupplementalContextResolution,
    contextSlice?: WorkItemContextSlice
  ) {
    if (resolution.hydratedPaths.length) return true;
    if (resolution.resolvedRefs) return resolution.resolvedRefs.length > 0;
    return requestedContext.requestedRefs.some((ref) => Boolean(ref.ref && this.selectedEvidenceContent(session, ref, contextSlice)));
  }

  private resolveSupplementalEvidenceRef(
    session: SessionDetail,
    evidence: TaskEvidenceRef,
    contextSlice?: WorkItemContextSlice
  ): { ref: TaskEvidenceRef; contentBytes: number } | { failure: NonNullable<SupplementalContextResolution['failedRefs']>[number] } {
    const failure = (
      code: NonNullable<SupplementalContextResolution['failedRefs']>[number]['code'],
      message: string,
      retryable = false
    ) => ({ failure: { type: evidence.type, label: evidence.label, ...(evidence.ref ? { ref: evidence.ref } : {}), code, retryable, message } });
    const measure = (ref: TaskEvidenceRef) => {
      const content = this.selectedEvidenceContent(session, ref, contextSlice);
      if (!content?.content && !content?.summary) return undefined;
      return { ref, contentBytes: Buffer.byteLength(content.content ?? content.summary ?? '', 'utf8') };
    };
    if (evidence.ref) {
      return measure(evidence) ?? failure('NOT_FOUND', `Evidence reference was not found: ${evidence.ref}`);
    }
    const direct = measure(evidence);
    if (direct) return direct;
    const normalizedLabel = evidence.label.trim().toLocaleLowerCase();
    const candidates: TaskEvidenceRef[] = [];
    if (evidence.type === 'artifact' || evidence.type === 'diff') {
      for (const artifact of this.artifacts.listBySession(session.id)) {
        if (contextSlice && !contextSlice.artifacts.some((item) => item.id === artifact.id)) continue;
        if (artifact.title.trim().toLocaleLowerCase() === normalizedLabel) {
          candidates.push({ ...evidence, ref: artifact.id });
        }
      }
    } else if (evidence.type === 'memory') {
      for (const memory of this.memories.list(session.id)) {
        if (contextSlice && !contextSlice.memories.some((item) => item.id === memory.id)) continue;
        if (memory.content.trim().toLocaleLowerCase() === normalizedLabel) {
          candidates.push({ ...evidence, ref: memory.id });
        }
      }
    } else if (evidence.type === 'event_log' || evidence.type === 'historical_decision' || evidence.type === 'log') {
      for (const event of this.events.list(session.id)) {
        if (contextSlice && !contextSlice.events.some((item) => item.id === event.id)) continue;
        const labels = [event.content, event.metadata?.title, event.metadata?.summary]
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim().toLocaleLowerCase());
        if (labels.includes(normalizedLabel)) candidates.push({ ...evidence, ref: event.id });
      }
    }
    if (candidates.length === 0) {
      return failure('INVALID_REFERENCE', `Evidence request requires a valid ref or one unique exact label match: ${evidence.label}`, true);
    }
    if (candidates.length > 1) {
      return failure('AMBIGUOUS_REFERENCE', `Evidence label matched ${candidates.length} records: ${evidence.label}`, true);
    }
    return measure(candidates[0]) ?? failure('READ_ERROR', `Evidence content is empty: ${evidence.label}`);
  }

  private supplementalPathFailure(
    path: string,
    error: unknown
  ): SupplementalContextResolution['failedPaths'][number] {
    const rawCode =
      error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
    const message = error instanceof Error ? error.message : String(error);
    const signal = `${rawCode} ${message}`.toUpperCase();
    let code: SupplementalContextPathFailureCode = 'READ_ERROR';
    let retryable = true;
    if (
      signal.includes('NOT_FOUND') ||
      signal.includes('NOTFOUND') ||
      signal.includes('ENOENT') ||
      signal.includes('COULD NOT BE FOUND') ||
      signal.includes('WORKSPACE_FILE_NOT_FOUND')
    ) {
      code = 'NOT_FOUND';
      retryable = false;
    } else if (
      signal.includes('PERMISSION') ||
      signal.includes('DENIED') ||
      signal.includes('EACCES') ||
      signal.includes('NOTALLOWED') ||
      signal.includes('SECURITYERROR')
    ) {
      code = 'PERMISSION_REQUIRED';
    } else if (signal.includes('WORKSPACE_REVISION_UNSTABLE')) {
      code = 'WORKSPACE_REVISION_UNSTABLE';
      retryable = false;
    } else if (signal.includes('DEADLINE_EXCEEDED') || signal.includes('LOOKUP_TIMEOUT')) {
      code = 'DEADLINE_EXCEEDED';
      retryable = false;
    } else if (signal.includes('BROKER') || signal.includes('TIMEOUT') || signal.includes('DISCONNECT')) {
      code = 'BROKER_OFFLINE';
    }
    return { path, code, retryable, message };
  }

  private runtimeWorkspaceSnapshot(snapshot: SessionDetail['workspaceSnapshot']): SessionDetail['workspaceSnapshot'] {
    if (!snapshot) return undefined;
    return {
      ...snapshot,
      files: snapshot.files.map((file) => this.workspaceFileWithoutRuntimeContent(file))
    };
  }

  private workspaceFileWithoutRuntimeContent(file: NonNullable<SessionDetail['workspaceSnapshot']>['files'][number]) {
    const { content: _content, ...rest } = file;
    return {
      ...rest,
      contentLength: file.content?.length,
      summary:
        file.summary ??
        (file.content ? `Content omitted from workspaceSnapshot; selected evidence content is injected separately.` : undefined)
    };
  }

  private createSelectedEvidenceContents(session: SessionDetail, taskContext: TaskContext, workItemId?: string): ContextAssembly['selectedEvidenceContents'] {
    const contextSlice = this.createWorkItemContextSlice(session, workItemId ?? session.activeWorkItemId);
    const contents: NonNullable<ContextAssembly['selectedEvidenceContents']> = [];
    for (const evidence of taskContext.evidenceRefs) {
      const entry = this.selectedEvidenceContent(session, evidence, contextSlice);
      if (!entry) continue;
      contents.push({
        ...entry,
        type: evidence.type,
        label: evidence.label,
        ref: evidence.ref,
        tokenEstimate: Math.max(1, Math.ceil(JSON.stringify(entry).length / 4)),
        selectionReason: evidence.selectionReason
      });
    }
    return contents;
  }

  private selectedEvidenceContent(
    session: SessionDetail,
    evidence: TaskContext['evidenceRefs'][number],
    contextSlice?: WorkItemContextSlice
  ): Omit<NonNullable<ContextAssembly['selectedEvidenceContents']>[number], 'type' | 'label' | 'ref' | 'tokenEstimate' | 'selectionReason'> | undefined {
    const ref = evidence.ref;
    if (evidence.type === 'workspace_snapshot') {
      return {
        source: 'workspace_manifest',
        summary: session.workspaceIndex
          ? `${session.workingDirectory?.name ?? 'workspace'}: metadata index generation ${session.workspaceIndex.generation}, ${session.workspaceIndex.indexedEntries} indexed entries, status ${session.workspaceIndex.status}.`
          : session.workspaceSnapshot
            ? `${session.workspaceSnapshot.rootName}: ${session.workspaceSnapshot.files.length} readable files, ${session.workspaceSnapshot.skipped.length} skipped.`
            : undefined
      };
    }
    if ((evidence.type === 'workspace_file' || evidence.type === 'test' || evidence.type === 'workspace_symbol') && ref) {
      const file = session.workspaceSnapshot?.files.find((item) => item.path === ref);
      if (!file) return undefined;
      return this.workspaceEvidenceContent(file);
    }
    if (evidence.type === 'memory' && ref) {
      const memory = this.memories.list(session.id).find((item) => item.id === ref);
      if (contextSlice && !contextSlice.memories.some((item) => item.id === ref)) return undefined;
      return memory
        ? {
            source: 'memory',
            content: memory.content,
            contentLength: memory.content.length
          }
        : undefined;
    }
    if ((evidence.type === 'document_fragment' || evidence.type === 'meeting_note' || evidence.type === 'data_table' || evidence.type === 'external_reference') && ref) {
      const chunk = (session.knowledgeBaseIds ?? [])
        .flatMap((knowledgeBaseId) => this.knowledge.search(knowledgeBaseId, evidence.label))
        .find((item) => item.chunkId === ref);
      return chunk
        ? {
            source: 'rag',
            content: chunk.snippet,
            summary: chunk.title,
            contentLength: chunk.snippet.length
          }
        : undefined;
    }
    if ((evidence.type === 'artifact' || evidence.type === 'diff') && ref) {
      const artifact = this.artifacts.listBySession(session.id).find((item) => {
        if (contextSlice && !contextSlice.artifacts.some((candidate) => candidate.id === item.id)) return false;
        const workspaceChanges = this.artifactWorkspaceChanges(item);
        return item.id === ref || workspaceChanges.some((change) =>
          change.operation === 'move'
            ? change.fromPath === ref || change.toPath === ref
            : change.path === ref
        );
      });
      const content = artifact ? this.artifactEvidenceContent(artifact) : undefined;
      return artifact
        ? {
            source: 'artifact',
            summary: artifact.contentSummary,
            content,
            contentLength: content?.length ?? 0
          }
        : undefined;
    }
    if ((evidence.type === 'event_log' || evidence.type === 'historical_decision' || evidence.type === 'log') && ref) {
      if (contextSlice && !contextSlice.events.some((item) => item.id === ref)) return undefined;
      const event = this.events.list(session.id).find((item) => item.id === ref);
      if (!event || typeof event.content !== 'string' || !event.content.trim()) return undefined;
      return {
        source: 'event',
        content: event.content,
        summary: event.type,
        contentLength: event.content.length
      };
    }
    if (evidence.type === 'project_map') {
      return {
        source: 'project_map',
        summary: evidence.label
      };
    }
    return undefined;
  }

  private workspaceEvidenceContent(file: NonNullable<SessionDetail['workspaceSnapshot']>['files'][number]) {
    const maxChars = 8_000;
    const content = file.content ?? file.summary ?? '';
    const truncation = truncateContentForEvidence(file.path, content, maxChars);
    return {
      source: 'workspace_file' as const,
      content: truncation.content,
      summary: file.summary,
      contentLength: content.length,
      truncated: truncation.truncated,
      ...(file.hash ? { hash: file.hash } : {}),
      ...(file.revision ? { revision: file.revision } : {}),
      ...(file.startLine ? { startLine: file.startLine } : {}),
      ...(file.endLine ? { endLine: file.endLine } : {}),
      ...(truncation.truncatedHint ? { truncatedHint: truncation.truncatedHint } : {})
    };
  }

  private artifactWorkspaceChanges(artifact: Artifact) {
    return artifact.systemEvidence?.workspaceChangeSet?.changes ?? [];
  }

  private artifactEvidenceContent(artifact: Artifact) {
    const raw = JSON.stringify({
      title: artifact.title,
      summary: artifact.contentSummary,
      runtimeProposals: artifact.runtimeProposals,
      workspaceChanges: this.artifactWorkspaceChanges(artifact)
    }, null, 2);
    return truncateContentForEvidence(`artifact:${artifact.id}`, raw, 16_000).content;
  }

  private createTaskContext(
    session: SessionDetail,
    brief: TaskBrief | undefined,
    task: AgentTask | undefined,
    phase: AgentRunPhase,
    relevantMemories: ContextAssembly['relevantMemories'],
    ragSnippets: ContextAssembly['ragSnippets']
  ): TaskContext {
    const domain = session.taskDomain ?? (session.workingDirectory ? 'mixed' : 'non_coding');
    const intent = session.taskIntent ?? (brief ? 'implementation' : 'analysis');
    const artifacts = this.artifacts.listBySession(session.id);
    const dependencyArtifacts = task ? this.taskDependencyArtifacts(session, task) : [];
    const otherArtifacts = artifacts.filter((artifact) => !dependencyArtifacts.some((item) => item.id === artifact.id));
    const evidenceArtifacts = [...otherArtifacts.slice(-6), ...dependencyArtifacts];
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
      ...(session.workspaceSnapshot || session.workspaceIndex
        ? [{ type: 'workspace_snapshot' as const, label: session.workingDirectory?.name ?? session.workspaceSnapshot?.rootName ?? 'workspace', ref: session.workingDirectory?.name }]
        : []),
      ...workspaceEvidenceFiles.map((path) => ({
        type: 'workspace_file' as const,
        label: path,
        ref: path
      })),
      ...(workspaceFocus?.possibleEntryPoints ?? session.workspaceIndex?.entrypoints ?? session.workspaceSnapshot?.entrypoints ?? []).slice(0, 6).map((entrypoint) => ({
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
      ...evidenceArtifacts.map((artifact) => ({
        type:
          dependencyArtifacts.some((item) => item.id === artifact.id)
            ? ('artifact' as const)
            : artifact.type === 'test_report'
            ? ('test' as const)
            : artifact.type === 'code_diff'
              ? ('diff' as const)
              : domain === 'non_coding'
                ? ('document_fragment' as const)
                : ('artifact' as const),
        label: artifact.title,
        ref: artifact.id,
        ...(dependencyArtifacts.some((item) => item.id === artifact.id)
          ? { selectionReason: 'Upstream task dependency.' }
          : {})
      })),
      ...artifacts.flatMap((artifact) => this.artifactFileChangeEvidence(artifact)),
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
      requiresCodeChanges: session.requiresCodeChanges ?? intent === 'implementation',
      requiresExternalEvidence: Boolean(artifacts.length || recentEvents.length || session.knowledgeBaseIds?.length),
      validationRules,
      agentResponsibilities: this.createAgentResponsibilities(session, domain, task),
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
            label: 'Decide acceptance, blocked status, or rejection',
            refs: [taskRef],
            reason: 'Match currentTask to the agent responsibility; Coordinator remains the only routing writer.'
          }
        ];
      case 'task_execution':
      case 'revision_synthesis':
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
            reason: 'Follow the current phase boundary and Task Context Assembly.'
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

  private artifactFileChangeEvidence(artifact: Artifact): TaskContext['evidenceRefs'] {
    return this.artifactWorkspaceChanges(artifact)
      .slice(0, 12)
      .map((change) => {
        const ref = change.operation === 'move' ? change.toPath : change.path;
        const label = change.operation === 'move'
          ? `move: ${change.fromPath} -> ${change.toPath}`
          : `${change.operation}: ${change.path}`;
        return { type: 'diff' as const, label, ref };
      });
  }

  private taskDependencyArtifacts(session: SessionDetail, task: AgentTask) {
    if (!task.dependsOnTaskIds.length) return [];
    const dependencyTaskIds = new Set(task.dependsOnTaskIds);
    return this.artifacts
      .listBySession(session.id)
      .filter((artifact) => Boolean(artifact.taskId && dependencyTaskIds.has(artifact.taskId)));
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
    if (ref.selectionReason?.startsWith('Upstream task dependency')) {
      score += 100;
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

  private createAgentResponsibilities(
    session: SessionDetail,
    domain: TaskContext['domain'],
    task?: AgentTask
  ): TaskContext['agentResponsibilities'] {
    const agents = this.participatingAgents(session);
    const choose = (preferredKeys: string[], fallback: string) =>
      agents.find((agent) => preferredKeys.includes(agent.key))?.key ?? fallback;
    const assignedAgentId = agentIdFromActor(task?.assignee);
    const assignedAgentKey = assignedAgentId
      ? agents.find((agent) => agent.id === assignedAgentId)?.key
      : undefined;
    const taskText = `${task?.title ?? ''} ${task?.description ?? ''}`;
    const isPlanningTask = /plan|planning|requirement|analysis|scope|需求|计划|规划|分析|范围/i.test(taskText);
    const shouldUseAssignedAgent = Boolean(assignedAgentKey) && (domain === 'non_coding' || isPlanningTask);
    const executionKey =
      shouldUseAssignedAgent && assignedAgentKey
        ? assignedAgentKey
        : domain === 'non_coding'
        ? choose(['requirements', 'product-manager'], 'requirements')
        : choose(['backend', 'frontend', 'requirements'], 'backend');
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
    summaryMemory: SummaryMemory,
    contextSlice: WorkItemContextSlice
  ): ContextAssembly['continuationState'] {
    const tasks = contextSlice.tasks;
    const recentEvents = contextSlice.events.slice(-12);
    const recentArtifacts = contextSlice.artifacts.slice(-12);
    const checkpoint = this.latestSummaryMemoryCheckpoint(session.id, contextSlice.workItem?.id);
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
        ['task_assigned', 'task_accepted', 'task_claimed', 'task_blocked', 'task_reassigned', 'task_completed', 'task_reworked', 'post_review_completed', 'final_delivery_created'].includes(event.type)
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
      ContextAssembly['continuationState'],
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
    phase: AgentRunPhase,
    contextSlice: WorkItemContextSlice
  ): SummaryMemory {
    const prior = this.latestSummaryMemoryCheckpoint(session.id, contextSlice.workItem?.id);
    const tasks = contextSlice.tasks;
    const completed = tasks.filter((item) => item.status === 'completed').map((item) => item.title).slice(0, 6);
    const recentEvents = contextSlice.events.slice(-8);
    const recentArtifactIds = contextSlice.artifacts.slice(-8).map((artifact) => artifact.id);
    const confirmedFacts = [
      `Session status: ${session.status}`,
      `Current stage: ${phase}`,
      ...(brief ? [`Brief v${brief.version}: ${brief.goal}`] : []),
      ...(session.workspaceIndex
        ? [`Workspace index: generation ${session.workspaceIndex.generation} (${session.workspaceIndex.status})`]
        : session.workspaceSnapshot
          ? [`Workspace snapshot: ${session.workspaceSnapshot.rootName}`]
          : []),
      ...((session.workspaceIndex?.detectedStack ?? session.workspaceSnapshot?.detectedStack)?.length
        ? [`Detected stack: ${(session.workspaceIndex?.detectedStack ?? session.workspaceSnapshot?.detectedStack ?? []).join(', ')}`]
        : [])
    ];
    const decisions = contextSlice.events
      .filter((event) => event.type === 'brief_created' || event.type === 'brief_confirmed' || event.type === 'post_review_completed')
      .map((event) => event.content)
      .slice(-4);
    const previous = prior?.checkpoint.summaryMemory;
    // 协商阶段(讨论/契约生成/修订)goal 回落到原始需求,不锚定上一版契约的旧
    // goal;否则用户修改契约后重新讨论时,summaryMemory 仍把旧目标带回上下文。
    const isBriefNegotiationPhase =
      phase === 'discussion' || phase === 'brief_generation' || phase === 'brief_revision';
    return {
      goal: brief?.goal ?? contextSlice.workItem?.goal ??
        (isBriefNegotiationPhase ? session.originalInput : previous?.goal ?? session.originalInput),
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
    const workItemId = task?.workItemId ?? brief?.workItemId ?? session.activeWorkItemId;
    const contextSlice = this.createWorkItemContextSlice(session, workItemId);
    const checkpointId = crypto.randomUUID();
    const sourceEventIds = contextSlice.events.slice(-12).map((event) => event.id);
    const sourceArtifactIds = contextSlice.artifacts.slice(-12).map((artifact) => artifact.id);
    const summaryMemory = this.createSummaryMemory(session, brief, task, phase, contextSlice);
    const memory = this.memories.create({
      sessionId: session.id,
      agentId: agent.id,
      workItemId,
      scope: 'session',
      content: this.summaryMemoryCheckpointText(checkpointId, phase, summaryMemory),
      confidence: 0.94
    });
    const checkpoint: SummaryMemoryCheckpoint = {
      kind: 'summary_memory_checkpoint',
      checkpointId,
      sessionId: session.id,
      workItemId,
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
      workItemId,
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
      workItemId,
      type: 'artifact_created',
      taskId: task?.id,
      fromAgentId: agent.id,
      content: messages.artifactCreated(artifact.title),
      metadata: createMetadata('artifact_card', {
        artifactId: artifact.id,
        type: artifact.type,
        title: artifact.title,
        contentSummary: artifact.contentSummary,
        phase: 'summary_memory_checkpoint',
        visibility: 'internal',
        checkpointId,
        memoryId: memory.id
      })
    });
    return { artifact, memory, checkpoint };
  }

  private latestSummaryMemoryCheckpoint(sessionId: string, workItemId?: string) {
    const artifacts = this.artifacts.listBySession(sessionId);
    for (let index = artifacts.length - 1; index >= 0; index -= 1) {
      const artifact = artifacts[index];
      if (artifact.workItemId !== workItemId) continue;
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
    return this.projectMap.workspaceFocus(session);
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

  private invocationWorkspace(session: SessionDetail) {
    const provider = this.workspaceProviders?.resolve(session);
    if (provider) {
      return {
        workspaceId: session.workspaceId,
        providerKind: provider.kind,
        capabilities: provider.capabilities()
      };
    }
    return {
      workspaceId: session.workspaceId,
      providerKind: workspaceProviderKindForDirectory(session.workingDirectory?.kind),
      capabilities: { read: false, write: false, command: false, test: false }
    };
  }

  private async runRuntime(inputSession: SessionDetail, input: RuntimeInvocationDraft, signal?: AbortSignal) {
    if (!input.operation && this.runtime.operations) {
      const scopeKey = JSON.stringify([input.phase, input.agent.id, input.contextAssembly.workItemId ?? inputSession.activeWorkItemId,
        input.taskId, input.contextAssembly.currentContractGoal ?? input.contextAssembly.sessionGoal]);
      const paused = this.runtime.operations.findResumable(input.sessionId, scopeKey);
      const operation = paused ? await this.runtime.operations.resume(input.sessionId, paused.id)
        : await this.runtime.operations.begin({ id: input.invocationId,
          sessionId: input.sessionId, taskId: input.taskId, phase: input.phase, scopeKey });
      input = { ...input, operation };
    }
    let contextRetryCount = 0;
    let supplementalContextDurationMs = 0;
    let draft = input;
    while (true) {
      const result = await this.runRuntimeProviderAttempts(inputSession, draft, signal);
      if (!this.lifecycle.isActive(inputSession.id, draft.operation?.sessionGeneration)) {
        throw new Error('SESSION_ADMISSION_CLOSED');
      }
      if (result.status === 'completed' || result.status === 'cancelled' || signal?.aborted) return result;
      if (!draft.submissionRepair && draft.phase === 'task_execution' && draft.writeModeOverride !== 'proposal_only' &&
        result.error?.code === 'RUNTIME_OUTPUT_CONTRACT_VIOLATION' && result.executionCandidate?.schemaErrors?.length &&
        !result.error.details?.stopUnconfirmed && result.runtimeType === 'claude_code' &&
        result.executionCandidate.originalSubmission && result.executionCandidate.outputVersion === '2.0') {
        if (!draft.operation || !this.runtime.operations ||
          !await this.runtime.operations.reserveCorrection(inputSession.id, draft.operation.id)) return result;
        this.events.create({ sessionId: inputSession.id, type: 'runtime_progress',
          fromAgentId: draft.agent.id, toAgentIds: [], content: '已保存修改，正在修复结果提交格式。',
          metadata: createMetadata('system_notice', { code: 'SUBMISSION_REPAIR_STARTED',
            operationId: draft.operation?.id, runtimeInvocationId: draft.invocationId,
            candidateId: result.executionCandidate.id, phase: draft.phase }) });
        draft = { ...draft, invocationId: crypto.randomUUID(), submissionRepair: true,
          recoveryCandidate: result.executionCandidate };
        continue;
      }
      const requestedContext = result.error?.requestedContext;
      const novelContext = this.resolveRetryRequest(
        inputSession,
        result.error?.code,
        requestedContext,
        contextRetryCount
      );
      if (!novelContext) {
        if (result.error?.code === 'CONTEXT_INSUFFICIENT') {
          workspaceMetrics.increment('context_insufficient_terminal_total', 1, { phase: draft.phase });
        }
        return result;
      }

      const supplementalStartedAt = Date.now();
      const task = draft.taskId ? this.tasks.find(inputSession.id, draft.taskId) : undefined;
      const workItemId = draft.contextAssembly.workItemId ?? task?.workItemId ?? inputSession.activeWorkItemId;
      const resolution = await this.hydrateSupplementalContext(inputSession, novelContext, { workItemId });
      const supplementalDurationMs = Date.now() - supplementalStartedAt;
      supplementalContextDurationMs += supplementalDurationMs;
      workspaceMetrics.observe('supplemental_context_duration_ms', supplementalDurationMs, { phase: draft.phase });
      workspaceMetrics.increment('supplemental_context_bytes_total', resolution.contentBytes, { phase: draft.phase });
      const unstableCount = resolution.failedPaths.filter((item) => item.code === 'WORKSPACE_REVISION_UNSTABLE').length;
      if (unstableCount) workspaceMetrics.increment('workspace_revision_unstable_total', unstableCount, { phase: draft.phase });
      this.recordSupplementalContextRequest(
        inputSession,
        task,
        draft.agent.id,
        novelContext,
        resolution,
        draft.phase
      );
      if (!this.hasUsableSupplementalContext(inputSession, novelContext, resolution)) {
        workspaceMetrics.increment('context_insufficient_terminal_total', 1, { phase: draft.phase });
        return result;
      }

      contextRetryCount += 1;
      workspaceMetrics.increment('supplemental_context_retry_total', 1, { phase: draft.phase });
      const selectedEvidenceContents = this.createSelectedEvidenceContents(
        inputSession,
        draft.contextAssembly.taskContext,
        workItemId
      ) ?? [];
      const selectedPaths = new Set(
        selectedEvidenceContents.map((item) => item.ref?.trim() || item.label.trim())
      );
      for (const evidenceRef of resolution.resolvedRefs ?? []) {
        const evidenceKey = evidenceRef.ref?.trim() || evidenceRef.label.trim();
        if (selectedPaths.has(evidenceKey)) continue;
        const evidence = this.selectedEvidenceContent(inputSession, evidenceRef, this.createWorkItemContextSlice(inputSession, workItemId));
        if (!evidence) continue;
        selectedEvidenceContents.push({
          ...evidence,
          type: evidenceRef.type,
          label: evidenceRef.label,
          ref: evidenceRef.ref,
          tokenEstimate: Math.max(1, Math.ceil(JSON.stringify(evidence).length / 4)),
          selectionReason: evidenceRef.selectionReason ?? `Requested by runtime during ${draft.phase}`
        });
        selectedPaths.add(evidenceKey);
      }
      for (const path of resolution.hydratedPaths) {
        if (selectedPaths.has(path)) continue;
        const file = inputSession.workspaceSnapshot?.files.find((item) => item.path === path && item.content);
        if (!file) continue;
        const evidence = this.workspaceEvidenceContent(file);
        selectedEvidenceContents.push({
          ...evidence,
          type: 'workspace_file',
          label: path,
          ref: path,
          tokenEstimate: Math.max(1, Math.ceil(JSON.stringify(evidence).length / 4)),
          selectionReason: `Requested by runtime during ${draft.phase}`
        });
        selectedPaths.add(path);
      }
      draft = {
        ...draft,
        invocationId: crypto.randomUUID(),
        supplementalContextAttempt: contextRetryCount,
        supplementalContextDurationMs,
        contextAssembly: {
          ...draft.contextAssembly,
          workspaceSnapshot: this.runtimeWorkspaceSnapshot(inputSession.workspaceSnapshot),
          workspaceManifest: buildWorkspaceManifest(inputSession.workspaceSnapshot),
          selectedEvidenceContents
        }
      };
    }
  }

  private async runRuntimeProviderAttempts(inputSession: SessionDetail, input: RuntimeInvocationDraft, signal?: AbortSignal) {
    const timeoutMs = input.operation ? Math.max(1, Date.parse(input.operation.deadlineAt) - Date.now()) : phaseTimeoutMs(input.phase);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => abortWithTermination(controller, createExecutionTermination({
      kind: 'phase_timeout', source: 'orchestrator', scope: 'phase', phase: input.phase,
      timeout: { mode: 'deadline', timeoutMs }
    })), timeoutMs) : undefined;
    try {
      return await this.runRuntimeProviderAttemptsWithinDeadline(inputSession, input, controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async runRuntimeProviderAttemptsWithinDeadline(inputSession: SessionDetail, input: RuntimeInvocationDraft, signal?: AbortSignal) {
    const attemptGroupId = input.invocationId;
    const excludedRuntimeTypes = new Set<RuntimeType>([
      ...(input.excludedRuntimeTypes ?? [])
    ]);
    let retryOfInvocationId: string | undefined;
    const preferredRuntimeType = inputSession.runtimePreference?.preferredRuntimeType;
    let fallbackFromRuntimeType = preferredRuntimeType && excludedRuntimeTypes.has(preferredRuntimeType)
      ? preferredRuntimeType
      : undefined;
    let fallbackReason = fallbackFromRuntimeType ? 'Provider circuit was already open.' : undefined;
    let runtimeCandidateOverride = fallbackFromRuntimeType
      ? this.nextAllowedRuntimeFallback(inputSession, excludedRuntimeTypes)
      : undefined;
    let sameRuntimeRetried = false;
    let lastResult: AgentRunResult | undefined;
    const maxAttempts = this.runtimeProviderMaxAttempts();

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const invocationId = attempt === 1 ? input.invocationId : crypto.randomUUID();
      const result = await this.runRuntimeAttempt(inputSession, {
        ...input,
        invocationId,
        excludedRuntimeTypes: [...excludedRuntimeTypes],
        runtimeCandidateOverride,
        attempt: {
          attemptGroupId,
          attempt,
          ...(retryOfInvocationId ? { retryOfInvocationId } : {}),
          ...(fallbackFromRuntimeType ? { fallbackFromRuntimeType } : {}),
          ...(fallbackReason ? { fallbackReason } : {}),
          ...(input.supplementalContextAttempt
            ? { supplementalContextAttempt: input.supplementalContextAttempt }
            : {}),
          ...(input.supplementalContextDurationMs !== undefined
            ? { supplementalContextDurationMs: input.supplementalContextDurationMs }
            : {})
        }
      }, signal);
      lastResult = result;
      if (result.status === 'completed' || result.status === 'cancelled' || signal?.aborted) return result;
      if (result.error?.details?.stopUnconfirmed || result.error?.details?.structuredOutputGuard || !this.isRetryableProviderFailure(result.error)) return result;

      if (!sameRuntimeRetried) {
        sameRuntimeRetried = true;
        retryOfInvocationId = invocationId;
        const delayMs = this.runtimeProviderRetryDelayMs(result.error);
        if (input.operation && delayMs >= Date.parse(input.operation.deadlineAt) - Date.now()) {
          return { ...result, error: { ...result.error!, retryable: false,
            details: { ...result.error?.details, operationFailure: 'OPERATION_BACKOFF_EXCEEDS_BUDGET' } } };
        }
        this.recordRuntimeProviderRetry(inputSession, input, result, attemptGroupId, attempt + 1, delayMs);
        await this.backoffRuntimeProviderRetry(delayMs, signal);
        if (signal?.aborted) return result;
        continue;
      }

      const failedRuntimeType = result.runtimeType;
      const circuitTtlMs = this.openRuntimeProviderCircuit(failedRuntimeType, result.error);
      excludedRuntimeTypes.add(failedRuntimeType);
      runtimeCandidateOverride = this.nextAllowedRuntimeFallback(inputSession, excludedRuntimeTypes);
      if (!runtimeCandidateOverride || attempt >= maxAttempts) {
        return result;
      }
      retryOfInvocationId = invocationId;
      fallbackFromRuntimeType = failedRuntimeType;
      fallbackReason = `${result.error?.code ?? 'MODEL_ERROR'} after retry; provider circuit open for ${circuitTtlMs}ms.`;
      this.recordRuntimeProviderFallback(inputSession, input, result, attemptGroupId, attempt + 1, circuitTtlMs);
    }
    return lastResult ?? this.runtimeRoutingBlockedResult(inputSession, input, 'Runtime provider attempts were exhausted.');
  }

  private async runRuntimeAttempt(inputSession: SessionDetail, input: RuntimeInvocationDraft, signal?: AbortSignal) {
    if (!this.invocationResolver) {
      throw new Error('InvocationResolverService is unavailable.');
    }
    this.workspaceBindings?.bindSession(inputSession);
    await this.refreshWorkspaceIndex(inputSession, input);

    let resolvedPlan: InvocationPlan;
    try {
      resolvedPlan = this.invocationResolver.resolve({
        invocationId: input.invocationId,
        sessionId: input.sessionId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        taskKind: input.contextAssembly.taskContext.intent,
        phase: input.phase,
        agent: input.agent,
        taskRequiresCodeChanges: input.contextAssembly.taskContext.requiresCodeChanges,
        workspace: this.invocationWorkspace(inputSession),
        sessionPreference: this.runtimePreferenceForAgent(input.agent, inputSession.runtimePreference, input.phase),
        projectPolicyRuntime: projectPolicyRuntimeType(),
        smartRouterPick: input.runtimeCandidateOverride ?? smartRuntimePick({
          phase: input.phase,
          requiresCodeChanges: input.contextAssembly.taskContext.requiresCodeChanges
        }),
        globalDefaultRuntime: globalDefaultRuntimeType(),
        excludedRuntimeTypes: input.excludedRuntimeTypes,
        contextEnvelopeFactory: ({ identity, toolCatalog }) =>
          buildEnvelopeFromContextAssembly({
            session: inputSession,
            phase: input.phase,
            contextAssembly: input.contextAssembly,
            identity,
            toolCatalogHash: toolCatalog.catalogHash
          }),
        expectedOutput: input.expectedOutput,
        budget: input.budget,
        writeModeOverride: input.writeModeOverride
      });
      resolvedPlan = {
        ...resolvedPlan,
        operation: input.operation,
        recoveryCandidate: input.recoveryCandidate,
        submissionRepair: input.submissionRepair,
        workItemId: input.contextAssembly.workItemId ?? inputSession.activeWorkItemId,
        attempt: input.attempt
      };
      if (input.taskId && input.phase === 'task_execution' && !resolvedPlan.recoveryCandidate) {
        const task = this.tasks.find(inputSession.id, input.taskId);
        resolvedPlan.recoveryOriginTaskId = task?.recoveryOriginTaskId;
        resolvedPlan.recoveryCandidate = this.runtime.findExecutionCandidate?.(resolvedPlan);
        const candidate = resolvedPlan.recoveryCandidate;
        if (candidate?.schemaErrors?.length) {
          if (!candidate.originalSubmission || candidate.outputVersion !== '2.0' ||
            resolvedPlan.executionTarget.runtimeType !== 'claude_code' || !resolvedPlan.operation ||
            !await this.runtime.operations?.reserveCorrection(inputSession.id, resolvedPlan.operation.id)) {
            const blocked = this.runtimeRoutingBlockedResult(inputSession, input,
              '已保留上一次修改，但当前不支持安全修复或修复额度已耗尽。任务已停止，未重新执行开发。');
            blocked.executionCandidate = candidate;
            blocked.error!.details = { ...blocked.error!.details, operationId: resolvedPlan.operation?.id,
              operationFailure: 'OPERATION_SUBMISSION_REPAIR_BLOCKED', candidateId: candidate.id };
            return blocked;
          }
          resolvedPlan.submissionRepair = true;
          this.events.create({ sessionId: inputSession.id, taskId: input.taskId, type: 'runtime_progress',
            fromAgentId: input.agent.id, content: '已恢复上一次修改，仅重新提交结果。',
            metadata: createMetadata('system_notice', { code: 'SUBMISSION_REPAIR_STARTED',
              operationId: resolvedPlan.operation.id, runtimeInvocationId: resolvedPlan.invocationId, candidateId: candidate.id }) });
        } else if (!candidate && (task?.recoveryOriginTaskId || task?.executionCheckpoint?.candidateId)) {
          this.events.create({ sessionId: inputSession.id, taskId: input.taskId, type: 'runtime_progress',
            fromAgentId: input.agent.id, content: '上一候选不存在或基线、版本已变化，本次按当前工作目录重新执行。',
            metadata: createMetadata('system_notice', { code: 'EXECUTION_CANDIDATE_UNAVAILABLE', operationId: resolvedPlan.operation?.id }) });
        }
      }
      if (input.writeModeOverride) {
        resolvedPlan = applyRuntimeWriteModeOverride(resolvedPlan, input.writeModeOverride);
      }
    } catch (error) {
      if (error instanceof InvocationResolutionError) {
        return this.runtimeRoutingBlockedResult(inputSession, input, error.message);
      }
      throw error;
    }
    const priorRuntimeSession =
      resolvedPlan.phase === 'task_execution' && resolvedPlan.taskId
        ? this.runtime.findPriorInvocation(
            resolvedPlan.sessionId,
            resolvedPlan.agent.agentId,
            resolvedPlan.taskId,
            resolvedPlan.executionTarget.runtimeType
          )
        : undefined;
    const plan: InvocationPlan = priorRuntimeSession
      ? { ...resolvedPlan, resume: priorRuntimeSession }
      : resolvedPlan;

    // === 检查是否有待审批的能力 ===
    if (plan.pendingApprovals && plan.pendingApprovals.length > 0) {
      return this.pendingApprovalResult(plan, plan.pendingApprovals, input);
    }

    const requiresGroundedEvidence = requiresGroundedRuntimeEvidence(
      input.phase,
      input.contextAssembly.taskContext.requiresCodeChanges,
      input.contextAssembly.taskContext.evidenceSelection.strategy
    ) && inputSession.workspaceMode !== 'bootstrap';
    const evidenceDecision = evaluateGroundedEvidenceGate({
      envelope: plan.contextEnvelope,
      requiresEvidence: requiresGroundedEvidence
    });
    if (!evidenceDecision.ok) {
      return this.groundedEvidenceMissingResult(plan, evidenceDecision.reason);
    }

    const estimatedInputTokens = estimateTokens({
      agent: plan.agent.systemPrompt,
      contextEnvelope: plan.contextEnvelope,
      toolCatalog: plan.toolCatalog,
      expectedOutput: plan.expectedOutput
    });
    if (plan.budget.maxInputTokens && estimatedInputTokens > plan.budget.maxInputTokens) {
      return this.tokenBudgetExceededResult(plan, estimatedInputTokens, plan.budget.maxInputTokens);
    }
    if (input.minimumOutputTokens !== undefined) {
      const runtimeLimit = this.runtime.maxStructuredOutputTokens(plan);
      const effectiveLimit = effectiveStructuredOutputLimit(plan.budget.maxOutputTokens, runtimeLimit);
      if (effectiveLimit !== undefined && input.minimumOutputTokens > effectiveLimit) {
        workspaceMetrics.increment('file_revision_model_capacity_rejected_total', 1, {
          phase: plan.phase,
          runtimeType: plan.executionTarget.runtimeType
        });
        return this.modelCapacityInsufficientResult(plan, input.minimumOutputTokens, effectiveLimit);
      }
    }

    this.events.create({
      sessionId: plan.sessionId,
      workItemId: plan.workItemId,
      type: 'runtime_started',
      taskId: plan.taskId,
      fromAgentId: plan.agent.agentId,
      content: messages.runtimeStarted(plan.agent.name, runtimeModeLabel(plan.executionTarget.runtimeType)),
      metadata: createMetadata('system_notice', {
        runtimeInvocationId: plan.invocationId,
        operationId: plan.operation?.id,
        policyVersion: plan.operation?.policyVersion,
        remainingMs: plan.operation ? Math.max(0, Date.parse(plan.operation.deadlineAt) - Date.now()) : undefined,
        runtimeType: plan.executionTarget.runtimeType,
        phase: plan.phase,
        executionTarget: plan.executionTarget,
        toolCatalogHash: plan.toolCatalog.catalogHash,
        status: 'running'
      })
    });

    const adapter = this.runtime.getAdapter(plan.executionTarget.runtimeType);
    const heartbeatStartedAt = Date.now();
    let lastVisibleRuntimeActivityAt = heartbeatStartedAt;
    plan.operation = input.operation;
    const timeoutMs = input.operation ? 0 : phaseTimeoutMs(plan.phase);
    const phaseController = timeoutMs > 0 ? new AbortController() : undefined;
    const onParentAbort = phaseController
      ? () => {
          const reason = signal?.reason;
          abortWithTermination(
            phaseController,
            isExecutionTermination(reason)
              ? reason
              : createExecutionTermination({
                  kind: 'user_cancelled',
                  source: 'user',
                  scope: 'session',
                  phase: plan.phase
                })
          );
        }
      : undefined;
    if (phaseController && signal) {
      if (signal.aborted) onParentAbort?.();
      else signal.addEventListener('abort', onParentAbort!, { once: true });
    }
    const phaseTimer = phaseController
      ? setTimeout(() => {
          abortWithTermination(
            phaseController,
            createExecutionTermination({
              kind: 'phase_timeout',
              source: 'orchestrator',
              scope: 'phase',
              phase: plan.phase,
              timeout: { mode: 'deadline', timeoutMs }
            })
          );
        }, timeoutMs)
      : undefined;
    const execution = this.runtime.start(plan, phaseController?.signal ?? signal);
    let outputGuardError: RuntimeError | undefined;
    const outputGuard = structuredOutputGuard({
      maxCorrections: plan.submissionRepair ? 0 : Math.max(0, Math.min(1, Number(process.env.STRUCTURED_OUTPUT_MAX_CORRECTIONS ?? 1) || 0)),
      timeoutMs: Math.max(1000, Number(process.env.STRUCTURED_OUTPUT_CORRECTION_TIMEOUT_MS ?? 300_000) || 300_000),
      fail: (error) => {
        outputGuardError = error;
        void execution.cancel(createExecutionTermination({
          kind: error.code === 'RUNTIME_TIMEOUT' ? 'runtime_timeout' : 'output_contract_failure', source: 'orchestrator', scope: 'invocation', phase: plan.phase,
          diagnosticRef: 'structured_output_guard'
        })).catch(() => undefined);
      }
    });
    const heartbeatTimer = shouldEmitHeartbeat(adapter, execution.hasStreamingEvents)
      ? setInterval(() => {
          const now = Date.now();
          if (shouldSuppressHeartbeat(now, lastVisibleRuntimeActivityAt, RUNTIME_HEARTBEAT_INTERVAL_MS)) return;
          this.events.create({
            sessionId: plan.sessionId,
            workItemId: plan.workItemId,
            type: 'runtime_progress',
            taskId: plan.taskId,
            fromAgentId: plan.agent.agentId,
            content: messages.runtimeHeartbeat(
              plan.agent.name,
              Math.round((now - heartbeatStartedAt) / 1000)
            ),
            metadata: createMetadata('system_notice', {
              runtimeInvocationId: plan.invocationId,
              phase: plan.phase,
              code: 'RUNTIME_HEARTBEAT',
              elapsedMs: now - heartbeatStartedAt
            })
          });
          lastVisibleRuntimeActivityAt = now;
        }, RUNTIME_HEARTBEAT_INTERVAL_MS)
      : undefined;

    const streamConsumer = execution.hasStreamingEvents
      ? consumeRuntimeEvents(execution.events, plan, {
          events: this.events,
          createMetadata,
          onPublished: (frame) => {
            outputGuard.observe(frame);
            lastVisibleRuntimeActivityAt = Date.now();
          }
        })
      : Promise.resolve();

    try {
      let result = await execution.result;
      await streamConsumer;
      if (outputGuardError && !signal?.aborted && !result.error?.details?.stopUnconfirmed) {
        result = { ...result, status: 'failed', error: { ...outputGuardError,
          details: { ...outputGuardError.details, phase: plan.phase } } };
      }
      if (!execution.hasStreamingEvents) this.recordRuntimeResultDiagnostics(plan, result);
      this.recordRuntimeTermination(plan, result);
      this.recordTokenUsage(inputSession, result);
      return result;
    } finally {
      outputGuard.dispose();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (phaseTimer) clearTimeout(phaseTimer);
      if (signal && onParentAbort) signal.removeEventListener('abort', onParentAbort);
    }
  }

  private async refreshWorkspaceIndex(session: SessionDetail, input: RuntimeInvocationDraft): Promise<void> {
    const provider = this.workspaceProviders?.resolve(session);
    if (!provider?.capabilities().read) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const refs = [
        ...input.contextAssembly.taskContext.evidenceRefs,
        ...input.contextAssembly.taskContext.taskMap.items
      ]
        .map((item) => item.ref)
        .filter((ref): ref is string => Boolean(ref && ref.includes('/')))
        .slice(0, 24);
      const queryInput = {
        query: input.contextAssembly.sessionGoal,
        intent: input.contextAssembly.taskContext.intent,
        pathHints: refs,
        limit: 50
      } as const;
      const snapshot = await Promise.race([
        provider.queryWorkspaceIndex
          ? provider.queryWorkspaceIndex(queryInput)
          : provider.getIndexSnapshot
            ? provider.getIndexSnapshot({ limit: 50 })
            : Promise.reject(new Error('WORKSPACE_INDEX_UNAVAILABLE')),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('WORKSPACE_INDEX_LOOKUP_TIMEOUT')), 500);
          timer.unref?.();
        })
      ]);
      session.workspaceIndex = snapshot;
      if (session.workspaceContext) {
        session.workspaceContext = {
          ...session.workspaceContext,
          indexGeneration: snapshot.generation,
          indexRevision: snapshot.revision,
          indexComplete: snapshot.complete
        };
      }
    } catch {
      // A stale or empty index is valid input; background indexing never blocks an invocation.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private activeRuntimeProviderCircuits() {
    const now = Date.now();
    const active: RuntimeType[] = [];
    for (const [runtimeType, openUntil] of this.runtimeProviderCircuits) {
      if (openUntil <= now) this.runtimeProviderCircuits.delete(runtimeType);
      else active.push(runtimeType);
    }
    return active;
  }

  private runtimeProviderMaxAttempts() {
    const parsed = Number(process.env.RUNTIME_PROVIDER_MAX_ATTEMPTS ?? 3);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(5, Math.floor(parsed))) : 3;
  }

  private isRetryableProviderFailure(error: RuntimeError | undefined) {
    return error?.retryable === true && error.details?.providerFailure === true;
  }

  private runtimeProviderRetryDelayMs(error: RuntimeError | undefined) {
    const reported = Number(error?.details?.retryAfterMs ?? 1_000);
    const configuredCap = Number(process.env.RUNTIME_PROVIDER_RETRY_MAX_DELAY_MS ?? 120_000);
    const cap = Number.isFinite(configuredCap) ? Math.max(0, Math.min(configuredCap, 10 * 60_000)) : 120_000;
    // Retry-After is a lower bound; never send an earlier retry by clipping it.
    return Number.isFinite(reported) ? Math.max(0, reported) : Math.min(1_000, cap);
  }

  private openRuntimeProviderCircuit(runtimeType: RuntimeType, error: RuntimeError | undefined) {
    const reported = Number(error?.details?.retryAfterMs ?? 0);
    const configured = Number(process.env.RUNTIME_PROVIDER_CIRCUIT_TTL_MS ?? 120_000);
    const configuredTtl = Number.isFinite(configured) ? Math.max(1_000, configured) : 120_000;
    const ttlMs = Math.min(Math.max(Number.isFinite(reported) ? reported : 0, configuredTtl), 10 * 60_000);
    // RuntimeService owns isolation by connection/model/protocol. This value is only retry-event metadata.
    return ttlMs;
  }

  private nextAllowedRuntimeFallback(session: SessionDetail, excluded: ReadonlySet<RuntimeType>) {
    const allowed = session.runtimePreference?.allowedRuntimeTypes ?? [];
    return allowed.find((runtimeType) => !excluded.has(runtimeType));
  }

  private recordRuntimeProviderRetry(
    session: SessionDetail,
    input: RuntimeInvocationDraft,
    result: AgentRunResult,
    attemptGroupId: string,
    nextAttempt: number,
    delayMs: number
  ) {
    this.events.create({
      sessionId: session.id,
      workItemId: input.contextAssembly.workItemId,
      type: 'runtime_progress',
      taskId: input.taskId,
      fromAgentId: input.agent.id,
      content: `${input.agent.name} 的模型网关暂时不可用，将在 ${Math.ceil(delayMs / 1_000)} 秒后自动重试。`,
      metadata: createMetadata('system_notice', {
        code: 'RUNTIME_PROVIDER_RETRY_SCHEDULED',
        operationId: input.operation?.id,
        policyVersion: input.operation?.policyVersion,
        runtimeInvocationId: result.invocationId,
        runtimeType: result.runtimeType,
        attemptGroupId,
        nextAttempt,
        delayMs,
        runtimeError: result.error
      })
    });
  }

  private recordRuntimeProviderFallback(
    session: SessionDetail,
    input: RuntimeInvocationDraft,
    result: AgentRunResult,
    attemptGroupId: string,
    nextAttempt: number,
    circuitTtlMs: number
  ) {
    this.events.create({
      sessionId: session.id,
      workItemId: input.contextAssembly.workItemId,
      type: 'runtime_progress',
      taskId: input.taskId,
      fromAgentId: input.agent.id,
      content: `${runtimeModeLabel(result.runtimeType)} 重试失败，正在切换到允许的备用 Runtime。`,
      metadata: createMetadata('system_notice', {
        code: 'RUNTIME_PROVIDER_FALLBACK',
        runtimeInvocationId: result.invocationId,
        runtimeType: result.runtimeType,
        attemptGroupId,
        nextAttempt,
        circuitTtlMs,
        allowedRuntimeTypes: session.runtimePreference?.allowedRuntimeTypes ?? [],
        runtimeError: result.error
      })
    });
  }

  private async backoffRuntimeProviderRetry(delayMs: number, signal?: AbortSignal) {
    await new Promise<void>((resolve) => {
      if (signal?.aborted || delayMs <= 0) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  private recordRuntimeTermination(input: InvocationPlan, result: AgentRunResult) {
    if (!result.termination) return;
      this.events.create({
        sessionId: input.sessionId,
        workItemId: input.workItemId,
        type: 'runtime_failed',
      taskId: input.taskId,
      fromAgentId: input.agent.agentId,
      content: result.error?.message ?? '运行时执行已终止。',
      metadata: createMetadata(
        result.termination.kind === 'phase_timeout' || result.termination.kind === 'runtime_timeout'
          ? 'error_card'
          : 'system_notice',
        {
          runtimeInvocationId: input.invocationId,
          runtimeType: result.runtimeType,
          agentId: input.agent.agentId,
          taskId: input.taskId,
          phase: input.phase,
          status: result.status,
          code: result.error?.code,
          message: result.error?.message,
          error: result.error,
          termination: result.termination
        }
      )
    });
  }
  private recordRuntimeResultDiagnostics(input: InvocationPlan, result: AgentRunResult) {
    for (const event of result.events) {
      if (event.type !== 'runtime_progress' || event.metadata?.code !== 'TOKEN_ESTIMATION_DRIFT') {
        continue;
      }
      this.events.create({
        sessionId: input.sessionId,
        workItemId: input.workItemId,
        type: 'runtime_progress',
        taskId: input.taskId,
        fromAgentId: input.agent.agentId,
        content: event.content,
        metadata: createMetadata('system_notice', {
          ...event.metadata,
          runtimeInvocationId: input.invocationId
        })
      });
    }
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

  private tokenBudgetExceededResult(input: InvocationPlan, estimatedTokens: number, maxInputTokens: number): AgentRunResult {
    return {
      invocationId: input.invocationId,
      runtimeType: input.executionTarget.runtimeType,
      status: 'failed',
      output: createAgentMessageOutput({
        messageKind: 'risk',
        content: messages.tokenBudgetInsufficient
      }) satisfies AgentMessageOutput,
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage: {
        inputTokens: estimatedTokens,
        outputTokens: 0,
        totalTokens: estimatedTokens,
        model: input.executionTarget.modelId ?? input.executionTarget.runtimeType
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

  private persistSessionState(session: SessionDetail) {
    session.updatedAt = nowIso();
    const sessions = this.persistence.getCollection<SessionDetail[]>('sessions', []);
    this.persistence.setCollection(
      'sessions',
      sessions.map((item) => item.id === session.id ? structuredClone(session) : item)
    );
  }

  private modelCapacityInsufficientResult(
    input: InvocationPlan,
    requiredTokens: number,
    availableTokens: number
  ): AgentRunResult {
    const message =
      `REVISION_MODEL_CAPACITY_INSUFFICIENT: candidate requires at least ${requiredTokens} output tokens, ` +
      `but the selected Runtime allows ${availableTokens}.`;
    return {
      invocationId: input.invocationId,
      runtimeType: input.executionTarget.runtimeType,
      status: 'failed',
      output: createAgentMessageOutput({ messageKind: 'risk', content: message }),
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: input.executionTarget.modelId ?? input.executionTarget.runtimeType
      },
      error: {
        code: 'MODEL_ERROR',
        message,
        retryable: false,
        details: { requiredTokens, availableTokens, phase: input.phase }
      }
    };
  }

  private groundedEvidenceMissingResult(
    input: InvocationPlan,
    reason: 'evidence-empty' | 'evidence-only-generated' | 'evidence-only-sensitive' | 'evidence-not-navigable'
  ): AgentRunResult {
    const hasNavigableEntries = input.contextEnvelope.L1.navigation.entries.length > 0;
    const requestedPaths = input.contextEnvelope.L1.navigation.entries
      .filter((entry) => entry.kind === 'file' && !entry.generated && !entry.sensitive)
      .map((entry) => entry.path)
      .slice(0, 8);
    const requestedDirectories = !hasNavigableEntries
      ? [{ path: '.', depth: 1 }]
      : undefined;
    const message = `Context v2 blocked an ungrounded runtime call: ${reason}.`;
    return {
      invocationId: input.invocationId,
      runtimeType: input.executionTarget.runtimeType,
      status: 'failed',
      output: createAgentMessageOutput({
        messageKind: 'risk',
        content: message
      }),
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: input.executionTarget.modelId ?? input.executionTarget.runtimeType
      },
      error: {
        code: 'CONTEXT_INSUFFICIENT',
        message,
        retryable: true,
        requestedContext: {
          reason: message,
          requestedRefs: [],
          requestedFiles: requestedPaths.map((path) => ({ path })),
          requestedDirectories,
          followUpInstruction: 'Read at least one non-sensitive source file and retry the same phase.'
        },
        details: { contextPipelineVersion: 'v2', groundedEvidenceReason: reason }
      }
    };
  }

  private runtimeRoutingBlockedResult(
    session: SessionDetail,
    input: RuntimeInvocationDraft,
    reason: string
  ): AgentRunResult {
    const runtimeType = session.runtimePreference?.preferredRuntimeType ?? globalDefaultRuntimeType();
    return {
      invocationId: input.invocationId,
      runtimeType,
      status: 'failed',
      output: createAgentMessageOutput({ messageKind: 'risk', content: reason }),
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: runtimeType },
      error: {
        code: 'CAPABILITY_BLOCKED',
        message: reason,
        retryable: false,
        details: { contextPipelineVersion: 'v2', routingMode: 'dynamic_fail_closed', phase: input.phase }
      }
    };
  }

  private pendingApprovalResult(
    plan: InvocationPlan,
    pendingApprovals: NonNullable<InvocationPlan['pendingApprovals']>,
    inputDraft: RuntimeInvocationDraft
  ): AgentRunResult {
    const approvalMessage = `需要用户授权以下能力:\n${pendingApprovals.map(a => `- ${a.toolKey} (原因: ${a.reasons.join(', ')})`).join('\n')}`;

    // 保存待审批调用到 session
    const pendingInvocation: PendingInvocation = {
      invocationId: plan.invocationId,
      sessionId: plan.sessionId,
      taskId: plan.taskId!,
      agentId: plan.agent.agentId,
      phase: plan.phase,
      pendingApprovals,
      createdAt: new Date().toISOString()
    };

    // 通过回调保存，避免循环依赖
    if (this.savePendingInvocationCallback) {
      this.savePendingInvocationCallback(plan.sessionId, pendingInvocation);
    }

    // 发送审批请求事件
    this.events.create({
      sessionId: plan.sessionId,
      type: 'capability_approval_required',
      ...(plan.taskId ? { taskId: plan.taskId } : {}),
      fromAgentId: plan.agent.agentId,
      toAgentIds: [],
      content: approvalMessage,
      metadata: {
        schemaVersion: '0.1',
        renderAs: 'confirmation_card',
        payload: {
          reason: 'approve_capability',
          title: '需要授权执行能力',
          description: '授权后任务会从当前阶段自动恢复执行。',
          agentId: plan.agent.agentId,
          pendingApprovals
        }
      }
    });

    return {
      invocationId: plan.invocationId,
      runtimeType: plan.executionTarget.runtimeType,
      status: 'pending_approval',
      output: createAgentMessageOutput({
        messageKind: 'progress',
        content: approvalMessage
      }),
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(plan.invocationId),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: plan.executionTarget.runtimeType },
      error: {
        code: 'HUMAN_APPROVAL_REQUIRED',
        message: approvalMessage,
        retryable: true,
        details: {
          contextPipelineVersion: 'v2',
          phase: plan.phase,
          pendingApprovals: pendingApprovals.map(a => ({
            toolId: a.toolId,
            toolKey: a.toolKey,
            approvalId: a.approvalId
          }))
        }
      }
    };
  }

  private runtimePreferenceForAgent(agent: Agent, sessionPreference?: RuntimePreference, phase?: AgentRunPhase) {
    const role = agent.key === 'coordinator' || phase === 'task_acceptance' ? 'coordinator' : undefined;
    const policy = role ? this.systemAgentPolicies?.get(role) : undefined;
    if (!policy) return sessionPreference;
    return {
      ...sessionPreference,
      ...(policy.preferredRuntimeType ? { preferredRuntimeType: policy.preferredRuntimeType } : {}),
      ...(policy.preferredModelId ? { preferredModelId: policy.preferredModelId } : {}),
      ...(policy.allowedRuntimeTypes ? { allowedRuntimeTypes: [...policy.allowedRuntimeTypes] } : {})
    };
  }

  private compileAgentIdentity(agent: Agent) {
    // 编译 Markdown Profile：展开 ${skill:key}/${tool:key}，作为所有 Runtime 的统一 systemPrompt。
    // 编译器缺席（部分测试环境）时回退到原始 Markdown。
    return this.profileCompiler.compileIdentity({ agent });
  }

  private participatingAgents(session: SessionDetail) {
    return session.participatingAgentIds
      .map((agentId) => this.agents.findByIdOrKey(agentId))
      .filter((agent): agent is Agent => Boolean(agent))
      .filter((agent) => agent.management?.allowedSurfaces.includes('chat') ?? true)
      .filter((agent) => agent.status === 'active');
  }

  private requireDefaultFileRevisionReceiver() {
    const receiver = this.agents.findByIdOrKey('coordinator');
    if (!receiver || receiver.status !== 'active') {
      throw new BadRequestException(
        'REVISION_RECEIVER_UNAVAILABLE: the active system default Receiver is required for file revision processing.'
      );
    }
    return receiver;
  }

  private fileRevisionRuntimeFailureMessage(code?: string) {
    const stableCode = code && /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'REVISION_RUNTIME_FAILED';
    return `File revision Agent processing failed (${stableCode}).`;
  }

  private pickSessionAgent(session: SessionDetail, preferredKeys: string[], fallbackIndex = 0) {
    const agents = this.participatingAgents(session);
    for (const key of preferredKeys) {
      const preferred = this.agents.findSystemByKey(key) ?? agents.find((agent) => agent.key === key);
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

  private taskKnowledgeQuery(session: SessionDetail, brief: TaskBrief | undefined, task: AgentTask) {
    return Array.from(
      new Set(
        [
          session.originalInput,
          brief?.goal,
          task.title,
          task.description,
          task.assignmentReason,
          ...(task.contextRequirements ?? []),
          ...(task.acceptanceCriteria ?? [])
        ]
          .map((item) => item?.trim())
          .filter((item): item is string => Boolean(item))
      )
    ).join('\n');
  }

  private completedOutput<TOutput extends RuntimeOutput>(
    result: AgentRunResult,
    expectedKind: RuntimeOutputKind
  ): TOutput {
    if (result.status !== 'completed') {
      throw this.runtimeError(result, expectedKind);
    }
    const validation = validateRuntimeOutput(expectedKind, result.output);
    if (!validation.valid) {
      const runtimeError: RuntimeError = {
        code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION',
        message: `Orchestrator received invalid ${expectedKind}: ${validation.errors.join('; ')}`,
        retryable: false,
        details: { expectedKind, validationErrors: validation.errors }
      };
      throw Object.assign(new Error(`RUNTIME_OUTPUT_CONTRACT_VIOLATION: ${runtimeError.message}`), {
        cause: runtimeError,
        runtimeError
      });
    }
    return validation.value as TOutput;
  }

  private suggestedTask(input: SuggestedAgentTaskDraft): SuggestedAgentTask {
    return {
      title: input.title,
      description: input.description,
      suggestedAgentKey: input.suggestedAgentKey ?? null,
      routingMode: input.routingMode ?? null,
      assignmentReason: input.assignmentReason ?? null,
      contextRequirements: input.contextRequirements ?? [],
      verificationPlan: input.verificationPlan ?? [],
      riskNotes: input.riskNotes ?? [],
      requiresUserConfirmation: input.requiresUserConfirmation ?? false,
      dependsOnTaskTitles: input.dependsOnTaskTitles ?? [],
      acceptanceCriteria: input.acceptanceCriteria
    };
  }

  private stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
  }

  private safeString(value: unknown) {
    return typeof value === 'string' ? value.trim() : '';
  }

  private shortText(value: string, maxLength: number) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1))}…` : normalized;
  }

  private runtimeError(result: AgentRunResult, phase: string) {
    return Object.assign(
      new Error(messages.runtimeError(result.runtimeType, phase, result.error?.message ?? result.status)),
      { cause: result.error, runtimeError: result.error }
    );
  }

  /**
   * What the blocked node says it was missing, preferring its own context request
   * over the stage input contract so the card shows the Agent's actual words.
   */
  private upstreamMissingInputs(task: AgentTask, requestedContext?: RuntimeContextRequest) {
    const requested = [
      ...(requestedContext?.requestedRefs ?? []).map((ref) => ref.label || ref.ref),
      ...(requestedContext?.requestedPaths ?? [])
    ].filter((item): item is string => Boolean(item && item.trim()));
    const fallback = (task.contextRequirements ?? []).filter((item) => item !== '已确认任务契约');
    return [...new Set(requested.length ? requested : fallback)].slice(0, 8);
  }

  private isInfrastructureTaskFailure(result: TaskRunOutcome) {
    if (result.ok) {
      return false;
    }
    const code = result.error?.code ?? result.code;
    const retryable = result.error?.retryable ?? result.retryable;
    return code === 'RUNTIME_TIMEOUT' ||
      code === 'RUNTIME_INVOCATION_ERROR' ||
      code === 'RUNTIME_OUTPUT_CONTRACT_VIOLATION' ||
      (code === 'MODEL_ERROR' && retryable === true);
  }

  private defaultSuggestedTasks(session: SessionDetail): SuggestedAgentTask[] {
    const planningKeys =
      session.taskIntent === 'planning'
        ? ['product-manager', 'requirements']
        : ['requirements', 'product-manager'];

    if (this.isArchitectureAnalysisSession(session)) {
      return this.architectureAnalysisSuggestedTasks(session);
    }

    const appendValidation = this.shouldAppendValidationTask(session);

    if (session.taskDomain === 'non_coding') {
      const analysisTitle = '产出分析或方案建议';
      const validationTitle = '验证事实与交付完整性';
      const tasks: SuggestedAgentTaskDraft[] = [
        {
          title: analysisTitle,
          description: '围绕当前目标沉淀结构化分析、方案、计划或说明。',
          suggestedAgentKey: this.resolveParticipatingAgentKey(session, planningKeys),
          acceptanceCriteria: ['输出直接回答用户目标，并形成可复用的结构化结论。']
        }
      ];
      if (appendValidation) {
        tasks.push({
          title: validationTitle,
          description: '独立验证分析结论的事实一致性、范围一致性、可追溯性和交付完整性。',
          suggestedAgentKey: this.validationSuggestedAgentKey(session),
          acceptanceCriteria: ['验证结果映射到非编程验证规则，并指出证据、缺口和风险。'],
          dependsOnTaskTitles: [analysisTitle]
        });
        const reviewKey = this.resolveParticipatingAgentKey(session, ['review', 'test']);
        if (reviewKey) {
          tasks.push({
            title: '复核结论与风险',
            description: '检查分析或方案是否覆盖范围、风险、假设和下一步建议。',
            suggestedAgentKey: reviewKey,
            acceptanceCriteria: ['复核结果明确指出已覆盖项、风险和未决问题。'],
            dependsOnTaskTitles: [validationTitle]
          });
        }
      }
      return tasks.map((task) => this.suggestedTask(task));
    }

    if (session.taskDomain === 'mixed') {
      const tasks: SuggestedAgentTaskDraft[] = [
        {
          title: '形成需求与实现计划',
          description: '先沉淀需求理解、范围、关键约束和实现路线。',
          suggestedAgentKey: this.resolveParticipatingAgentKey(session, planningKeys),
          acceptanceCriteria: ['输出包含范围、约束、验收标准和实施建议。']
        },
        {
          title: messages.defaultTaskExecuteTitle,
          description: messages.defaultTaskExecuteDescription,
          suggestedAgentKey: this.resolveParticipatingAgentKey(session, ['backend', 'frontend']),
          acceptanceCriteria: [messages.defaultTaskExecuteAcceptance],
          dependsOnTaskTitles: ['形成需求与实现计划']
        }
      ];
      if (appendValidation) {
        tasks.push({
          title: messages.defaultTaskValidateTitle,
          description: messages.defaultTaskValidateDescription,
          suggestedAgentKey: this.validationSuggestedAgentKey(session),
          acceptanceCriteria: [messages.defaultTaskValidateAcceptance],
          dependsOnTaskTitles: [messages.defaultTaskExecuteTitle]
        });
      }
      return tasks.map((task) => this.suggestedTask(task));
    }

    const tasks: SuggestedAgentTaskDraft[] = [
      {
        title: messages.defaultTaskExecuteTitle,
        description: messages.defaultTaskExecuteDescription,
        suggestedAgentKey: this.resolveParticipatingAgentKey(session, ['backend', 'frontend']),
        acceptanceCriteria: [messages.defaultTaskExecuteAcceptance]
      }
    ];
    if (appendValidation) {
      tasks.push({
        title: messages.defaultTaskValidateTitle,
        description: messages.defaultTaskValidateDescription,
        suggestedAgentKey: this.validationSuggestedAgentKey(session),
        acceptanceCriteria: [messages.defaultTaskValidateAcceptance]
      });
    }
    return tasks.map((task) => this.suggestedTask(task));
  }

  private shouldAppendValidationTask(session: SessionDetail): boolean {
    if (!this.validationSuggestedAgentKey(session)) {
      return false;
    }
    if (this.userExplicitlyRequestedValidation(session.originalInput)) {
      return true;
    }
    if (session.taskDomain === 'mixed') {
      return true;
    }
    return false;
  }

  private userExplicitlyRequestedValidation(input: string): boolean {
    return /(?:验证|校验|复核|复盘|复查|审查|审核|检查|把关|review|validate|validation|verify|verification|check|audit|独立验证|独立复核)/i.test(
      input
    );
  }

  private selectSuggestedTasks(session: SessionDetail, runtimeSuggestedTasks: SuggestedAgentTask[]) {
    if (this.isArchitectureAnalysisSession(session)) {
      return this.withReadOnlySuggestedTaskPolicy(session, this.architectureAnalysisSuggestedTasks(session));
    }

    if (!runtimeSuggestedTasks.length) {
      return this.withReadOnlySuggestedTaskPolicy(session, this.defaultSuggestedTasks(session));
    }

    const participatingKeys = new Set(this.participatingAgents(session).map((agent) => agent.key));

    if (session.taskDomain === 'mixed') {
      const hasPlanningTask = runtimeSuggestedTasks.some((task) =>
        /plan|规划|需求|分析|scope|implementation path/i.test(`${task.title} ${task.description}`)
      );
      const hasImplementationTask = runtimeSuggestedTasks.some((task) =>
        /implement|执行|实现|backend|frontend/i.test(`${task.title} ${task.description}`)
      );
      const hasFrontendImplementation =
        participatingKeys.has('frontend') &&
        runtimeSuggestedTasks.some(
          (task) => task.suggestedAgentKey === 'frontend' && /implement|frontend/i.test(`${task.title} ${task.description}`)
        );
      const hasBackendImplementation =
        participatingKeys.has('backend') &&
        runtimeSuggestedTasks.some(
          (task) => task.suggestedAgentKey === 'backend' && /implement|backend/i.test(`${task.title} ${task.description}`)
        );
      const hasValidationTask = runtimeSuggestedTasks.some((task) => this.isValidationSuggestedTask(task));
      const isExplicitParallelCodingPlan = hasFrontendImplementation && hasBackendImplementation && hasValidationTask;
      if (!isExplicitParallelCodingPlan && (!hasPlanningTask || !hasImplementationTask)) {
        return this.withReadOnlySuggestedTaskPolicy(session, this.defaultSuggestedTasks(session));
      }
    }

    if (session.taskDomain === 'non_coding') {
      const participatingCodingKeys = new Set(
        ['backend', 'frontend', 'test'].filter((key) => participatingKeys.has(key))
      );
      const allCodingAgents =
        participatingCodingKeys.size > 0 &&
        runtimeSuggestedTasks.every((task) =>
          task.suggestedAgentKey ? participatingCodingKeys.has(task.suggestedAgentKey) : false
        );
      const hasValidationTask = runtimeSuggestedTasks.some((task) =>
        /validate|validation|验证|事实|trace|evidence|完整性|test/i.test(`${task.title} ${task.description}`)
      );
      const shouldAppendValidation = this.shouldAppendValidationTask(session);
      if (allCodingAgents || (!hasValidationTask && shouldAppendValidation)) {
        return this.withReadOnlySuggestedTaskPolicy(session, this.defaultSuggestedTasks(session));
      }
    }

    return this.withReadOnlySuggestedTaskPolicy(session, this.ensureValidationSuggestedTask(session, runtimeSuggestedTasks));
  }

  private withReadOnlySuggestedTaskPolicy(session: SessionDetail, suggestions: SuggestedAgentTask[]) {
    const participatingKeys = new Set(this.participatingAgents(session).map((agent) => agent.key));
    const validAgentSuggestions = suggestions.filter((task) => {
      if (!task.suggestedAgentKey) {
        return true;
      }
      return participatingKeys.has(task.suggestedAgentKey);
    });

    const planned = this.withSuggestedTaskPlanningDetails(session, validAgentSuggestions);
    if (!this.isReadOnlyResponseSession(session)) {
      return planned;
    }

    const filtered = planned.filter((task) => !this.isGeneratedFileWriteTask(task));
    if (!filtered.some((task) => !this.isValidationSuggestedTask(task))) {
      return this.withSuggestedTaskPlanningDetails(session, [this.readOnlyAnalysisSuggestedTask(session)]);
    }

    const keptTitles = new Set(filtered.map((task) => task.title));
    return filtered.map((task) => ({
      ...task,
      dependsOnTaskTitles: task.dependsOnTaskTitles.filter((title) => keptTitles.has(title))
    }));
  }

  private readOnlyAnalysisSuggestedTask(session: SessionDetail): SuggestedAgentTask {
    if (this.isArchitectureAnalysisSession(session)) {
      return this.architectureAnalysisSuggestedTasks(session)[0];
    }

    return this.suggestedTask({
      title: '查看并说明整体需求内容',
      description: '在会话中整理和说明用户需要查看的整体内容，不生成文件、不写入工作区。',
      suggestedAgentKey: this.resolveParticipatingAgentKey(session, ['requirements', 'product-manager', 'review']),
      acceptanceCriteria: [
        '输出可直接在会话中阅读的分析结果。',
        '不返回 fileChanges，不写入 agent-output、docs 或其他工作区文件。'
      ]
    });
  }

  private architectureAnalysisSuggestedTasks(session: SessionDetail): SuggestedAgentTask[] {
    const analysisTitle = '从架构视角分析当前项目结构与主链路';
    return [
      this.suggestedTask({
        title: analysisTitle,
        description:
          '作为唯一的架构师场景，基于用户目标、workspaceManifest、projectMap 和 selectedEvidenceContents 直接分析当前项目结构与主链路，并给出架构方面的想法和建议。',
        suggestedAgentKey: this.resolveArchitectureAgentKey(session),
        assignmentReason:
          '用户目标是理解或分析项目架构，系统架构师只负责从目录职责、模块边界、入口链路、数据/事件/Runtime 流和架构风险角度分析当前项目。',
        contextRequirements: [
          'Original user requirement',
          'workspaceManifest and projectMap',
          'Selected readable evidence contents for entrypoints, config files, docs, contracts, and core modules'
        ],
        verificationPlan: [
          '输出包含总体定位、目录分层、主运行链路、模块边界、数据/事件/Runtime 流、架构想法、建议阅读路径和未确认风险。',
          '明确区分基于证据的结论、目录级推断和需要补充源码正文才能确认的点。'
        ],
        riskNotes: [
          '不得把项目分析误写成“等待其他 Agent 先给方案”。',
          '证据不足时请求补充关键文件正文，而不是等待其他 Agent 先产出架构说明。'
        ],
        acceptanceCriteria: [
          '架构师直接输出面向用户理解项目的架构分析。',
          '分析覆盖项目定位、目录职责、核心入口、模块边界、主链路、技术栈、架构想法、建议和风险缺口。',
          '结论引用 workspaceManifest、projectMap 或 selectedEvidenceContents 中的证据。'
        ]
      })
    ];
  }

  private ensureValidationSuggestedTask(session: SessionDetail, suggestions: SuggestedAgentTask[]) {
    const validationAgentKey = this.validationSuggestedAgentKey(session);

    if (!validationAgentKey) {
      return suggestions.filter((task) => !this.isValidationSuggestedTask(task));
    }

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

    if (!this.shouldAppendValidationTask(session)) {
      return normalized;
    }

    const fallbackValidation = this.defaultSuggestedTasks(session).find((task) => this.isValidationSuggestedTask(task));
    const lastTaskTitle = normalized.at(-1)?.title;
    return this.withSuggestedTaskPlanningDetails(session, [
      ...normalized,
      this.suggestedTask({
        title: fallbackValidation?.title ?? 'Validate task output',
        description:
          fallbackValidation?.description ??
          'Independently validate the execution output against the Task Context Assembly validation rules.',
        suggestedAgentKey: validationAgentKey,
        acceptanceCriteria: fallbackValidation?.acceptanceCriteria ?? [
          'Validation result maps rules to evidence and records gaps, risks, and remaining work.'
        ],
        dependsOnTaskTitles: lastTaskTitle ? [lastTaskTitle] : fallbackValidation?.dependsOnTaskTitles
      })
    ]);
  }

  private withSuggestedTaskPlanningDetails(session: SessionDetail, suggestions: SuggestedAgentTask[]) {
    return suggestions.map((task) => {
      const acceptanceCriteria = this.stringList(task.acceptanceCriteria);
      const contextRequirements = this.stringList(task.contextRequirements);
      const verificationPlan = this.stringList(task.verificationPlan);
      const riskNotes = this.stringList(task.riskNotes);
      const fallbackVerificationPlan = acceptanceCriteria.length
        ? acceptanceCriteria
        : this.isValidationSuggestedTask(task)
          ? ['Run the relevant verification command and map evidence back to the brief.']
          : ['Produce output that can be checked against the Task Brief acceptance criteria.'];

      return {
        ...task,
        title: this.safeString(task.title) || 'Suggested task',
        description: this.safeString(task.description) || this.safeString(task.title) || 'Suggested task',
        routingMode: this.normalizeRoutingMode(task.routingMode),
        assignmentReason: this.safeString(task.assignmentReason) || this.defaultAssignmentReason(session, task),
        contextRequirements: contextRequirements.length
          ? contextRequirements
          : this.defaultContextRequirements(session, task),
        verificationPlan: verificationPlan.length ? verificationPlan : fallbackVerificationPlan,
        riskNotes: riskNotes.length ? riskNotes : this.defaultRiskNotes(task),
        requiresUserConfirmation:
          task.requiresUserConfirmation === true || this.suggestedTaskNeedsUserConfirmation(task),
        acceptanceCriteria
      } satisfies SuggestedAgentTask;
    });
  }

  private defaultAssignmentReason(session: SessionDetail, task: SuggestedAgentTask) {
    if (this.isValidationSuggestedTask(task)) {
      return 'Validation work stays with the test/review role so evidence remains independent from implementation.';
    }

    switch (task.suggestedAgentKey) {
      case 'requirements':
      case 'product-manager':
        return 'This task focuses on clarifying scope, constraints, and delivery shape before execution.';
      case 'architect':
        return 'This task is the dedicated project architecture analysis scenario.';
      case 'frontend':
        return 'This task primarily changes user-facing behavior and should stay with the frontend specialist.';
      case 'backend':
        return session.taskDomain === 'mixed'
          ? 'This task owns the executable implementation path while keeping final verification independent.'
          : 'This task primarily touches server-side logic, contracts, or runtime behavior.';
      case 'review':
        return 'This task checks completeness, scope control, and remaining risks after execution.';
      default:
        return 'Coordinator assigned this task to the agent whose default role best matches the required work.';
    }
  }

  private defaultContextRequirements(session: SessionDetail, task: SuggestedAgentTask) {
    const taskBriefContext = ['Confirmed Task Brief', 'Relevant project map entries'];

    if (this.isValidationSuggestedTask(task)) {
      return [...taskBriefContext, 'Upstream task artifacts or summaries', 'Verification commands or acceptance checks'];
    }

    switch (task.suggestedAgentKey) {
      case 'requirements':
      case 'product-manager':
        return [...taskBriefContext, 'Original user requirement', 'Relevant product or design documents'];
      case 'architect':
        return [...taskBriefContext, 'Workspace structure', 'Entrypoints, project map, and selected readable evidence'];
      case 'frontend':
        return [...taskBriefContext, 'Frontend components/styles', 'UI or interaction contracts'];
      case 'backend':
        return [...taskBriefContext, 'Backend modules/services', 'API/runtime/shared contracts'];
      case 'review':
        return [...taskBriefContext, 'Execution evidence', 'Validation output and open risks'];
      default:
        return taskBriefContext;
    }
  }

  private shouldWriteGeneratedFiles(session: SessionDetail, _brief?: TaskBrief) {
    return !this.isReadOnlyResponseSession(session);
  }

  private isReadOnlyResponseSession(session: SessionDetail) {
    if (this.userExplicitlyRequestedGeneratedFileWrite(session.originalInput)) {
      return false;
    }
    return ['inquiry', 'analysis', 'planning', 'review', 'qa', 'troubleshooting', 'validation'].includes(
      session.taskIntent ?? ''
    );
  }

  private userExplicitlyRequestedGeneratedFileWrite(input: string) {
    return /(?:写入|写到|写成|保存|存到|落盘|导出|输出到|放到|创建(?:一个)?文件|生成[^，。；\n]*(?:文件|文档文件|\.md|docs\/|agent-output\/)|write|save|persist|export|output\s+to|create\s+(?:a\s+)?file|generate[^.\n]*(?:file|\.md|docs\/|agent-output\/))/i.test(
      input
    );
  }

  private isGeneratedFileWriteTask(task: SuggestedAgentTask) {
    const text = `${task.title} ${task.description} ${(task.acceptanceCriteria ?? []).join(' ')} ${(task.riskNotes ?? []).join(' ')}`;
    return (
      task.requiresUserConfirmation === true ||
      /(?:写入|写到|保存|存到|落盘|导出|输出到|创建(?:一个)?文件|生成[^，。；\n]*(?:文件|文档文件|\.md|docs\/|agent-output\/)|fileChanges|agent-output\/|docs\/|\.md|markdown|write|save|persist|export|output\s+to|create\s+(?:a\s+)?file|generate[^.\n]*(?:file|\.md|docs\/|agent-output\/))/i.test(
        text
      )
    );
  }

  private defaultRiskNotes(task: SuggestedAgentTask) {
    const notes = new Set<string>();
    if (this.suggestedTaskNeedsUserConfirmation(task)) {
      notes.add('Potentially high-risk scope detected; Coordinator should confirm before execution.');
    }
    if (this.isValidationSuggestedTask(task)) {
      notes.add('Validation should stay independent from the implementation task owner.');
    }
    return Array.from(notes);
  }

  private suggestedTaskNeedsUserConfirmation(task: SuggestedAgentTask) {
    return /(deploy|release|publish|delete|drop|migrate|production|上线|发布|删除|清空|迁移生产)/i.test(
      `${task.title} ${task.description}`
    );
  }

  private normalizeRoutingMode(value: unknown): SuggestedAgentTask['routingMode'] {
    return value === 'agent_suggested' || value === 'agent_delegated' || value === 'coordinator_controlled'
      ? value
      : 'coordinator_controlled';
  }

  private validationSuggestedAgentKey(session: SessionDetail) {
    return this.resolveParticipatingAgentKey(session, ['test', 'review']);
  }

  private resolveArchitectureAgentKey(session: SessionDetail): string | undefined {
    return this.resolveParticipatingAgentKey(session, ['architect']);
  }

  private resolveParticipatingAgentKey(session: SessionDetail, preferredKeys: string[]): string | undefined {
    const participants = this.participatingAgents(session).filter((agent) => agent.key !== 'coordinator');
    for (const key of preferredKeys) {
      if (participants.some((agent) => agent.key === key)) {
        return key;
      }
    }
    return undefined;
  }

  private isValidationSuggestedTask(task: SuggestedAgentTask) {
    const title = this.safeString(task.title);
    const description = this.safeString(task.description);
    return (
      task.suggestedAgentKey === 'test' ||
      /^(validate|validating|validation|verify|verification|check|test|e2e|smoke)\b/i.test(title) ||
      /^(验证|验收|校验|测试)/.test(title) ||
      /^(validate|validating|validation|verify|verification|check|test)\b/i.test(description) ||
      /^(验证|验收|校验|测试)/.test(description)
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? Object.assign(new Error('Session runtime was terminated.'), { name: 'AbortError' });
}
