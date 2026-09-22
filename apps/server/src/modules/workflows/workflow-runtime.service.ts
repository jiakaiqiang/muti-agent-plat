import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Subject } from 'rxjs';
import type {
  AgentTask,
  SessionDetail,
  TaskBrief,
  WorkflowApprovalRecord,
  WorkflowEffect,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowPendingAgentSubstitution,
  WorkflowUpstreamRerunCandidate
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { createExecutionTermination } from '../../common/execution-termination.js';
import { nowIso } from '../../common/time.js';
import { AgentsService } from '../agents/agents.service.js';
import { EventsService } from '../events/events.service.js';
import { ExecutionService } from '../execution/execution.service.js';
import type { ExecutionOutcome } from '../orchestrator/orchestrator.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import { TasksService } from '../tasks/tasks.service.js';
import { WorkflowsService } from './workflows.service.js';
import { WorkflowFileHistoryService } from './workflow-file-history.service.js';

const RUNTIME_KEY = 'workflowRuntime';

type WorkflowRuntimeState = {
  schemaVersion: 2;
  runs: WorkflowRun[];
  nodeRunsByRunId: Record<string, WorkflowNodeRun[]>;
  approvalsByRunId: Record<string, WorkflowApprovalRecord[]>;
  effectsByRunId: Record<string, WorkflowEffect[]>;
};

type RuntimeContext = {
  session: SessionDetail;
  brief: TaskBrief;
  coordinatorId: string;
};

export type WorkflowRuntimeUpdate =
  | {
      kind: 'projection';
      sessionId: string;
      workflowRunId: string;
      sessionGeneration?: number;
      status: WorkflowRunStatus;
      revision: number;
    }
  | {
      kind: 'session_outcome';
      sessionId: string;
      workflowRunId: string;
      sessionGeneration?: number;
      outcome: ExecutionOutcome;
    };

export type StartWorkflowRunInput = {
  session: SessionDetail;
  brief: TaskBrief;
  coordinatorId: string;
  workflowId: string;
  workflowVersion?: number;
  confirmationId: string;
  sessionGeneration?: number;
  /**
   * The definition hash the user's selection was evaluated against. A republish
   * between member mapping and start keeps the same version number, so without
   * this the run would silently execute a graph the user never saw.
   */
  definitionHash?: string;
};

export type WorkflowHumanDecisionInput = {
  runId: string;
  nodeRunId: string;
  confirmationId: string;
  userId: string;
  expectedRunRevision?: number;
  decision: 'approve' | 'revise' | 'cancel';
  instruction?: string;
};

export type WorkflowAgentSubstitutionInput = {
  runId: string;
  taskId: string;
  agentId: string;
  confirmationId?: string;
};

export type WorkflowAgentSkipInput = {
  runId: string;
  taskId: string;
  reason: string;
  confirmationId?: string;
};

export type WorkflowAgentSubstitutionRequest = {
  taskId: string;
  workflowRunId: string;
  workflowNodeId?: string;
  currentAgentId: string;
  candidates: Array<{ id: string; key: string; name: string; role: string }>;
  reason: string;
  confirmationId: string;
};

export type WorkflowUpstreamRerunRequest = {
  taskId: string;
  workflowRunId: string;
  workflowNodeId?: string;
  reason: string;
  missingInputs: string[];
};

export type WorkflowUpstreamRerunInput = {
  runId: string;
  confirmationId: string;
  nodeId: string;
  instruction?: string;
};

export type WorkflowParkedNodeRetryInput = {
  runId: string;
  confirmationId: string;
};

@Injectable()
export class WorkflowRuntimeService {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly nodeRunsByRunId = new Map<string, WorkflowNodeRun[]>();
  private readonly approvalsByRunId = new Map<string, WorkflowApprovalRecord[]>();
  private readonly effectsByRunId = new Map<string, WorkflowEffect[]>();
  private readonly contexts = new Map<string, RuntimeContext>();
  private readonly commandTails = new Map<string, Promise<unknown>>();
  private readonly supersededNodeRunIds = new Set<string>();
  private readonly updatesSubject = new Subject<WorkflowRuntimeUpdate>();
  private readonly lifecycle: SessionLifecycleStore;

  constructor(
    private readonly workflows: WorkflowsService,
    private readonly agents: AgentsService,
    private readonly tasks: TasksService,
    private readonly events: EventsService,
    private readonly execution: ExecutionService,
    private readonly persistence: PersistenceService,
    @Optional() private readonly fileHistory?: WorkflowFileHistoryService
  ) {
    this.lifecycle = new SessionLifecycleStore(persistence);
    const state = this.persistence.getCollection<WorkflowRuntimeState>(RUNTIME_KEY, {
      schemaVersion: 2,
      runs: [],
      nodeRunsByRunId: {},
      approvalsByRunId: {},
      effectsByRunId: {}
    });
    for (const run of state.runs ?? []) this.runs.set(run.id, run);
    for (const [runId, items] of Object.entries(state.nodeRunsByRunId ?? {})) this.nodeRunsByRunId.set(runId, items);
    for (const [runId, items] of Object.entries(state.approvalsByRunId ?? {})) this.approvalsByRunId.set(runId, items);
    for (const [runId, items] of Object.entries(state.effectsByRunId ?? {})) this.effectsByRunId.set(runId, items);
  }

  updates() {
    return this.updatesSubject.asObservable();
  }

  get(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundException(`Workflow run not found: ${runId}`);
    return run;
  }

  findBySession(sessionId: string) {
    return [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  listBySession(sessionId: string) {
    return [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listNodeRuns(runId: string) {
    this.get(runId);
    return this.nodeRunsByRunId.get(runId) ?? [];
  }

  listApprovals(runId: string) {
    this.get(runId);
    return this.approvalsByRunId.get(runId) ?? [];
  }

  async start(input: StartWorkflowRunInput) {
    const startIdempotencyKey = `${input.session.id}:${input.confirmationId}`;
    const existing = [...this.runs.values()].find((run) => run.startIdempotencyKey === startIdempotencyKey);
    if (existing) return existing;
    if (!this.lifecycle.matchesActiveGeneration(input.session.id, input.sessionGeneration)) {
      throw new ConflictException('SESSION_ADMISSION_CLOSED');
    }

    const version = this.workflows.getVersion(input.workflowId, input.workflowVersion);
    const workflow = this.workflows.get(input.workflowId);
    if (workflow.status !== 'published') throw new BadRequestException('Only published workflows can be executed.');
    // The caller pins the exact definition the user approved. A republish between
    // selection and start changes node order and rework edges, so an unnoticed
    // swap would execute a graph the user never saw.
    if (input.definitionHash !== undefined && input.definitionHash !== version.definitionHash) {
      throw new ConflictException('WORKFLOW_VERSION_CHANGED');
    }
    const firstNode = version.nodes[0];
    if (!firstNode) throw new BadRequestException('Published workflow has no nodes.');
    const now = nowIso();
    const run: WorkflowRun = {
      id: crypto.randomUUID(),
      workflowId: version.workflowId,
      workflowVersion: version.version,
      workflowName: version.name,
      sessionId: input.session.id,
      ...(input.sessionGeneration !== undefined ? { sessionGeneration: input.sessionGeneration } : {}),
      workItemId: input.session.activeWorkItemId,
      briefId: input.brief.id,
      ownerId: input.session.ownerId,
      definitionSnapshot: structuredClone(version),
      status: 'running',
      currentNodeId: firstNode.id,
      revision: 1,
      runtimeVersion: 'v2',
      startIdempotencyKey,
      createdAt: now,
      updatedAt: now
    };
    this.runs.set(run.id, run);
    this.nodeRunsByRunId.set(run.id, []);
    this.approvalsByRunId.set(run.id, []);
    this.effectsByRunId.set(run.id, []);
    this.contexts.set(run.id, { session: input.session, brief: input.brief, coordinatorId: input.coordinatorId });
    input.session.workflowRunId = run.id;
    this.persist();

    if (this.fileHistory) {
      run.fileBaseline = await this.fileHistory.captureBaseline(input.session);
      this.persist();
    }

    await this.runEffect(run, 'emit_event', 'run-started', { confirmationId: input.confirmationId }, () => {
      this.events.createOnce(`workflow-run-started:${run.id}`, {
        sessionId: run.sessionId,
        type: 'workflow_run_started',
        content: `工作流「${run.workflowName}」v${run.workflowVersion} 已开始。`,
        metadata: createMetadata('system_notice', {
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          workflowRunId: run.id
        })
      });
      this.events.createOnce(`workflow-selected:${run.id}`, {
        sessionId: run.sessionId,
        type: 'user_confirmation_resolved',
        content: `用户选择工作流：${run.workflowName}`,
        metadata: createMetadata('system_notice', {
          confirmationId: input.confirmationId,
          status: 'approved',
          selectedOptionKey: `workflow:${run.workflowId}`,
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          workflowRunId: run.id
        })
      });
    });
    await this.publishProjection(run);
    await this.serialize(run.id, () => this.activateCurrentNode(run.id));
    return run;
  }

  async decideHuman(input: WorkflowHumanDecisionInput) {
    return this.serialize(input.runId, async () => {
      const run = this.get(input.runId);
      this.assertMutable(run, input.expectedRunRevision);
      if (run.status !== 'waiting_human') throw new BadRequestException(`Workflow run is not waiting for human: ${run.status}`);
      if (run.ownerId !== input.userId) throw new BadRequestException({ code: 'WORKFLOW_CONFIRMATION_FORBIDDEN' });
      // An upstream-rerun park also sits at waiting_human, but it is not an
      // approval gate: it must be resolved through rerunUpstreamNode.
      if (run.pendingUpstreamRerun) throw new BadRequestException({ code: 'WORKFLOW_UPSTREAM_RERUN_PENDING' });
      const nodeRun = this.listNodeRuns(run.id).find((item) => item.id === input.nodeRunId);
      if (
        !nodeRun ||
        nodeRun.nodeType !== 'human_approval' ||
        nodeRun.status !== 'waiting' ||
        nodeRun.confirmationId !== input.confirmationId
      ) {
        throw new BadRequestException({ code: 'WORKFLOW_CONFIRMATION_ALREADY_RESOLVED' });
      }
      const existing = this.listApprovals(run.id).find((item) => item.confirmationId === input.confirmationId);
      if (existing) return { run, nodeRun, approval: existing };

      const approval: WorkflowApprovalRecord = {
        id: `wf-approval:${input.confirmationId}`,
        workflowRunId: run.id,
        nodeRunId: nodeRun.id,
        confirmationId: input.confirmationId,
        actor: { type: 'user', id: input.userId },
        decision: input.decision,
        reason: input.instruction?.trim() || this.defaultDecisionReason(input.decision),
        revisionInstruction: input.decision === 'revise' ? input.instruction?.trim() : undefined,
        evidenceRefs: [],
        createdAt: nowIso()
      };
      this.approvalsByRunId.set(run.id, [...this.listApprovals(run.id), approval]);
      nodeRun.status = input.decision === 'approve' ? 'approved' : input.decision === 'revise' ? 'revision_requested' : 'completed';
      nodeRun.completedAt = nowIso();
      run.revision += 1;
      run.updatedAt = nowIso();
      this.persist();
      await this.emitGateDecision(run, nodeRun, approval);

      if (input.decision === 'cancel') {
        await this.finishRun(run, 'cancelled');
      } else if (input.decision === 'revise') {
        await this.revisePreviousAgent(run, input.instruction?.trim() || '请根据人工确认意见修改上一环节输出。');
      } else {
        await this.advanceAfterNode(run, nodeRun.nodeId);
      }
      return { run, nodeRun, approval };
    });
  }

  async cancel(runId: string, reason = '用户取消工作流。') {
    return this.serialize(runId, async () => {
      const run = this.get(runId);
      if (this.isTerminal(run.status)) return run;
      const context = this.contexts.get(run.id);
      this.execution.cancel(
        run.sessionId,
        createExecutionTermination({ kind: 'user_cancelled', source: 'user', scope: 'session', diagnosticRef: reason })
      );
      this.tasks.cancelUnfinished(run.sessionId, reason);
      await this.finishRun(run, 'cancelled');
      if (context) {
        context.session.workflowRun = context.session.workflowRun
          ? { ...context.session.workflowRun, status: 'cancelled', updatedAt: nowIso() }
          : undefined;
      }
      return run;
    });
  }

  async rescheduleCurrentExecution(runId: string, diagnosticRef?: string) {
    return this.serialize(runId, async () => {
      const run = this.get(runId);
      if (this.isTerminal(run.status)) return false;
      const nodeRun = this.currentNodeRun(run);
      if (!nodeRun?.relatedTaskId || nodeRun.status !== 'running') return false;
      if (!this.execution.isRunning(run.sessionId)) return false;
      this.supersededNodeRunIds.add(nodeRun.id);
      this.execution.cancel(
        run.sessionId,
        createExecutionTermination({
          kind: 'superseded',
          source: 'orchestrator',
          scope: 'phase',
          ...(diagnosticRef ? { diagnosticRef } : {})
        })
      );
      return true;
    });
  }

  /**
   * True when the current node is parked on an Agent that declined the task and
   * is waiting for an explicit user substitution or skip. Resuming such a run
   * implicitly would restore the node default Agent and reproduce the refusal.
   */
  awaitsAgentSubstitution(runId: string) {
    const run = this.runs.get(runId);
    if (!run || this.isTerminal(run.status)) return false;
    if (run.pendingAgentSubstitution) return true;
    const nodeRun = this.currentNodeRun(run);
    if (!nodeRun || !['running', 'waiting'].includes(nodeRun.status) || !nodeRun.relatedTaskId) return false;
    return this.tasks.find(run.sessionId, nodeRun.relatedTaskId)?.status === 'blocked';
  }

  /** Persist the explicit decision point created by an intake rejection. */
  async requestAgentSubstitution(request: WorkflowAgentSubstitutionRequest) {
    return this.serialize(request.workflowRunId, async () => {
      const run = this.get(request.workflowRunId);
      if (this.isTerminal(run.status)) return run.pendingAgentSubstitution;
      if (run.pendingAgentSubstitution) return run.pendingAgentSubstitution;
      const nodeRun = this.currentNodeRun(run);
      if (!nodeRun || nodeRun.relatedTaskId !== request.taskId) return undefined;
      const node = run.definitionSnapshot.nodes.find((item) => item.id === nodeRun.nodeId);
      if (node?.type !== 'agent') return undefined;
      const pending: WorkflowPendingAgentSubstitution = {
        nodeId: node.id,
        nodeRunId: nodeRun.id,
        taskId: request.taskId,
        currentAgentId: request.currentAgentId,
        reason: request.reason,
        candidates: request.candidates,
        confirmationId: request.confirmationId,
        requestedAt: nowIso()
      };
      nodeRun.status = 'waiting';
      run.pendingAgentSubstitution = pending;
      run.status = 'waiting_human';
      run.revision += 1;
      run.updatedAt = nowIso();
      this.persist();
      this.ensureAgentSubstitutionConfirmation(run, pending);
      await this.publishProjection(run);
      return pending;
    });
  }

  async resumeCurrentExecution(
    runId: string,
    recoveryContext?: {
      session: SessionDetail;
      brief: TaskBrief;
      coordinatorId: string;
      sessionGeneration?: number;
    }
  ) {
    return this.serialize(runId, async () => {
      const run = this.get(runId);
      if (this.execution.isRunning(run.sessionId)) return false;
      if (this.awaitsAgentSubstitution(run.id)) return false;
      if (this.awaitsUpstreamRerun(run.id)) return false;
      if (
        recoveryContext &&
        run.workItemId &&
        recoveryContext.session.activeWorkItemId !== run.workItemId
      ) return false;
      if (recoveryContext) {
        if (!this.lifecycle.matchesActiveGeneration(run.sessionId, recoveryContext.sessionGeneration)) return false;
        this.contexts.set(run.id, recoveryContext);
        if (recoveryContext.sessionGeneration !== undefined &&
          run.sessionGeneration !== recoveryContext.sessionGeneration) {
          run.sessionGeneration = recoveryContext.sessionGeneration;
          run.revision += 1;
          run.updatedAt = nowIso();
          this.persist();
        }
      }
      if (run.status === 'failed') {
        const failedNodeId = this.failedNodeId(run);
        if (!failedNodeId || !this.contexts.has(run.id)) return false;
        run.currentNodeId = failedNodeId;
        this.failCurrentNodeRun(run);
        run.status = 'running';
        run.failure = undefined;
        run.completedAt = undefined;
        run.revision += 1;
        run.updatedAt = nowIso();
        this.persist();
        await this.publishProjection(run);
        await this.activateCurrentNode(run.id);
        return true;
      }
      if (this.isTerminal(run.status)) return false;
      const nodeRun = this.currentNodeRun(run);
      const task = nodeRun?.relatedTaskId ? this.tasks.find(run.sessionId, nodeRun.relatedTaskId) : undefined;
      if (!nodeRun || nodeRun.status !== 'running' || !task) return false;
      this.restoreWorkflowNodeAgent(run, task);
      this.reconcileTaskDependencies(run, nodeRun, task);
      this.tasks.update(task, { status: 'pending', resultSummary: undefined });
      await this.scheduleTaskExecution(run, nodeRun, task, true);
      return true;
    });
  }

  /**
   * Persists an interrupted node as a retryable failure without starting work.
   * The next explicit resume creates a fresh node attempt through the existing
   * failed-run recovery path.
   */
  checkpointInterruptedExecution(
    runId: string,
    failure: { code: string; message: string }
  ) {
    const run = this.get(runId);
    if (this.isTerminal(run.status)) return false;
    // A parked upstream-rerun is already a durable user-decision point; failing it
    // here would drop the candidate list and the card that resolves it.
    if (run.pendingUpstreamRerun || run.pendingAgentSubstitution) return false;
    const nodeId = run.currentNodeId ?? this.currentNodeRun(run)?.nodeId;
    this.failCurrentNodeRun(run, { ...failure, nodeId });
    const interruptedNodeRun = this.currentNodeRun(run);
    const interruptedTask = interruptedNodeRun?.relatedTaskId
      ? this.tasks.find(run.sessionId, interruptedNodeRun.relatedTaskId)
      : undefined;
    if (interruptedTask) {
      if (interruptedNodeRun) interruptedNodeRun.executionCheckpoint = interruptedTask.executionCheckpoint;
      this.tasks.update(interruptedTask, { status: 'failed', resultSummary: failure.message });
    }
    run.status = 'failed';
    run.failure = { ...failure, ...(nodeId ? { nodeId } : {}) };
    run.revision += 1;
    run.updatedAt = nowIso();
    run.completedAt = nowIso();
    this.persist();
    this.updatesSubject.next({
      kind: 'projection',
      sessionId: run.sessionId,
      workflowRunId: run.id,
      ...(run.sessionGeneration !== undefined ? { sessionGeneration: run.sessionGeneration } : {}),
      status: run.status,
      revision: run.revision
    });
    return true;
  }

  async substituteCurrentAgent(input: WorkflowAgentSubstitutionInput) {
    return this.serialize(input.runId, async () => {
      const run = this.get(input.runId);
      if (this.isTerminal(run.status)) throw new ConflictException(`Workflow run is terminal: ${run.status}`);
      const pending = run.pendingAgentSubstitution;
      if (input.confirmationId && !pending) {
        throw new BadRequestException({ code: 'WORKFLOW_AGENT_SUBSTITUTION_ALREADY_RESOLVED' });
      }
      if (pending && input.confirmationId && pending.confirmationId !== input.confirmationId) {
        throw new BadRequestException({ code: 'WORKFLOW_AGENT_SUBSTITUTION_CONFIRMATION_MISMATCH' });
      }
      if (pending && (pending.taskId !== input.taskId || pending.candidates.every((agent) => agent.id !== input.agentId))) {
        throw new BadRequestException({ code: 'WORKFLOW_AGENT_SUBSTITUTION_TARGET_INVALID' });
      }
      if (this.execution.isRunning(run.sessionId)) {
        throw new ConflictException('Workflow execution is still running.');
      }
      const context = this.context(run.id);
      const node = this.currentNode(run);
      const nodeRun = this.currentNodeRun(run);
      if (node?.type !== 'agent' || !nodeRun || !['running', 'waiting'].includes(nodeRun.status) || nodeRun.relatedTaskId !== input.taskId) {
        throw new BadRequestException(`Workflow Agent task is not current: ${input.taskId}`);
      }
      const task = this.tasks.find(run.sessionId, input.taskId);
      if (!task || task.workflowRunId !== run.id || task.workflowNodeId !== node.id) {
        throw new BadRequestException(`Workflow task does not belong to the current node: ${input.taskId}`);
      }
      const agent = this.agents.getForSurface(input.agentId, 'workflow');
      if (!context.session.participatingAgentIds.includes(agent.id)) {
        throw new BadRequestException(`Agent is not part of this session: ${agent.id}`);
      }
      const previousAssignee = task.assignee;
      run.pendingAgentSubstitution = undefined;
      run.status = 'running';
      nodeRun.status = 'running';
      run.revision += 1;
      run.updatedAt = nowIso();
      this.persist();
      this.tasks.update(task, {
        status: 'pending',
        assignee: { type: 'agent', id: agent.id },
        eligibleAgentIds: [agent.id],
        autoResolutionAttempted: false,
        workflowAgentOverride: true,
        resultSummary: undefined
      });
      this.events.create({
        sessionId: run.sessionId,
        type: 'task_reassigned',
        taskId: task.id,
        fromAgentId: context.coordinatorId,
        toAgentIds: [agent.id, context.coordinatorId],
        content: `用户已将工作流任务「${task.title}」改派给 ${agent.name}。`,
        metadata: createMetadata('task_card', {
          taskId: task.id,
          title: task.title,
          status: 'assigned',
          assignedBy: task.assignedBy,
          assignee: task.assignee,
          previousAssignee,
          eligibleAgentIds: task.eligibleAgentIds,
          workflowRunId: run.id,
          workflowNodeId: node.id,
          workflowNodeRunId: nodeRun.id,
          workflowAgentOverride: true
        })
      });
      await this.scheduleTaskExecution(run, nodeRun, task, true);
      return { run, task, agent };
    });
  }

  async skipCurrentAgent(input: WorkflowAgentSkipInput) {
    return this.serialize(input.runId, async () => {
      const run = this.get(input.runId);
      if (this.isTerminal(run.status)) throw new ConflictException(`Workflow run is terminal: ${run.status}`);
      const pending = run.pendingAgentSubstitution;
      if (input.confirmationId && !pending) {
        throw new BadRequestException({ code: 'WORKFLOW_AGENT_SUBSTITUTION_ALREADY_RESOLVED' });
      }
      if (pending && input.confirmationId && pending.confirmationId !== input.confirmationId) {
        throw new BadRequestException({ code: 'WORKFLOW_AGENT_SUBSTITUTION_CONFIRMATION_MISMATCH' });
      }
      if (pending && pending.taskId !== input.taskId) {
        throw new BadRequestException({ code: 'WORKFLOW_AGENT_SUBSTITUTION_TARGET_INVALID' });
      }
      if (this.execution.isRunning(run.sessionId)) {
        throw new ConflictException('Workflow execution is still running.');
      }
      const node = this.currentNode(run);
      const nodeRun = this.currentNodeRun(run);
      if (node?.type !== 'agent' || !nodeRun || !['running', 'waiting'].includes(nodeRun.status) || nodeRun.relatedTaskId !== input.taskId) {
        throw new BadRequestException(`Workflow Agent task is not current: ${input.taskId}`);
      }
      const task = this.tasks.find(run.sessionId, input.taskId);
      if (!task || task.workflowRunId !== run.id || task.workflowNodeId !== node.id) {
        throw new BadRequestException(`Workflow task does not belong to the current node: ${input.taskId}`);
      }

      const reason = input.reason.trim() || '用户要求跳过当前工作流 Agent 并继续执行。';
      this.tasks.update(task, { status: 'cancelled', resultSummary: reason });
      run.pendingAgentSubstitution = undefined;
      run.status = 'running';
      nodeRun.status = 'skipped';
      nodeRun.outputSummary = reason;
      nodeRun.outputRefs = [];
      nodeRun.completedAt = nowIso();
      run.revision += 1;
      run.updatedAt = nowIso();
      this.persist();
      await this.emitNodeCompleted(run, nodeRun);
      await this.advanceAfterNode(run, node.id);
      return { run, task, nodeRun };
    });
  }

  /**
   * True while the current node reported incomplete upstream input and is waiting
   * for the user to pick an upstream node to re-run. Resuming implicitly would
   * re-run the same node against the same missing output.
   */
  awaitsUpstreamRerun(runId: string) {
    const run = this.runs.get(runId);
    return Boolean(run && !this.isTerminal(run.status) && run.pendingUpstreamRerun);
  }

  pendingUpstreamRerun(runId: string) {
    return this.runs.get(runId)?.pendingUpstreamRerun;
  }

  awaitsRevisionHandoff(runId: string) {
    const run = this.runs.get(runId);
    return Boolean(run && !this.isTerminal(run.status) && run.pendingRevisionHandoff);
  }

  pendingRevisionHandoff(runId: string) {
    return this.runs.get(runId)?.pendingRevisionHandoff;
  }

  /**
   * Previously executed Agent nodes the given node can be sent back to. Approval
   * gates are excluded: they hold no re-executable work of their own.
   */
  upstreamRerunCandidates(runId: string, nodeId?: string): WorkflowUpstreamRerunCandidate[] {
    const run = this.runs.get(runId);
    const targetNodeId = nodeId ?? run?.currentNodeId;
    if (!run || !targetNodeId) return [];
    const nodes = run.definitionSnapshot.nodes;
    const graphUpstream = this.upstreamNodeIds(run, targetNodeId);
    // Definition order is the fallback because advanceAfterNode itself walks the
    // node array; a published version with no edges still has a real predecessor.
    const targetIndex = nodes.findIndex((node) => node.id === targetNodeId);
    const eligible = nodes.filter((node, index) =>
      node.type === 'agent' &&
      node.id !== targetNodeId &&
      (graphUpstream.has(node.id) || (graphUpstream.size === 0 && targetIndex >= 0 && index < targetIndex)));
    const nodeRuns = this.listNodeRuns(run.id);
    return eligible.map((node) => {
      const agentNode = node as Extract<WorkflowNode, { type: 'agent' }>;
      let agentName = agentNode.agentId;
      try {
        agentName = this.agents.getByIdOrKey(agentNode.agentId).name;
      } catch {
        // A published snapshot can outlive the Agent; the node stays selectable.
      }
      const lastRun = [...nodeRuns].reverse().find((item) => item.nodeId === node.id);
      return {
        nodeId: node.id,
        nodeName: node.name?.trim() || agentName,
        agentId: agentNode.agentId,
        agentName,
        ...(lastRun?.outputSummary ? { lastOutputSummary: lastRun.outputSummary } : {})
      };
    });
  }

  /**
   * Parks the current Agent node because it reported that its upstream input is
   * incomplete, and records the upstream nodes the user can send it back to.
   * Returns undefined when there is no upstream Agent node to offer, so the
   * caller can fall back to the generic recovery card.
   */
  async requestUpstreamRerun(request: WorkflowUpstreamRerunRequest) {
    return this.serialize(request.workflowRunId, async () => {
      const run = this.get(request.workflowRunId);
      if (this.isTerminal(run.status)) return undefined;
      const nodeRun = this.currentNodeRun(run);
      if (!nodeRun || nodeRun.relatedTaskId !== request.taskId) return undefined;
      return this.parkForUpstreamRerun(run, nodeRun, request);
    });
  }

  private async parkForUpstreamRerun(
    run: WorkflowRun,
    nodeRun: WorkflowNodeRun,
    request: WorkflowUpstreamRerunRequest
  ) {
    if (run.pendingUpstreamRerun) return run.pendingUpstreamRerun;
    const candidates = this.upstreamRerunCandidates(run.id, nodeRun.nodeId);
    if (!candidates.length) return undefined;

    const confirmationId = `workflow-upstream-rerun:${run.id}:${nodeRun.id}`;
    run.pendingUpstreamRerun = {
      nodeId: nodeRun.nodeId,
      nodeRunId: nodeRun.id,
      taskId: request.taskId,
      reason: request.reason,
      missingInputs: request.missingInputs,
      candidates,
      requestedAt: nowIso()
    };
    run.status = 'waiting_human';
    run.revision += 1;
    run.updatedAt = nowIso();
    this.persist();
    const node = run.definitionSnapshot.nodes.find((item) => item.id === nodeRun.nodeId);
    const nodeLabel = node?.name?.trim() || nodeRun.nodeId;
    await this.runEffect(run, 'emit_event', `${nodeRun.id}:upstream-rerun`, { confirmationId }, () => {
      this.events.createOnce(`workflow-upstream-rerun-gate:${nodeRun.id}`, {
        sessionId: run.sessionId,
        type: 'workflow_gate_requested',
        priority: 'high',
        content: `节点「${nodeLabel}」报告上游产物不完整，已暂停等待用户选择返回哪个上游节点。`,
        metadata: createMetadata('system_notice', {
          ...this.eventRefs(run, nodeRun),
          reason: request.reason,
          missingInputs: request.missingInputs
        })
      });
      this.events.createOnce(`workflow-upstream-rerun-confirmation:${nodeRun.id}`, {
        sessionId: run.sessionId,
        type: 'user_confirmation_requested',
        priority: 'high',
        content: `「${nodeLabel}」无法继续：上一环节的产物不完整。请选择要重新执行的上游节点。`,
        metadata: createMetadata('confirmation_card', {
          confirmationId,
          reason: 'workflow_upstream_rerun',
          title: '选择要重新执行的上游节点',
          description: [
            request.reason,
            request.missingInputs.length ? `缺少的上游输入：${request.missingInputs.join('；')}` : undefined,
            '选择一个上游节点后，工作流会从该节点重新执行，并在其完成后重新走到当前节点。'
          ].filter(Boolean).join('\n'),
          workflowId: run.workflowId,
          workflowRunId: run.id,
          workflowNodeId: nodeRun.nodeId,
          workflowNodeRunId: nodeRun.id,
          relatedTaskId: request.taskId,
          expectedRunRevision: run.revision,
          missingInputs: request.missingInputs,
          candidateNodeIds: candidates.map((candidate) => candidate.nodeId),
          options: [
            ...candidates.map((candidate, index) => ({
              key: `node:${candidate.nodeId}`,
              label: `退回「${candidate.nodeName}」重新执行`,
              style: index === 0 ? 'primary' as const : 'default' as const
            })),
            { key: 'retry_current', label: '不退回，重试当前节点', style: 'default' as const },
            { key: 'cancel', label: '终止工作流', style: 'danger' as const }
          ]
        })
      });
    });
    await this.publishProjection(run);
    return run.pendingUpstreamRerun;
  }

  /**
   * Sends a parked node back to a chosen upstream Agent node. The parked node run
   * is closed as revision_requested and its task cancelled, so the forward walk
   * creates a fresh attempt once the upstream node completes.
   */
  async rerunUpstreamNode(input: WorkflowUpstreamRerunInput) {
    return this.serialize(input.runId, async () => {
      const run = this.get(input.runId);
      const pending = run.pendingUpstreamRerun;
      if (!pending || pending.candidates.every((candidate) => candidate.nodeId !== input.nodeId)) {
        throw new BadRequestException({ code: 'WORKFLOW_UPSTREAM_RERUN_TARGET_INVALID' });
      }
      if (`workflow-upstream-rerun:${run.id}:${pending.nodeRunId}` !== input.confirmationId) {
        throw new BadRequestException({ code: 'WORKFLOW_UPSTREAM_RERUN_CONFIRMATION_MISMATCH' });
      }
      if (this.execution.isRunning(run.sessionId)) {
        throw new ConflictException('Workflow execution is still running.');
      }
      this.closeParkedNodeRun(run, pending.nodeRunId, '用户选择退回上游节点重新执行。');
      run.pendingUpstreamRerun = undefined;
      run.failure = undefined;
      run.completedAt = undefined;
      this.persist();
      const instruction = input.instruction?.trim() ||
        `下游节点报告上游产物不完整：${pending.reason}${pending.missingInputs.length ? ` 缺少：${pending.missingInputs.join('；')}` : ''} 请补齐本阶段产物。`;
      await this.revisePreviousAgent(run, instruction, input.nodeId);
      return run;
    });
  }

  /** Retries the parked node itself without re-running any upstream node. */
  async retryParkedNode(input: WorkflowParkedNodeRetryInput) {
    return this.serialize(input.runId, async () => {
      const run = this.get(input.runId);
      const pending = run.pendingUpstreamRerun;
      if (!pending) throw new BadRequestException({ code: 'WORKFLOW_UPSTREAM_RERUN_NOT_PENDING' });
      if (`workflow-upstream-rerun:${run.id}:${pending.nodeRunId}` !== input.confirmationId) {
        throw new BadRequestException({ code: 'WORKFLOW_UPSTREAM_RERUN_CONFIRMATION_MISMATCH' });
      }
      if (this.execution.isRunning(run.sessionId)) {
        throw new ConflictException('Workflow execution is still running.');
      }
      this.closeParkedNodeRun(run, pending.nodeRunId, '用户选择重试当前节点。');
      run.pendingUpstreamRerun = undefined;
      run.status = 'running';
      run.currentNodeId = pending.nodeId;
      run.failure = undefined;
      run.completedAt = undefined;
      run.revision += 1;
      run.updatedAt = nowIso();
      this.persist();
      await this.publishProjection(run);
      await this.activateCurrentNode(run.id);
      return run;
    });
  }

  /**
   * Closes a parked node run and cancels its task. The task must reach a terminal
   * status: Post Review re-drives every non-terminal workflow task, so a task
   * left blocked would be picked up again after the run finishes.
   */
  private closeParkedNodeRun(run: WorkflowRun, nodeRunId: string, reason: string) {
    const nodeRun = this.listNodeRuns(run.id).find((item) => item.id === nodeRunId);
    if (!nodeRun) return;
    if (nodeRun.status === 'running' || nodeRun.status === 'waiting') {
      nodeRun.status = 'revision_requested';
      nodeRun.completedAt = nowIso();
    }
    const task = nodeRun.relatedTaskId ? this.tasks.find(run.sessionId, nodeRun.relatedTaskId) : undefined;
    if (!task) return;
    if (['completed', 'cancelled', 'failed', 'rejected'].includes(task.status)) {
      // Already terminal (markTaskFailed ran when the node reported blocked), so
      // Post Review will not re-drive it. Keep the original failure text and just
      // append why the node was closed.
      this.tasks.update(task, {
        resultSummary: task.resultSummary ? `${task.resultSummary} ${reason}` : reason
      });
      return;
    }
    this.tasks.update(task, { status: 'cancelled', resultSummary: reason });
  }

  /**
   * Re-drives a post-review rework inside the existing run instead of starting a
   * new one. Only the last executed Agent node is retried; already approved
   * upstream nodes keep their outputs and are never replayed.
   */
  async reworkLastAgentNode(
    runId: string,
    instruction: string,
    recoveryContext?: RuntimeContext
  ) {
    return this.serialize(runId, async () => {
      const run = this.get(runId);
      if (recoveryContext) this.contexts.set(run.id, recoveryContext);
      if (!this.contexts.has(run.id)) return false;
      if (this.execution.isRunning(run.sessionId)) return false;
      const target = [...this.listNodeRuns(run.id)]
        .reverse()
        .find((item) => item.nodeType === 'agent' &&
          run.definitionSnapshot.nodes.some((node) => node.id === item.nodeId && node.type === 'agent'));
      if (!target) return false;
      run.status = 'running';
      run.currentNodeId = target.nodeId;
      run.failure = undefined;
      run.completedAt = undefined;
      run.revision += 1;
      run.updatedAt = nowIso();
      this.persist();
      await this.publishProjection(run);
      await this.revisePreviousAgent(run, instruction, target.nodeId);
      return true;
    });
  }

  async recover(session: SessionDetail, brief: TaskBrief, coordinatorId: string) {
    const run = this.findBySession(session.id);
    if (!run || this.isTerminal(run.status)) return run;
    this.contexts.set(run.id, { session, brief, coordinatorId });
    session.workflowRunId = run.id;
    if (run.pendingAgentSubstitution) this.ensureAgentSubstitutionConfirmation(run, run.pendingAgentSubstitution);
    await this.publishProjection(run);
    // A parked upstream-rerun keeps its card as the only way forward. Re-activating
    // the node here would replay it against the same incomplete upstream output.
    if (run.pendingUpstreamRerun || run.pendingAgentSubstitution) return run;
    if (run.status === 'waiting_human') {
      const waiting = this.currentNodeRun(run)?.status === 'waiting';
      if (!waiting) await this.serialize(run.id, () => this.activateCurrentNode(run.id));
      return run;
    }
    const current = this.currentNodeRun(run);
    if (current?.relatedTaskId) {
      const task = this.tasks.find(session.id, current.relatedTaskId);
      if (task?.status === 'completed') {
        await this.serialize(run.id, () => this.completeExecutedNode(run.id, current.id, task.resultSummary ?? '节点已完成。'));
      } else if (!this.execution.isRunning(session.id)) {
        if (task) {
          this.restoreWorkflowNodeAgent(run, task);
          this.reconcileTaskDependencies(run, current, task);
        }
        if (task?.status === 'running') this.tasks.update(task, { status: 'pending' });
        await this.scheduleTaskExecution(run, current, task);
      }
      return run;
    }
    await this.serialize(run.id, () => this.activateCurrentNode(run.id));
    return run;
  }

  async acceptExecutionOutcome(sessionId: string, outcome: ExecutionOutcome) {
    const run = this.findBySession(sessionId);
    if (!run || this.isTerminal(run.status)) return false;
    const nodeRun = [...this.listNodeRuns(run.id)]
      .reverse()
      .find((item) => item.status === 'running' && Boolean(item.relatedTaskId));
    if (!nodeRun) return false;
    await this.serialize(run.id, () => this.handleExecutionOutcome(run.id, nodeRun.id, outcome));
    return true;
  }

  private async activateCurrentNode(runId: string) {
    const run = this.get(runId);
    if (this.isTerminal(run.status)) return;
    const node = this.currentNode(run);
    if (!node) {
      await this.finishRun(run, 'completed');
      return;
    }
    if (node.type === 'agent') await this.activateAgent(run, node);
    else if (node.type === 'human_approval') await this.activateHuman(run, node, false);
    else await this.activateRobot(run, node);
  }

  private async activateAgent(run: WorkflowRun, node: Extract<WorkflowNode, { type: 'agent' }>) {
    const context = this.context(run.id);
    const attempt = this.nextAttempt(run.id, node.id);
    const upstreamTaskIds = this.latestUpstreamTaskIds(run, node.id);
    const nodeRun: WorkflowNodeRun = {
      id: `wf-node-run:${run.id}:${node.id}:${attempt}`,
      workflowRunId: run.id,
      nodeId: node.id,
      nodeType: 'agent',
      attempt,
      status: 'running',
      inputRefs: [context.brief.id, ...this.latestUpstreamOutputRefs(run, node.id)],
      outputRefs: [],
      startedAt: nowIso()
    };
    this.appendNodeRun(nodeRun);
    const agent = this.agents.getByIdOrKey(node.agentId);
    const previousNodeRun = this.listNodeRuns(run.id).filter(item => item.nodeId === node.id && item.attempt < attempt)
      .sort((left, right) => right.attempt - left.attempt)[0];
    const previousTask = previousNodeRun?.status === 'failed' && previousNodeRun.relatedTaskId
      ? this.tasks.find(run.sessionId, previousNodeRun.relatedTaskId) : undefined;
    const recoveryTask = previousTask?.assignee?.id === agent.id ? previousTask : undefined;
    const taskId = `wf-task:${run.id}:${node.id}:${attempt}`;
    const stageAcceptanceCriteria = node.outputContract?.length
      ? [...node.outputContract]
      : this.defaultStageOutputContract(agent);
    const task: AgentTask = {
      id: taskId,
      recoveryOriginTaskId: recoveryTask?.id,
      previousExecutionOperationId: recoveryTask?.executionOperationId,
      sessionId: run.sessionId,
      workItemId: run.workItemId,
      title: node.name?.trim() || `工作流阶段 · ${agent.name}`,
      description: node.stageDescription?.trim() || `执行工作流「${run.workflowName}」中的 ${agent.name} 阶段。`,
      status: 'assigned',
      assignedBy: { type: 'agent', id: context.coordinatorId },
      assignee: { type: 'agent', id: agent.id },
      eligibleAgentIds: [agent.id],
      routingMode: 'coordinator_controlled',
      autoResolutionAttempted: false,
      assignmentReason: `工作流「${run.workflowName}」节点 ${node.name ?? node.id}。`,
      contextRequirements: [
        '已确认任务契约',
        ...(node.inputContract?.length ? node.inputContract : this.defaultStageInputContract(agent, upstreamTaskIds.length > 0)),
        ...(attempt > 1 ? ['工作流返工说明和上一轮输出'] : upstreamTaskIds.length ? ['前序工作流节点产物'] : [])
      ],
      verificationPlan: stageAcceptanceCriteria,
      riskNotes: [],
      requiresUserConfirmation: false,
      workflowRunId: run.id,
      workflowNodeId: node.id,
      workflowNodeRunId: nodeRun.id,
      workflowNodeType: 'agent',
      workflowAttempt: attempt,
      workflowAgentOverride: false,
      executionPurpose: 'agent_work',
      dependsOnTaskIds: upstreamTaskIds,
      acceptanceCriteria: stageAcceptanceCriteria,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    nodeRun.relatedTaskId = taskId;
    this.persist();
    await this.runEffect(run, 'create_agent_task', `${node.id}:${attempt}:create`, { taskId }, () => this.tasks.add(task));
    this.emitWorkflowTaskAssignmentEvents(run, task);
    await this.emitNodeStarted(run, nodeRun, task.title);
    await this.scheduleTaskExecution(run, nodeRun, task);
  }

  private async activateRobot(run: WorkflowRun, node: Extract<WorkflowNode, { type: 'robot_approval' }>) {
    const context = this.context(run.id);
    const attempt = this.nextAttempt(run.id, node.id);
    const nodeRun: WorkflowNodeRun = {
      id: `wf-node-run:${run.id}:${node.id}:${attempt}`,
      workflowRunId: run.id,
      nodeId: node.id,
      nodeType: 'robot_approval',
      attempt,
      status: 'running',
      inputRefs: [context.brief.id, ...this.latestUpstreamOutputRefs(run, node.id)],
      outputRefs: [],
      startedAt: nowIso()
    };
    this.appendNodeRun(nodeRun);
    const reviewer = this.agents.getByIdOrKey(node.reviewerAgentId);
    const taskId = `wf-task:${run.id}:${node.id}:${attempt}`;
    const task: AgentTask = {
      id: taskId,
      sessionId: run.sessionId,
      workItemId: run.workItemId,
      title: node.name?.trim() || `机器人确认 · ${reviewer.name}`,
      description: [
        node.reviewPrompt,
        `通过标准：${node.criteria.join('；')}`,
        '只返回 JSON：{"decision":"approve|revise|reject","reason":"...","revisionInstruction":"...或null","evidenceRefs":[]}',
        '可修复的质量问题必须使用 revise，并提供明确的返工说明。',
        'decision=revise 时 revisionInstruction 必须是非空修改说明；approve/reject 时必须为 null。',
        'reject 表示问题不可恢复并会立即终止整个工作流，只能用于违反不可突破边界或继续返工也无法满足目标的情况。'
      ].join('\n'),
      status: 'assigned',
      assignedBy: { type: 'agent', id: context.coordinatorId },
      assignee: { type: 'agent', id: reviewer.id },
      eligibleAgentIds: [reviewer.id],
      routingMode: 'coordinator_controlled',
      autoResolutionAttempted: false,
      assignmentReason: `工作流「${run.workflowName}」机器人确认节点。`,
      contextRequirements: ['已确认任务契约', '最近有效上游输出', '只读评审标准'],
      verificationPlan: ['严格输出机器人确认 JSON Schema'],
      riskNotes: ['评审任务不得执行写文件或外部副作用'],
      requiresUserConfirmation: false,
      workflowRunId: run.id,
      workflowNodeId: node.id,
      workflowNodeRunId: nodeRun.id,
      workflowNodeType: 'robot_approval',
      workflowAttempt: attempt,
      workflowAgentOverride: false,
      executionPurpose: 'workflow_review',
      dependsOnTaskIds: [],
      acceptanceCriteria: node.criteria,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    nodeRun.relatedTaskId = taskId;
    this.persist();
    await this.runEffect(run, 'create_agent_task', `${node.id}:${attempt}:create`, { taskId }, () => this.tasks.add(task));
    this.emitWorkflowTaskAssignmentEvents(run, task);
    await this.emitNodeStarted(run, nodeRun, task.title);
    await this.scheduleTaskExecution(run, nodeRun, task);
  }

  private emitWorkflowTaskAssignmentEvents(run: WorkflowRun, task: AgentTask) {
    const assigneeId = task.assignee?.type === 'agent' ? task.assignee.id : undefined;
    const toAgentIds = assigneeId ? [assigneeId] : [];
    const payload = {
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
      dependsOnTaskIds: task.dependsOnTaskIds,
      acceptanceCriteria: task.acceptanceCriteria,
      workflowRunId: task.workflowRunId,
      workflowNodeId: task.workflowNodeId,
      workflowNodeRunId: task.workflowNodeRunId,
      workflowNodeType: task.workflowNodeType
    };
    this.events.createOnce(`workflow-task-created:${task.id}`, {
      sessionId: run.sessionId,
      type: 'task_created',
      taskId: task.id,
      fromAgentId: task.assignedBy?.type === 'agent' ? task.assignedBy.id : undefined,
      toAgentIds,
      content: `已创建工作流任务：${task.title}`,
      metadata: createMetadata('task_card', payload)
    });
    this.events.createOnce(`workflow-task-assigned:${task.id}`, {
      sessionId: run.sessionId,
      type: 'task_assigned',
      taskId: task.id,
      fromAgentId: task.assignedBy?.type === 'agent' ? task.assignedBy.id : undefined,
      toAgentIds,
      content: `接收者已分配工作流任务：${task.title}`,
      metadata: createMetadata('task_card', payload)
    });
  }

  private async activateHuman(
    run: WorkflowRun,
    node: Extract<WorkflowNode, { type: 'human_approval' }> | Extract<WorkflowNode, { type: 'robot_approval' }>,
    fallbackFromRobot: boolean
  ) {
    const attempt = this.nextAttempt(run.id, node.id);
    const confirmationId = `wf-confirm:${run.id}:${node.id}:${attempt}`;
    const nodeRun: WorkflowNodeRun = {
      id: `wf-node-run:${run.id}:${node.id}:${attempt}`,
      workflowRunId: run.id,
      nodeId: node.id,
      nodeType: 'human_approval',
      attempt,
      status: 'waiting',
      inputRefs: this.latestUpstreamOutputRefs(run, node.id),
      outputRefs: [],
      confirmationId,
      fallbackFromRobot,
      startedAt: nowIso()
    };
    this.appendNodeRun(nodeRun);
    run.status = 'waiting_human';
    run.revision += 1;
    run.updatedAt = nowIso();
    this.persist();
    await this.runEffect(run, 'emit_event', `${node.id}:${attempt}:confirm`, { confirmationId }, () => {
      this.events.createOnce(`workflow-human-gate:${nodeRun.id}`, {
        sessionId: run.sessionId,
        type: 'workflow_gate_requested',
        content: fallbackFromRobot ? '机器人确认无法自动完成，已转人工确认。' : `工作流等待人工确认：${node.name ?? node.id}`,
        metadata: createMetadata('system_notice', {
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          workflowRunId: run.id,
          workflowNodeId: node.id,
          workflowNodeRunId: nodeRun.id,
          fallbackFromRobot
        })
      });
      this.events.createOnce(`workflow-human-confirmation:${nodeRun.id}`, {
        sessionId: run.sessionId,
        type: 'user_confirmation_requested',
        priority: 'high',
        content: fallbackFromRobot ? '机器人确认失败，请人工决定是否继续。' : (node.type === 'human_approval' ? node.instruction : undefined) || '请确认上一工作流环节输出。',
        metadata: createMetadata('confirmation_card', {
          confirmationId,
          reason: 'confirm_workflow_human_gate',
          title: fallbackFromRobot ? '机器人确认转人工' : (node.type === 'human_approval' ? node.title : node.name) || '人工确认',
          description: this.latestUpstreamSummary(run, node.id) || '请检查上一环节输出后选择操作。',
          workflowId: run.workflowId,
          workflowName: run.workflowName,
          workflowRunId: run.id,
          workflowNodeId: node.id,
          workflowNodeRunId: nodeRun.id,
          expectedRunRevision: run.revision,
          options: [
            { key: 'approve', label: '通过并继续', style: 'primary' },
            { key: 'revise', label: '退回修改', style: 'default' },
            { key: 'cancel', label: '终止工作流', style: 'danger' }
          ]
        })
      });
    });
    await this.publishProjection(run);
  }

  private async scheduleTaskExecution(
    run: WorkflowRun,
    nodeRun: WorkflowNodeRun,
    task?: AgentTask,
    forceRestart = false
  ) {
    const context = this.context(run.id);
    const currentTask = task ?? (nodeRun.relatedTaskId ? this.tasks.find(run.sessionId, nodeRun.relatedTaskId) : undefined);
    if (!currentTask) throw new NotFoundException(`Workflow task not found for node run: ${nodeRun.id}`);
    context.session.workflowRun = {
      id: run.id,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      workflowName: run.workflowName,
      nodeTaskIds: [currentTask.id],
      completedTaskIds: [],
      currentStepIndex: 0,
      status: 'running',
      runtimeVersion: 'v2',
      createdAt: run.createdAt,
      updatedAt: nowIso()
    };
    await this.publishProjection(run);
    const startExecution = () => {
      const executionTasks = [
        ...currentTask.dependsOnTaskIds
          .map((taskId) => this.tasks.find(run.sessionId, taskId))
          .filter((item): item is AgentTask => Boolean(item)),
        currentTask
      ];
      this.execution.start(context.session, context.brief, executionTasks, (outcome) => {
        void this.serialize(run.id, () => this.handleExecutionOutcome(run.id, nodeRun.id, outcome));
      }, run.sessionGeneration);
    };
    if (forceRestart) {
      startExecution();
      return;
    }
    await this.runEffect(run, 'execute_agent_task', `${nodeRun.id}:execute`, { taskId: currentTask.id }, startExecution);
  }

  private async handleExecutionOutcome(runId: string, nodeRunId: string, outcome: ExecutionOutcome) {
    const run = this.get(runId);
    if (!this.lifecycle.matchesActiveGeneration(run.sessionId, run.sessionGeneration)) return;
    if (this.isTerminal(run.status)) return;
    const nodeRun = this.listNodeRuns(run.id).find((item) => item.id === nodeRunId);
    if (!nodeRun || nodeRun.status !== 'running') return;
    nodeRun.executionCheckpoint = nodeRun.relatedTaskId
      ? this.tasks.find(run.sessionId, nodeRun.relatedTaskId)?.executionCheckpoint : undefined;
    if (outcome.kind === 'workflow_step_completed') {
      await this.completeExecutedNode(run.id, nodeRun.id, outcome.resultSummary);
      return;
    }
    if (outcome.kind === 'cancelled') {
      if (outcome.termination?.kind === 'user_paused') {
        return;
      }
      if (this.supersededNodeRunIds.delete(nodeRun.id)) {
        const task = nodeRun.relatedTaskId ? this.tasks.find(run.sessionId, nodeRun.relatedTaskId) : undefined;
        if (!task) {
          await this.finishRun(run, 'failed', {
            code: 'WORKFLOW_TASK_NOT_FOUND',
            message: `Workflow task not found after reschedule: ${nodeRun.id}`,
            nodeId: nodeRun.nodeId
          });
          return;
        }
        this.tasks.update(task, { status: 'pending', resultSummary: undefined });
        await this.scheduleTaskExecution(run, nodeRun, task, true);
        return;
      }
      if (outcome.termination?.kind === 'user_cancelled' && outcome.termination.scope === 'invocation') {
        return;
      }
      await this.finishRun(run, 'cancelled', { code: 'WORKFLOW_EXECUTION_CANCELLED', message: outcome.reason, nodeId: nodeRun.nodeId });
      return;
    }
    if (outcome.kind === 'rework') {
      nodeRun.status = 'revision_requested';
      nodeRun.completedAt = nowIso();
      run.revision += 1;
      run.updatedAt = nowIso();
      this.persist();
      await this.activateCurrentNode(run.id);
      return;
    }
    if (outcome.kind === 'ask_user') {
      // The node ran and reported that an earlier stage did not deliver what it
      // needed. Park on an upstream-rerun card instead of the generic recovery
      // card, which can only resume the same node against the same input.
      const upstream = outcome.workflowUpstreamIncomplete;
      if (upstream && upstream.workflowRunId === run.id && upstream.taskId === nodeRun.relatedTaskId) {
        const parked = await this.parkForUpstreamRerun(run, nodeRun, upstream);
        if (parked) return;
      }
      this.updatesSubject.next({
        kind: 'session_outcome',
        sessionId: run.sessionId,
        workflowRunId: run.id,
        ...(run.sessionGeneration !== undefined ? { sessionGeneration: run.sessionGeneration } : {}),
        outcome
      });
      return;
    }
    if (outcome.kind === 'approval_required') {
      this.updatesSubject.next({
        kind: 'session_outcome',
        sessionId: run.sessionId,
        workflowRunId: run.id,
        ...(run.sessionGeneration !== undefined ? { sessionGeneration: run.sessionGeneration } : {}),
        outcome
      });
      return;
    }
    if (outcome.kind === 'workspace_conflict') {
      this.updatesSubject.next({
        kind: 'session_outcome',
        sessionId: run.sessionId,
        workflowRunId: run.id,
        ...(run.sessionGeneration !== undefined ? { sessionGeneration: run.sessionGeneration } : {}),
        outcome
      });
      return;
    }
    const reason = outcome.kind === 'failed'
      ? outcome.reason
      : '工作流节点未返回可识别的阶段结果。';
    await this.finishRun(run, 'failed', { code: 'WORKFLOW_NODE_EXECUTION_FAILED', message: reason, nodeId: nodeRun.nodeId });
  }

  private async completeExecutedNode(runId: string, nodeRunId: string, resultSummary: string) {
    const run = this.get(runId);
    const nodeRun = this.listNodeRuns(run.id).find((item) => item.id === nodeRunId);
    if (!nodeRun || nodeRun.status !== 'running') return;
    nodeRun.outputSummary = resultSummary;
    nodeRun.executionCheckpoint = nodeRun.relatedTaskId
      ? this.tasks.find(run.sessionId, nodeRun.relatedTaskId)?.executionCheckpoint : undefined;
    nodeRun.outputRefs = nodeRun.relatedTaskId ? [`task:${nodeRun.relatedTaskId}`] : [];
    nodeRun.completedAt = nowIso();
    const definitionNode = run.definitionSnapshot.nodes.find((node) => node.id === nodeRun.nodeId);
    if (!definitionNode) {
      await this.finishRun(run, 'failed', { code: 'WORKFLOW_NODE_NOT_FOUND', message: nodeRun.nodeId, nodeId: nodeRun.nodeId });
      return;
    }
    if (definitionNode.type === 'robot_approval') {
      await this.handleRobotResult(run, nodeRun, definitionNode, resultSummary);
      return;
    }
    nodeRun.status = 'completed';
    run.revision += 1;
    run.updatedAt = nowIso();
    this.persist();
    await this.emitNodeCompleted(run, nodeRun);
    await this.advanceAfterNode(run, nodeRun.nodeId);
  }

  private async handleRobotResult(
    run: WorkflowRun,
    nodeRun: WorkflowNodeRun,
    node: Extract<WorkflowNode, { type: 'robot_approval' }>,
    resultSummary: string
  ) {
    const parsed = this.parseRobotResult(resultSummary);
    if (!parsed) {
      nodeRun.status = 'failed';
      nodeRun.error = { code: 'WORKFLOW_ROBOT_RESULT_INVALID', message: '机器人确认结果不是合法 JSON Schema。', retryable: false };
      nodeRun.completedAt = nowIso();
      run.revision += 1;
      run.updatedAt = nowIso();
      this.persist();
      await this.activateHuman(run, node, true);
      return;
    }
    const approval: WorkflowApprovalRecord = {
      id: `wf-approval:${nodeRun.id}`,
      workflowRunId: run.id,
      nodeRunId: nodeRun.id,
      actor: { type: 'agent', id: node.reviewerAgentId },
      decision: parsed.decision,
      reason: parsed.reason,
      revisionInstruction: parsed.revisionInstruction,
      evidenceRefs: parsed.evidenceRefs,
      createdAt: nowIso()
    };
    this.approvalsByRunId.set(run.id, [...this.listApprovals(run.id), approval]);
    nodeRun.outputRefs = [...parsed.evidenceRefs];
    nodeRun.completedAt = nowIso();
    if (parsed.decision === 'approve') {
      nodeRun.status = 'approved';
      run.revision += 1;
      run.updatedAt = nowIso();
      this.persist();
      await this.emitGateDecision(run, nodeRun, approval);
      await this.advanceAfterNode(run, node.id);
      return;
    }
    if (parsed.decision === 'reject') {
      nodeRun.status = 'failed';
      this.persist();
      await this.emitGateDecision(run, nodeRun, approval);
      await this.finishRun(run, 'failed', { code: 'WORKFLOW_ROBOT_REJECTED', message: parsed.reason, nodeId: node.id });
      return;
    }
    nodeRun.status = 'revision_requested';
    run.revision += 1;
    run.updatedAt = nowIso();
    this.persist();
    await this.emitGateDecision(run, nodeRun, approval);
    if (nodeRun.attempt > node.maxRevisionAttempts) {
      await this.activateHuman(run, node, true);
      return;
    }
    await this.revisePreviousAgent(run, parsed.revisionInstruction || parsed.reason);
  }

  /**
   * The Agent node a rejected gate sends work back to. Graph edges are the
   * authority so a published rework edge is honoured; definition order is only
   * the fallback for a version that declares no edges at all, matching how
   * upstreamRerunCandidates resolves predecessors.
   */
  private reworkTarget(run: WorkflowRun) {
    const nodes = run.definitionSnapshot.nodes;
    const currentIndex = nodes.findIndex((node) => node.id === run.currentNodeId);
    const upstream = run.currentNodeId ? this.upstreamNodeIds(run, run.currentNodeId) : new Set<string>();
    if (upstream.size) {
      // Nearest upstream Agent node: walk the definition backwards but only
      // consider nodes the graph actually connects to the current one.
      return [...nodes]
        .reverse()
        .find((node) => node.type === 'agent' && upstream.has(node.id));
    }
    return nodes.slice(0, currentIndex < 0 ? 0 : currentIndex).reverse().find((node) => node.type === 'agent');
  }

  /**
   * A rejected gate with no legal rework edge. The run parks at waiting_human so
   * the coordinator can take it to the user; nothing advances on its own and a
   * stray completion cannot walk past it.
   */
  private async parkForRevisionHandoff(run: WorkflowRun, instruction: string) {
    const nodeRun = this.currentNodeRun(run);
    const confirmationId = `workflow-revision-handoff:${run.id}:${run.revision}`;
    run.status = 'waiting_human';
    run.pendingRevisionHandoff = {
      ...(run.currentNodeId ? { nodeId: run.currentNodeId } : {}),
      ...(nodeRun ? { nodeRunId: nodeRun.id } : {}),
      confirmationId,
      reason: 'WORKFLOW_REVISION_TARGET_MISSING',
      instruction,
      requestedAt: nowIso()
    };
    run.revision += 1;
    run.updatedAt = nowIso();
    this.persist();
    await this.runEffect(run, 'emit_event', `${run.currentNodeId ?? 'run'}:${run.revision}:revision-handoff`, { confirmationId }, () => {
      this.events.createOnce(`workflow-revision-blocked:${run.id}:${run.revision}`, {
        sessionId: run.sessionId,
        type: 'workflow_gate_requested',
        priority: 'high',
        content: '质量验证要求返工，但当前流程图里没有可返工的上游 Agent 节点。',
        metadata: createMetadata('system_notice', {
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          workflowRunId: run.id,
          ...(run.currentNodeId ? { workflowNodeId: run.currentNodeId } : {}),
          ...(nodeRun ? { workflowNodeRunId: nodeRun.id } : {}),
          reason: 'WORKFLOW_REVISION_TARGET_MISSING',
          instruction
        })
      });
      this.events.createOnce(`workflow-revision-handoff:${run.id}:${run.revision}`, {
        sessionId: run.sessionId,
        type: 'user_confirmation_requested',
        priority: 'high',
        content: '质量验证要求返工，但当前流程图里这个确认节点之前没有可返工的 Agent 节点，请选择如何处理。',
        metadata: createMetadata('confirmation_card', {
          confirmationId,
          reason: 'workflow_revision_handoff',
          title: '返工没有可执行的上游节点',
          description: [
            instruction,
            '已完成的产物保持可查看。可以终止本次运行，或先在群聊中补充说明再决定。'
          ].filter(Boolean).join('\n'),
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          workflowRunId: run.id,
          ...(run.currentNodeId ? { workflowNodeId: run.currentNodeId } : {}),
          ...(nodeRun ? { workflowNodeRunId: nodeRun.id } : {}),
          expectedRunRevision: run.revision,
          options: [
            { key: 'answer_in_chat', label: '在群聊中补充说明', style: 'primary' as const },
            { key: 'cancel', label: '终止工作流', style: 'danger' as const }
          ]
        })
      });
    });
    await this.publishProjection(run);
  }

  private async revisePreviousAgent(run: WorkflowRun, instruction: string, targetNodeId?: string) {
    const previous = targetNodeId
      ? run.definitionSnapshot.nodes.find((node) => node.id === targetNodeId && node.type === 'agent')
      : this.reworkTarget(run);
    if (!previous) {
      // No legal rework edge is a handoff to the user, not a failed run: the
      // work already done stays reviewable and the coordinator explains what is
      // being waited on (AC7). Failing here used to discard a whole run because
      // the published graph had no Agent node before the gate.
      await this.parkForRevisionHandoff(run, instruction);
      return;
    }
    run.status = 'running';
    run.currentNodeId = previous.id;
    run.revision += 1;
    run.updatedAt = nowIso();
    this.persist();
    await this.runEffect(run, 'emit_event', `${previous.id}:${run.revision}:revise`, { instruction }, () => {
      this.events.createOnce(`workflow-revision:${run.id}:${run.revision}`, {
        sessionId: run.sessionId,
        type: 'workflow_node_revision_requested',
        content: instruction,
        metadata: createMetadata('system_notice', {
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          workflowRunId: run.id,
          workflowNodeId: previous.id,
          instruction
        })
      });
    });
    await this.publishProjection(run);
    await this.activateCurrentNode(run.id);
  }

  private async advanceAfterNode(run: WorkflowRun, nodeId: string) {
    const index = run.definitionSnapshot.nodes.findIndex((node) => node.id === nodeId);
    const next = run.definitionSnapshot.nodes[index + 1];
    if (!next) {
      await this.finishRun(run, 'completed');
      await this.startPostReview(run);
      return;
    }
    run.status = 'running';
    run.currentNodeId = next.id;
    run.revision += 1;
    run.updatedAt = nowIso();
    this.persist();
    await this.publishProjection(run);
    await this.activateCurrentNode(run.id);
  }

  private async finishRun(
    run: WorkflowRun,
    status: Extract<WorkflowRunStatus, 'completed' | 'failed' | 'cancelled'>,
    failure?: WorkflowRun['failure']
  ) {
    if (this.isTerminal(run.status)) return;
    if (status === 'failed') this.failCurrentNodeRun(run, failure);
    run.status = status;
    run.currentNodeId = undefined;
    run.pendingAgentSubstitution = undefined;
    run.pendingUpstreamRerun = undefined;
    run.failure = failure;
    run.revision += 1;
    run.updatedAt = nowIso();
    run.completedAt = nowIso();
    this.persist();
    const eventType = status === 'completed'
      ? 'workflow_run_completed'
      : status === 'failed'
        ? 'workflow_run_failed'
        : 'workflow_run_cancelled';
    await this.runEffect(run, 'emit_event', `run-${status}:${run.revision}`, { failure }, () => {
      this.events.createOnce(`workflow-run-${status}:${run.id}:${run.revision}`, {
        sessionId: run.sessionId,
        type: eventType,
        priority: status === 'failed' ? 'high' : undefined,
        content: status === 'completed'
          ? `工作流「${run.workflowName}」已完成。`
          : status === 'failed'
            ? `工作流「${run.workflowName}」失败：${failure?.message ?? '未知错误'}`
            : `工作流「${run.workflowName}」已取消。`,
        metadata: createMetadata('system_notice', {
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          workflowRunId: run.id,
          status,
          failure
        })
      });
    });
    await this.publishProjection(run);
  }

  private async startPostReview(run: WorkflowRun) {
    const context = this.context(run.id);
    const workflowTasks = this.tasks.list(run.sessionId).filter((task) => task.workflowRunId === run.id);
    const taskIds = workflowTasks.map((task) => task.id);
    context.session.workflowRun = {
      id: run.id,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      workflowName: run.workflowName,
      nodeTaskIds: taskIds,
      completedTaskIds: taskIds,
      currentStepIndex: taskIds.length,
      status: 'completed',
      runtimeVersion: 'v2',
      createdAt: run.createdAt,
      updatedAt: nowIso()
    };
    // The key carries the revision so each rework round gets its own post review
    // instead of being swallowed by the first round's completed effect.
    await this.runEffect(run, 'start_post_review', `post-review:${run.revision}`, { taskIds }, () => {
      this.execution.start(context.session, context.brief, workflowTasks, (outcome) => {
        if (!this.lifecycle.matchesActiveGeneration(run.sessionId, run.sessionGeneration)) return;
        this.updatesSubject.next({
          kind: 'session_outcome', sessionId: run.sessionId, workflowRunId: run.id,
          ...(run.sessionGeneration !== undefined ? { sessionGeneration: run.sessionGeneration } : {}), outcome
        });
      }, run.sessionGeneration);
    });
  }

  private async emitNodeStarted(run: WorkflowRun, nodeRun: WorkflowNodeRun, title: string) {
    await this.runEffect(run, 'emit_event', `${nodeRun.id}:started`, {}, () => {
      this.events.createOnce(`workflow-node-started:${nodeRun.id}`, {
        sessionId: run.sessionId,
        type: 'workflow_node_started',
        taskId: nodeRun.relatedTaskId,
        content: `开始工作流节点：${title}`,
        metadata: createMetadata('system_notice', this.eventRefs(run, nodeRun))
      });
    });
  }

  private async emitNodeCompleted(run: WorkflowRun, nodeRun: WorkflowNodeRun) {
    await this.runEffect(run, 'emit_event', `${nodeRun.id}:completed`, {}, () => {
      this.events.createOnce(`workflow-node-completed:${nodeRun.id}`, {
        sessionId: run.sessionId,
        type: 'workflow_node_completed',
        taskId: nodeRun.relatedTaskId,
        content: nodeRun.outputSummary || '工作流节点已完成。',
        metadata: createMetadata('system_notice', {
          ...this.eventRefs(run, nodeRun),
          status: nodeRun.status,
          outputSummary: nodeRun.outputSummary
        })
      });
    });
  }

  private async emitGateDecision(run: WorkflowRun, nodeRun: WorkflowNodeRun, approval: WorkflowApprovalRecord) {
    await this.runEffect(run, 'emit_event', `${nodeRun.id}:decision:${approval.id}`, {}, () => {
      this.events.createOnce(`workflow-gate-decision:${approval.id}`, {
        sessionId: run.sessionId,
        type: 'workflow_gate_decided',
        content: approval.reason,
        metadata: createMetadata('system_notice', {
          ...this.eventRefs(run, nodeRun),
          decision: approval.decision,
          actor: approval.actor,
          evidenceRefs: approval.evidenceRefs
        })
      });
      if (approval.confirmationId) {
        this.events.createOnce(`workflow-confirmation-resolved:${approval.confirmationId}`, {
          sessionId: run.sessionId,
          type: 'user_confirmation_resolved',
          content: approval.reason,
          metadata: createMetadata('system_notice', {
            confirmationId: approval.confirmationId,
            status: approval.decision === 'approve' ? 'approved' : 'rejected',
            selectedOptionKey: approval.decision,
            workflowRunId: run.id,
            workflowNodeRunId: nodeRun.id
          })
        });
      }
    });
  }

  private ensureAgentSubstitutionConfirmation(
    run: WorkflowRun,
    pending: WorkflowPendingAgentSubstitution
  ) {
    this.events.createOnce(`workflow-agent-substitution-confirmation:${run.id}:${pending.taskId}`, {
      sessionId: run.sessionId,
      type: 'user_confirmation_requested',
      priority: 'high',
      content: '当前工作流 Agent 无法接单，请选择改派、跳过或取消。',
      metadata: createMetadata('confirmation_card', {
        confirmationId: pending.confirmationId,
        reason: 'workflow_agent_substitution',
        title: '等待改派或跳过当前 Agent',
        description: `${pending.reason}\n系统不会自动跨角色改派。请选择一个候选 Agent、跳过当前节点或终止工作流。`,
        relatedTaskId: pending.taskId,
        workflowRunId: run.id,
        workflowNodeId: pending.nodeId,
        workflowNodeRunId: pending.nodeRunId,
        candidateAgentIds: pending.candidates.map((agent) => agent.id),
        expectedRunRevision: run.revision,
        options: [
          ...pending.candidates.map((agent, index) => ({
            key: `agent:${agent.id}`,
            label: `改派给 ${agent.name}`,
            style: index === 0 ? 'primary' as const : 'default' as const
          })),
          { key: 'skip_agent', label: '跳过当前 Agent', style: 'default' as const },
          { key: 'cancel', label: '终止工作流', style: 'danger' as const }
        ]
      })
    });
  }

  private async publishProjection(run: WorkflowRun) {
    await this.runEffect(run, 'update_session_projection', `projection:${run.revision}`, { status: run.status, revision: run.revision }, () => {
      this.updatesSubject.next({
        kind: 'projection',
        sessionId: run.sessionId,
        workflowRunId: run.id,
        ...(run.sessionGeneration !== undefined ? { sessionGeneration: run.sessionGeneration } : {}),
        status: run.status,
        revision: run.revision
      });
    });
  }

  private async runEffect(
    run: WorkflowRun,
    type: WorkflowEffect['type'],
    key: string,
    payload: Record<string, unknown>,
    operation: () => void
  ) {
    const effectId = `wf-effect:${run.id}:${type}:${key}`;
    const effects = this.effectsByRunId.get(run.id) ?? [];
    let effect = effects.find((item) => item.id === effectId);
    if (effect?.status === 'completed') return;
    if (!effect) {
      effect = { id: effectId, workflowRunId: run.id, type, payload, status: 'pending', attempts: 0 };
      effects.push(effect);
      this.effectsByRunId.set(run.id, effects);
    }
    effect.status = 'processing';
    effect.attempts += 1;
    this.persist();
    try {
      operation();
      effect.status = 'completed';
      effect.lastError = undefined;
      this.persist();
    } catch (error) {
      effect.status = 'failed';
      effect.lastError = error instanceof Error ? error.message : String(error);
      this.persist();
      throw error;
    }
  }

  private appendNodeRun(nodeRun: WorkflowNodeRun) {
    this.nodeRunsByRunId.set(nodeRun.workflowRunId, [...(this.nodeRunsByRunId.get(nodeRun.workflowRunId) ?? []), nodeRun]);
    this.persist();
  }

  private currentNode(run: WorkflowRun) {
    return run.definitionSnapshot.nodes.find((node) => node.id === run.currentNodeId);
  }

  private currentNodeRun(run: WorkflowRun) {
    return [...this.listNodeRuns(run.id)].reverse().find((item) => item.nodeId === run.currentNodeId);
  }

  private restoreWorkflowNodeAgent(run: WorkflowRun, task: AgentTask) {
    if (task.workflowAgentOverride) return;
    const node = this.currentNode(run);
    if (node?.type !== 'agent' || task.workflowNodeId !== node.id) return;
    const agent = this.agents.getForSurface(node.agentId, 'workflow');
    const assigneeId = task.assignee?.type === 'agent' ? task.assignee.id : undefined;
    if (assigneeId === agent.id && task.eligibleAgentIds?.length === 1 && task.eligibleAgentIds[0] === agent.id) return;
    this.tasks.update(task, {
      assignee: { type: 'agent', id: agent.id },
      eligibleAgentIds: [agent.id],
      autoResolutionAttempted: false,
      resultSummary: undefined
    });
  }

  private failedNodeId(run: WorkflowRun) {
    const definitionNodeIds = new Set(run.definitionSnapshot.nodes.map((node) => node.id));
    if (run.failure?.nodeId && definitionNodeIds.has(run.failure.nodeId)) return run.failure.nodeId;
    return [...this.listNodeRuns(run.id)]
      .reverse()
      .find((item) => definitionNodeIds.has(item.nodeId) && ['failed', 'running'].includes(item.status))
      ?.nodeId;
  }

  private failCurrentNodeRun(run: WorkflowRun, failure = run.failure) {
    const failedNodeId = failure?.nodeId ?? run.currentNodeId;
    if (!failedNodeId) return;
    const nodeRun = [...this.listNodeRuns(run.id)]
      .reverse()
      .find((item) => item.nodeId === failedNodeId && item.status === 'running');
    if (!nodeRun) return;
    nodeRun.status = 'failed';
    nodeRun.completedAt = nowIso();
    nodeRun.error = {
      code: failure?.code ?? 'WORKFLOW_NODE_EXECUTION_FAILED',
      message: failure?.message ?? 'Workflow node execution failed.',
      retryable: true
    };
  }

  private nextAttempt(runId: string, nodeId: string) {
    return this.listNodeRuns(runId).filter((item) => item.nodeId === nodeId).length + 1;
  }

  private latestUpstreamOutputRefs(run: WorkflowRun, nodeId: string) {
    return this.latestSuccessfulUpstreamNodeRuns(run, nodeId)
      .flatMap((item) => item.outputRefs);
  }

  private latestUpstreamTaskIds(run: WorkflowRun, nodeId: string) {
    return Array.from(new Set(this.latestSuccessfulUpstreamNodeRuns(run, nodeId)
      .map((item) => item.relatedTaskId)
      .filter((taskId): taskId is string => Boolean(taskId))));
  }

  private latestSuccessfulUpstreamNodeRuns(run: WorkflowRun, nodeId: string) {
    const upstreamIds = this.upstreamNodeIds(run, nodeId);
    const nodeRuns = this.listNodeRuns(run.id);
    const latestByNodeId = new Map<string, WorkflowNodeRun>();
    for (const nodeRun of nodeRuns) {
      if (upstreamIds.has(nodeRun.nodeId) && ['completed', 'approved'].includes(nodeRun.status)) {
        latestByNodeId.set(nodeRun.nodeId, nodeRun);
      }
    }
    return nodeRuns.filter((nodeRun) => latestByNodeId.get(nodeRun.nodeId)?.id === nodeRun.id);
  }

  private latestUpstreamSummary(run: WorkflowRun, nodeId: string) {
    const upstreamIds = this.upstreamNodeIds(run, nodeId);
    return [...this.listNodeRuns(run.id)].reverse().find((item) => upstreamIds.has(item.nodeId) && item.outputSummary)?.outputSummary;
  }

  private hasUpstreamNode(run: WorkflowRun, nodeId: string) {
    return this.upstreamNodeIds(run, nodeId).size > 0;
  }

  private upstreamNodeIds(run: WorkflowRun, nodeId: string) {
    const sourcesByTarget = new Map<string, string[]>();
    for (const edge of run.definitionSnapshot.edges) {
      sourcesByTarget.set(edge.targetNodeId, [...(sourcesByTarget.get(edge.targetNodeId) ?? []), edge.sourceNodeId]);
    }
    const upstreamIds = new Set<string>();
    const pending = [...(sourcesByTarget.get(nodeId) ?? [])];
    while (pending.length) {
      const sourceNodeId = pending.pop()!;
      if (sourceNodeId === nodeId || upstreamIds.has(sourceNodeId)) continue;
      upstreamIds.add(sourceNodeId);
      pending.push(...(sourcesByTarget.get(sourceNodeId) ?? []));
    }
    return upstreamIds;
  }

  private reconcileTaskDependencies(run: WorkflowRun, nodeRun: WorkflowNodeRun, task: AgentTask) {
    const originalTaskIds = [...task.dependsOnTaskIds];
    const expectedTaskIds = this.latestUpstreamTaskIds(run, nodeRun.nodeId);
    if (
      originalTaskIds.length === expectedTaskIds.length &&
      originalTaskIds.every((taskId, index) => taskId === expectedTaskIds[index])
    ) return false;
    const contextRequirements = Array.from(new Set([
      ...(task.contextRequirements ?? []),
      ...(expectedTaskIds.length ? ['Upstream workflow stage artifacts'] : [])
    ]));
    this.tasks.update(task, { dependsOnTaskIds: expectedTaskIds, contextRequirements });
    this.events.createOnce(`workflow-task-dependencies:${nodeRun.id}`, {
      sessionId: run.sessionId,
      type: 'task_dependency_reconciled',
      content: `Reconciled workflow task dependencies from ${originalTaskIds.length} to ${expectedTaskIds.length}.`,
      metadata: createMetadata('system_notice', {
        workflowRunId: run.id,
        workflowNodeId: nodeRun.nodeId,
        workflowNodeRunId: nodeRun.id,
        taskId: task.id,
        dependsOnTaskIds: expectedTaskIds
      })
    });
    return true;
  }

  private defaultStageInputContract(agent: { id: string; key?: string; name: string; role?: string }, hasUpstream: boolean) {
    if (!hasUpstream) return [];
    const identity = `${agent.key ?? ''} ${agent.id} ${agent.name} ${agent.role ?? ''}`.toLowerCase();
    if (identity.includes('frontend')) {
      return ['Consume the upstream architecture, database schema, API contracts, and integration decisions.'];
    }
    return ['Consume all completed upstream stage artifacts and decisions before implementation.'];
  }

  private defaultStageOutputContract(agent: { id: string; key?: string; name: string; role?: string }) {
    const identity = `${agent.key ?? ''} ${agent.id} ${agent.name} ${agent.role ?? ''}`.toLowerCase();
    if (identity.includes('architect') || identity.includes('architecture')) {
      return [
        'Define the project/module structure and ownership boundaries.',
        'Define the database schema, entities, relationships, indexes, and migration constraints.',
        'Define API contracts including routes, methods, request/response schemas, errors, and authentication.',
        'Record integration protocols, cross-stage decisions, assumptions, and unresolved risks in a downstream-consumable artifact.'
      ];
    }
    return [`Complete the ${agent.name} workflow stage and publish a concrete artifact consumable by downstream stages.`];
  }

  private context(runId: string) {
    const context = this.contexts.get(runId);
    if (!context) throw new BadRequestException(`Workflow runtime context is unavailable: ${runId}`);
    return context;
  }

  private assertMutable(run: WorkflowRun, expectedRevision?: number) {
    if (this.isTerminal(run.status)) throw new BadRequestException({ code: 'WORKFLOW_RUN_TERMINAL' });
    if (expectedRevision !== undefined && expectedRevision !== run.revision) {
      throw new ConflictException({ code: 'WORKFLOW_RUN_CONFLICT', expectedRevision, actualRevision: run.revision });
    }
  }

  private isTerminal(status: WorkflowRunStatus) {
    return ['completed', 'failed', 'cancelled'].includes(status);
  }

  private defaultDecisionReason(decision: WorkflowHumanDecisionInput['decision']) {
    if (decision === 'approve') return '用户确认通过并继续。';
    if (decision === 'revise') return '用户要求退回上一 Agent 修改。';
    return '用户终止工作流。';
  }

  private parseRobotResult(value: string): {
    decision: 'approve' | 'revise' | 'reject';
    reason: string;
    revisionInstruction?: string;
    evidenceRefs: string[];
  } | undefined {
    try {
      const parsedValue: unknown = JSON.parse(value);
      if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) return undefined;
      const parsed = parsedValue as Record<string, unknown>;
      const allowedKeys = new Set(['decision', 'reason', 'revisionInstruction', 'evidenceRefs']);
      if (Object.keys(parsed).length !== allowedKeys.size || [...allowedKeys].some((key) => !(key in parsed))) return undefined;
      if (Object.keys(parsed).some((key) => !allowedKeys.has(key))) return undefined;
      if (!['approve', 'revise', 'reject'].includes(String(parsed.decision))) return undefined;
      if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) return undefined;
      if (!Array.isArray(parsed.evidenceRefs) || !parsed.evidenceRefs.every((item) => typeof item === 'string')) return undefined;
      if (parsed.revisionInstruction !== null && typeof parsed.revisionInstruction !== 'string') return undefined;
      const decision = parsed.decision as 'approve' | 'revise' | 'reject';
      const revisionInstruction = typeof parsed.revisionInstruction === 'string'
        ? parsed.revisionInstruction.trim()
        : undefined;
      if (decision === 'revise' && !revisionInstruction) return undefined;
      if (decision !== 'revise' && parsed.revisionInstruction !== null) return undefined;
      return {
        decision,
        reason: parsed.reason.trim(),
        revisionInstruction: revisionInstruction || undefined,
        evidenceRefs: parsed.evidenceRefs as string[]
      };
    } catch {
      return undefined;
    }
  }

  private eventRefs(run: WorkflowRun, nodeRun: WorkflowNodeRun) {
    return {
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      workflowRunId: run.id,
      workflowNodeId: nodeRun.nodeId,
      workflowNodeRunId: nodeRun.id,
      attempt: nodeRun.attempt
    };
  }

  private serialize<T>(runId: string, command: () => Promise<T>): Promise<T> {
    const previous = this.commandTails.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(command);
    // The tail only exists to order the next command, so it must absorb the
    // rejection. The caller owns `next`; leaving the tail rejected would surface
    // every rejected command (a rejected user confirmation included) as an
    // unhandledRejection on top of the caller's own error.
    const tail = next.catch(() => undefined).finally(() => {
      if (this.commandTails.get(runId) === tail) this.commandTails.delete(runId);
    });
    this.commandTails.set(runId, tail);
    return next;
  }

  private persist() {
    const state: WorkflowRuntimeState = {
      schemaVersion: 2,
      runs: [...this.runs.values()],
      nodeRunsByRunId: Object.fromEntries(this.nodeRunsByRunId),
      approvalsByRunId: Object.fromEntries(this.approvalsByRunId),
      effectsByRunId: Object.fromEntries(this.effectsByRunId)
    };
    this.persistence.setCollection(RUNTIME_KEY, state);
  }
}
