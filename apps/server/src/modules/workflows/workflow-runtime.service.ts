import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
  WorkflowRunStatus
} from '@agent-cluster/shared';
import { createMetadata } from '@agent-cluster/shared';
import { createExecutionTermination } from '../../common/execution-termination.js';
import { nowIso } from '../../common/time.js';
import { AgentsService } from '../agents/agents.service.js';
import { EventsService } from '../events/events.service.js';
import { ExecutionService } from '../execution/execution.service.js';
import type { ExecutionOutcome } from '../orchestrator/orchestrator.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { WorkflowsService } from './workflows.service.js';

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
      status: WorkflowRunStatus;
      revision: number;
    }
  | {
      kind: 'session_outcome';
      sessionId: string;
      workflowRunId: string;
      outcome: ExecutionOutcome;
    };

export type StartWorkflowRunInput = {
  session: SessionDetail;
  brief: TaskBrief;
  coordinatorId: string;
  workflowId: string;
  workflowVersion?: number;
  confirmationId: string;
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

  constructor(
    private readonly workflows: WorkflowsService,
    private readonly agents: AgentsService,
    private readonly tasks: TasksService,
    private readonly events: EventsService,
    private readonly execution: ExecutionService,
    private readonly persistence: PersistenceService
  ) {
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

    const version = this.workflows.getVersion(input.workflowId, input.workflowVersion);
    const workflow = this.workflows.get(input.workflowId);
    if (workflow.status !== 'published') throw new BadRequestException('Only published workflows can be executed.');
    const firstNode = version.nodes[0];
    if (!firstNode) throw new BadRequestException('Published workflow has no nodes.');
    const now = nowIso();
    const run: WorkflowRun = {
      id: crypto.randomUUID(),
      workflowId: version.workflowId,
      workflowVersion: version.version,
      workflowName: version.name,
      sessionId: input.session.id,
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
      const nodeRun = this.listNodeRuns(run.id).find((item) => item.id === input.nodeRunId);
      if (!nodeRun || nodeRun.status !== 'waiting' || nodeRun.confirmationId !== input.confirmationId) {
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
      const context = this.context(run.id);
      this.execution.cancel(
        run.sessionId,
        createExecutionTermination({ kind: 'user_cancelled', source: 'user', scope: 'session', diagnosticRef: reason })
      );
      this.tasks.cancelUnfinished(run.sessionId, reason);
      await this.finishRun(run, 'cancelled');
      context.session.workflowRun = context.session.workflowRun
        ? { ...context.session.workflowRun, status: 'cancelled', updatedAt: nowIso() }
        : undefined;
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

  async resumeCurrentExecution(runId: string) {
    return this.serialize(runId, async () => {
      const run = this.get(runId);
      if (this.isTerminal(run.status) || this.execution.isRunning(run.sessionId)) return false;
      const nodeRun = this.currentNodeRun(run);
      const task = nodeRun?.relatedTaskId ? this.tasks.find(run.sessionId, nodeRun.relatedTaskId) : undefined;
      if (!nodeRun || nodeRun.status !== 'running' || !task) return false;
      this.tasks.update(task, { status: 'pending', resultSummary: undefined });
      await this.scheduleTaskExecution(run, nodeRun, task, true);
      return true;
    });
  }

  async recover(session: SessionDetail, brief: TaskBrief, coordinatorId: string) {
    const run = this.findBySession(session.id);
    if (!run || this.isTerminal(run.status)) return run;
    this.contexts.set(run.id, { session, brief, coordinatorId });
    session.workflowRunId = run.id;
    await this.publishProjection(run);
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
    const taskId = `wf-task:${run.id}:${node.id}:${attempt}`;
    const task: AgentTask = {
      id: taskId,
      sessionId: run.sessionId,
      title: node.name?.trim() || `工作流阶段 · ${agent.name}`,
      description: node.stageDescription?.trim() || `执行工作流「${run.workflowName}」中的 ${agent.name} 阶段。`,
      status: 'assigned',
      assignedBy: { type: 'agent', id: context.coordinatorId },
      assignee: { type: 'agent', id: agent.id },
      routingMode: 'coordinator_controlled',
      autoResolutionAttempted: false,
      assignmentReason: `工作流「${run.workflowName}」节点 ${node.name ?? node.id}。`,
      contextRequirements: ['已确认任务契约', ...(attempt > 1 ? ['工作流返工说明和上一轮输出'] : this.hasUpstreamNode(run, node.id) ? ['前序工作流节点产物'] : [])],
      verificationPlan: node.outputContract?.length ? [...node.outputContract] : ['输出可供下游节点消费的阶段结果'],
      riskNotes: [],
      requiresUserConfirmation: false,
      workflowRunId: run.id,
      workflowNodeId: node.id,
      workflowNodeRunId: nodeRun.id,
      workflowNodeType: 'agent',
      workflowAttempt: attempt,
      executionPurpose: 'agent_work',
      dependsOnTaskIds: [],
      acceptanceCriteria: context.brief.acceptanceCriteria,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    nodeRun.relatedTaskId = taskId;
    this.persist();
    await this.runEffect(run, 'create_agent_task', `${node.id}:${attempt}:create`, { taskId }, () => this.tasks.add(task));
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
      title: node.name?.trim() || `机器人确认 · ${reviewer.name}`,
      description: [
        node.reviewPrompt,
        `通过标准：${node.criteria.join('；')}`,
        '只返回 JSON：{"decision":"approve|revise|reject","reason":"...","revisionInstruction":"...","evidenceRefs":[]}'
      ].join('\n'),
      status: 'assigned',
      assignedBy: { type: 'agent', id: context.coordinatorId },
      assignee: { type: 'agent', id: reviewer.id },
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
      executionPurpose: 'workflow_review',
      dependsOnTaskIds: [],
      acceptanceCriteria: node.criteria,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    nodeRun.relatedTaskId = taskId;
    this.persist();
    await this.runEffect(run, 'create_agent_task', `${node.id}:${attempt}:create`, { taskId }, () => this.tasks.add(task));
    await this.emitNodeStarted(run, nodeRun, task.title);
    await this.scheduleTaskExecution(run, nodeRun, task);
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
      this.execution.start(context.session, context.brief, [currentTask], (outcome) => {
        void this.serialize(run.id, () => this.handleExecutionOutcome(run.id, nodeRun.id, outcome));
      });
    };
    if (forceRestart) {
      startExecution();
      return;
    }
    await this.runEffect(run, 'execute_agent_task', `${nodeRun.id}:execute`, { taskId: currentTask.id }, startExecution);
  }

  private async handleExecutionOutcome(runId: string, nodeRunId: string, outcome: ExecutionOutcome) {
    const run = this.get(runId);
    if (this.isTerminal(run.status)) return;
    const nodeRun = this.listNodeRuns(run.id).find((item) => item.id === nodeRunId);
    if (!nodeRun || nodeRun.status !== 'running') return;
    if (outcome.kind === 'workflow_step_completed') {
      await this.completeExecutedNode(run.id, nodeRun.id, outcome.resultSummary);
      return;
    }
    if (outcome.kind === 'cancelled') {
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
      this.updatesSubject.next({
        kind: 'session_outcome',
        sessionId: run.sessionId,
        workflowRunId: run.id,
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

  private async revisePreviousAgent(run: WorkflowRun, instruction: string) {
    const currentIndex = run.definitionSnapshot.nodes.findIndex((node) => node.id === run.currentNodeId);
    const previous = run.definitionSnapshot.nodes.slice(0, currentIndex).reverse().find((node) => node.type === 'agent');
    if (!previous) {
      await this.finishRun(run, 'failed', {
        code: 'WORKFLOW_REVISION_TARGET_NOT_FOUND',
        message: '确认节点之前没有可返工的 Agent 节点。',
        nodeId: run.currentNodeId
      });
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
    run.status = status;
    run.currentNodeId = undefined;
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
    await this.runEffect(run, 'emit_event', `run-${status}`, { failure }, () => {
      this.events.createOnce(`workflow-run-${status}:${run.id}`, {
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
    await this.runEffect(run, 'start_post_review', 'post-review', { taskIds }, () => {
      this.execution.start(context.session, context.brief, workflowTasks, (outcome) => {
        this.updatesSubject.next({ kind: 'session_outcome', sessionId: run.sessionId, workflowRunId: run.id, outcome });
      });
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
        metadata: createMetadata('system_notice', { ...this.eventRefs(run, nodeRun), outputSummary: nodeRun.outputSummary })
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

  private async publishProjection(run: WorkflowRun) {
    await this.runEffect(run, 'update_session_projection', `projection:${run.revision}`, { status: run.status, revision: run.revision }, () => {
      this.updatesSubject.next({
        kind: 'projection',
        sessionId: run.sessionId,
        workflowRunId: run.id,
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

  private nextAttempt(runId: string, nodeId: string) {
    return this.listNodeRuns(runId).filter((item) => item.nodeId === nodeId).length + 1;
  }

  private latestUpstreamOutputRefs(run: WorkflowRun, nodeId: string) {
    const index = run.definitionSnapshot.nodes.findIndex((node) => node.id === nodeId);
    const upstreamIds = new Set(run.definitionSnapshot.nodes.slice(0, index).map((node) => node.id));
    return this.listNodeRuns(run.id)
      .filter((item) => upstreamIds.has(item.nodeId) && ['completed', 'approved'].includes(item.status))
      .flatMap((item) => item.outputRefs);
  }

  private latestUpstreamSummary(run: WorkflowRun, nodeId: string) {
    const index = run.definitionSnapshot.nodes.findIndex((node) => node.id === nodeId);
    const upstreamIds = new Set(run.definitionSnapshot.nodes.slice(0, index).map((node) => node.id));
    return [...this.listNodeRuns(run.id)].reverse().find((item) => upstreamIds.has(item.nodeId) && item.outputSummary)?.outputSummary;
  }

  private hasUpstreamNode(run: WorkflowRun, nodeId: string) {
    return run.definitionSnapshot.nodes.findIndex((node) => node.id === nodeId) > 0;
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
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (!['approve', 'revise', 'reject'].includes(String(parsed.decision))) return undefined;
      if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) return undefined;
      if (!Array.isArray(parsed.evidenceRefs) || !parsed.evidenceRefs.every((item) => typeof item === 'string')) return undefined;
      if (parsed.revisionInstruction !== undefined && typeof parsed.revisionInstruction !== 'string') return undefined;
      return {
        decision: parsed.decision as 'approve' | 'revise' | 'reject',
        reason: parsed.reason.trim(),
        revisionInstruction: typeof parsed.revisionInstruction === 'string' ? parsed.revisionInstruction.trim() || undefined : undefined,
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
    const tail = next.finally(() => {
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
