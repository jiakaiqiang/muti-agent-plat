import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTask, SessionDetail, TaskBrief, WorkflowVersion } from '@agent-cluster/shared';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';

const now = '2026-07-14T00:00:00.000Z';

function fixture(nodes: WorkflowVersion['nodes'], edges?: WorkflowVersion['edges']) {
  const session: SessionDetail = {
    id: 'session-1',
    dataEpoch: 'epoch-1',
    activeWorkItemId: 'work-item-1',
    title: 'Workflow runtime',
    originalInput: 'Implement the workflow.',
    status: 'WAIT_WORKFLOW_SELECT',
    ownerId: 'local-user',
    workspaceId: 'workspace',
    tokenUsed: 0,
    currentTaskBriefId: 'brief-1',
    participatingAgentIds: ['coordinator'],
    createdAt: now,
    updatedAt: now
  };
  const brief: TaskBrief = {
    id: 'brief-1',
    sessionId: session.id,
    workItemId: 'work-item-1',
    version: 1,
    goal: 'Implement the workflow.',
    scope: [],
    outOfScope: [],
    constraints: [],
    acceptanceCriteria: ['The result is reviewable.'],
    risks: [],
    openQuestions: [],
    confirmedByUser: true,
    confirmedAt: now,
    createdAt: now
  };
  const version: WorkflowVersion = {
    id: 'workflow-version-1',
    workflowId: 'workflow-1',
    version: 1,
    name: 'Runtime flow',
    nodes,
    edges: edges ?? nodes.slice(0, -1).map((node, index) => ({
      id: `edge:${node.id}:${nodes[index + 1].id}`,
      sourceNodeId: node.id,
      targetNodeId: nodes[index + 1].id
    })),
    involvedAgentIds: ['requirements', 'frontend', 'reviewer'],
    definitionHash: 'hash',
    publishedBy: 'local-user',
    publishedAt: now
  };
  const collections = new Map<string, unknown>();
  const taskItems: AgentTask[] = [];
  const eventItems: Array<Record<string, unknown>> = [];
  const callbacks: Array<(outcome: any) => void> = [];
  const executionTaskBatches: AgentTask[][] = [];
  const cancelCalls: any[][] = [];
  const updates: any[] = [];
  let executionRunning = false;
  const runtime = new WorkflowRuntimeService(
    {
      get: () => ({ id: 'workflow-1', status: 'published' }),
      getVersion: () => version
    } as never,
    {
      getByIdOrKey: (id: string) => ({ id, key: id, name: id, role: id })
    } as never,
    {
      add(task: AgentTask) {
        const existing = taskItems.find((item) => item.id === task.id);
        if (existing) return existing;
        taskItems.push(task);
        return task;
      },
      find: (_sessionId: string, taskId: string) => taskItems.find((item) => item.id === taskId),
      list: () => taskItems,
      update(task: AgentTask, patch: Partial<AgentTask>) {
        Object.assign(task, patch);
        return task;
      },
      cancelUnfinished() {}
    } as never,
    {
      createOnce(idempotencyKey: string, input: Record<string, unknown>) {
        const existing = eventItems.find((item) => item.idempotencyKey === idempotencyKey);
        if (existing) return existing;
        const event = { id: `event-${eventItems.length + 1}`, idempotencyKey, ...input };
        eventItems.push(event);
        return event;
      }
    } as never,
    {
      start(_session: SessionDetail, _brief: TaskBrief, tasks: AgentTask[], callback: (outcome: any) => void) {
        executionRunning = true;
        executionTaskBatches.push(tasks);
        callbacks.push((outcome) => {
          executionRunning = false;
          callback(outcome);
        });
      },
      cancel(...args: any[]) {
        cancelCalls.push(args);
      },
      isRunning: () => executionRunning
    } as never,
    {
      getCollection: (_key: string, fallback: unknown) => fallback,
      setCollection: (key: string, value: unknown) => collections.set(key, structuredClone(value))
    } as never
  );
  runtime.updates().subscribe((update) => updates.push(update));
  return { runtime, session, brief, taskItems, eventItems, callbacks, cancelCalls, updates, collections, executionTaskBatches };
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('WorkflowRuntimeService pauses only at an explicit human approval node', async () => {
  const setup = fixture([
    { id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 },
    {
      id: 'human-node',
      type: 'human_approval',
      title: '确认需求',
      assignee: 'session_owner',
      allowedDecisions: ['approve', 'revise', 'cancel'],
      order: 1
    },
    { id: 'frontend-node', type: 'agent', agentId: 'frontend', order: 2 }
  ]);

  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    workflowVersion: 1,
    confirmationId: 'select-1'
  });
  assert.equal(setup.taskItems.length, 1);
  assert.equal(setup.callbacks.length, 1);

  setup.taskItems[0].status = 'completed';
  setup.callbacks[0]({ kind: 'workflow_step_completed', taskId: setup.taskItems[0].id, resultSummary: '需求完成' });
  await settle();

  assert.equal(setup.runtime.get(run.id).status, 'waiting_human');
  const humanRun = setup.runtime.listNodeRuns(run.id).find((item) => item.nodeId === 'human-node');
  assert.ok(humanRun?.confirmationId);
  await setup.runtime.decideHuman({
    runId: run.id,
    nodeRunId: humanRun.id,
    confirmationId: humanRun.confirmationId,
    userId: 'local-user',
    expectedRunRevision: setup.runtime.get(run.id).revision,
    decision: 'approve'
  });

  assert.equal(setup.runtime.get(run.id).status, 'running');
  assert.equal(setup.taskItems.length, 2);
  assert.equal(setup.taskItems[1].workflowNodeId, 'frontend-node');
  assert.deepEqual(
    setup.taskItems[1].acceptanceCriteria,
    ['Complete the frontend workflow stage and publish a concrete artifact consumable by downstream stages.']
  );

  setup.taskItems[1].status = 'completed';
  setup.callbacks[1]({ kind: 'workflow_step_completed', taskId: setup.taskItems[1].id, resultSummary: '前端完成' });
  await settle();
  assert.equal(setup.runtime.get(run.id).status, 'completed');
  assert.ok(setup.updates.some((item) => item.kind === 'projection' && item.status === 'waiting_human'));
});

test('WorkflowRuntimeService carries completed upstream tasks and node contracts into downstream execution', async () => {
  const setup = fixture([
    {
      id: 'architect-node',
      type: 'agent',
      agentId: 'architect',
      stageDescription: 'Define the project architecture and contracts.',
      outputContract: ['Architecture and API contracts are defined.'],
      order: 0
    },
    {
      id: 'frontend-node',
      type: 'agent',
      agentId: 'frontend',
      stageDescription: 'Implement the frontend from the upstream architecture.',
      inputContract: ['Use the upstream architecture and API contracts.'],
      outputContract: ['Frontend SDK and management UI are implemented.'],
      order: 1
    }
  ]);

  await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    workflowVersion: 1,
    confirmationId: 'select-upstream-context'
  });

  const architectTask = setup.taskItems[0]!;
  architectTask.status = 'completed';
  setup.callbacks[0]({
    kind: 'workflow_step_completed',
    taskId: architectTask.id,
    resultSummary: 'Architecture, API contracts, and data model are ready.'
  });
  await settle();

  const frontendTask = setup.taskItems[1]!;
  assert.deepEqual(frontendTask.dependsOnTaskIds, [architectTask.id]);
  assert.deepEqual(frontendTask.acceptanceCriteria, ['Frontend SDK and management UI are implemented.']);
  assert.ok(frontendTask.contextRequirements?.includes('Use the upstream architecture and API contracts.'));
  assert.ok(frontendTask.contextRequirements?.includes('前序工作流节点产物'));
  assert.deepEqual(setup.executionTaskBatches[1]?.map((task) => task.id), [architectTask.id, frontendTask.id]);
});

test('WorkflowRuntimeService sends only the latest successful upstream attempt after robot revision', async () => {
  const setup = fixture([
    { id: 'architect-node', type: 'agent', agentId: 'architect', order: 0 },
    {
      id: 'robot-node',
      type: 'robot_approval',
      reviewerAgentId: 'reviewer',
      reviewPrompt: 'Review the architecture.',
      criteria: ['Architecture is complete.'],
      maxRevisionAttempts: 2,
      fallback: 'human_approval',
      order: 1
    },
    { id: 'frontend-node', type: 'agent', agentId: 'frontend', order: 2 }
  ]);

  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-revised-upstream'
  });

  const firstArchitectTask = setup.taskItems[0]!;
  firstArchitectTask.status = 'completed';
  setup.callbacks[0]({
    kind: 'workflow_step_completed',
    taskId: firstArchitectTask.id,
    resultSummary: 'Architecture attempt one.'
  });
  await settle();

  setup.taskItems[1]!.status = 'completed';
  setup.callbacks[1]({
    kind: 'workflow_step_completed',
    taskId: setup.taskItems[1]!.id,
    resultSummary: JSON.stringify({
      decision: 'revise',
      reason: 'The API contract is incomplete.',
      revisionInstruction: 'Add request and response schemas.',
      evidenceRefs: []
    })
  });
  await settle();

  const revisedArchitectTask = setup.taskItems[2]!;
  assert.equal(revisedArchitectTask.workflowAttempt, 2);
  revisedArchitectTask.status = 'completed';
  setup.callbacks[2]({
    kind: 'workflow_step_completed',
    taskId: revisedArchitectTask.id,
    resultSummary: 'Architecture attempt two with complete schemas.'
  });
  await settle();

  const approvingRobotTask = setup.taskItems[3]!;
  approvingRobotTask.status = 'completed';
  setup.callbacks[3]({
    kind: 'workflow_step_completed',
    taskId: approvingRobotTask.id,
    resultSummary: JSON.stringify({
      decision: 'approve',
      reason: 'The revised architecture is complete.',
      evidenceRefs: []
    })
  });
  await settle();

  const frontendTask = setup.taskItems[4]!;
  assert.equal(frontendTask.dependsOnTaskIds.includes(firstArchitectTask.id), false);
  assert.equal(frontendTask.dependsOnTaskIds.includes(revisedArchitectTask.id), true);
  assert.equal(frontendTask.dependsOnTaskIds.includes(approvingRobotTask.id), true);
  const frontendNodeRun = setup.runtime.listNodeRuns(run.id).at(-1)!;
  assert.equal(frontendNodeRun.inputRefs.includes(`task:${firstArchitectTask.id}`), false);
  assert.equal(frontendNodeRun.inputRefs.includes(`task:${revisedArchitectTask.id}`), true);
});

test('WorkflowRuntimeService follows graph edges instead of treating every earlier node as upstream', async () => {
  const setup = fixture([
    { id: 'architect-node', type: 'agent', agentId: 'architect', order: 0 },
    { id: 'unrelated-node', type: 'agent', agentId: 'requirements', order: 1 },
    { id: 'frontend-node', type: 'agent', agentId: 'frontend', order: 2 }
  ], [
    { id: 'edge:architect:frontend', sourceNodeId: 'architect-node', targetNodeId: 'frontend-node' }
  ]);

  await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-graph-upstream'
  });
  const architectTask = setup.taskItems[0]!;
  architectTask.status = 'completed';
  setup.callbacks[0]({ kind: 'workflow_step_completed', taskId: architectTask.id, resultSummary: 'Architecture ready.' });
  await settle();
  const unrelatedTask = setup.taskItems[1]!;
  unrelatedTask.status = 'completed';
  setup.callbacks[1]({ kind: 'workflow_step_completed', taskId: unrelatedTask.id, resultSummary: 'Unrelated result.' });
  await settle();

  assert.deepEqual(setup.taskItems[2]?.dependsOnTaskIds, [architectTask.id]);
  assert.deepEqual(setup.executionTaskBatches[2]?.map((task) => task.id), [architectTask.id, setup.taskItems[2]?.id]);
});

test('WorkflowRuntimeService reconciles missing persisted dependencies before resume', async () => {
  const setup = fixture([
    { id: 'architect-node', type: 'agent', agentId: 'architect', order: 0 },
    { id: 'frontend-node', type: 'agent', agentId: 'frontend', order: 1 }
  ]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-reconcile'
  });
  const architectTask = setup.taskItems[0]!;
  architectTask.status = 'completed';
  setup.callbacks[0]({ kind: 'workflow_step_completed', taskId: architectTask.id, resultSummary: 'Architecture ready.' });
  await settle();
  const frontendTask = setup.taskItems[1]!;
  frontendTask.status = 'waiting';
  setup.callbacks[1]({
    kind: 'cancelled',
    reason: 'User paused.',
    termination: {
      schemaVersion: '1.0',
      terminationId: 'pause-reconcile',
      kind: 'user_cancelled',
      source: 'user',
      scope: 'invocation',
      occurredAt: now
    }
  });
  await settle();
  frontendTask.dependsOnTaskIds = ['stale-upstream-task'];

  assert.equal(await setup.runtime.resumeCurrentExecution(run.id), true);
  assert.deepEqual(frontendTask.dependsOnTaskIds, [architectTask.id]);
  assert.deepEqual(setup.executionTaskBatches.at(-1)?.map((task) => task.id), [architectTask.id, frontendTask.id]);
  assert.equal(setup.eventItems.filter((item) => item.type === 'task_dependency_reconciled').length, 1);
});

test('WorkflowRuntimeService falls back to human approval for invalid robot output', async () => {
  const setup = fixture([
    { id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 },
    {
      id: 'robot-node',
      type: 'robot_approval',
      reviewerAgentId: 'reviewer',
      reviewPrompt: '检查需求',
      criteria: ['范围明确'],
      maxRevisionAttempts: 2,
      fallback: 'human_approval',
      order: 1
    }
  ]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-robot'
  });
  setup.taskItems[0].status = 'completed';
  setup.callbacks[0]({ kind: 'workflow_step_completed', taskId: setup.taskItems[0].id, resultSummary: '需求完成' });
  await settle();
  assert.equal(setup.taskItems[1].executionPurpose, 'workflow_review');

  setup.taskItems[1].status = 'completed';
  setup.callbacks[1]({ kind: 'workflow_step_completed', taskId: setup.taskItems[1].id, resultSummary: 'not-json' });
  await settle();

  assert.equal(setup.runtime.get(run.id).status, 'waiting_human');
  const fallback = setup.runtime.listNodeRuns(run.id).at(-1);
  assert.equal(fallback?.nodeType, 'human_approval');
  assert.equal(fallback?.fallbackFromRobot, true);
  assert.ok(fallback?.confirmationId);
});

test('WorkflowRuntimeService reschedules a superseded current node without cancelling the workflow', async () => {
  const setup = fixture([{ id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 }]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-reschedule'
  });

  assert.equal(await setup.runtime.rescheduleCurrentExecution(run.id, 'supplement-event-1'), true);
  assert.equal(setup.cancelCalls.length, 1);
  assert.equal(setup.cancelCalls[0][1].kind, 'superseded');
  assert.equal(setup.cancelCalls[0][1].diagnosticRef, 'supplement-event-1');

  setup.taskItems[0].status = 'waiting';
  setup.callbacks[0]({ kind: 'cancelled', reason: 'superseded' });
  await settle();

  assert.equal(setup.runtime.get(run.id).status, 'running');
  assert.equal(setup.taskItems[0].status, 'pending');
  assert.equal(setup.callbacks.length, 2);

  setup.taskItems[0].status = 'completed';
  setup.callbacks[1]({
    kind: 'workflow_step_completed',
    taskId: setup.taskItems[0].id,
    resultSummary: '补充上下文后完成'
  });
  await settle();
  assert.equal(setup.runtime.get(run.id).status, 'completed');
});

test('WorkflowRuntimeService keeps an invocation-level user pause resumable', async () => {
  const setup = fixture([{ id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 }]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-pause'
  });
  const nodeRun = setup.runtime.listNodeRuns(run.id)[0];
  setup.taskItems[0].status = 'waiting';

  setup.callbacks[0]({
    kind: 'cancelled',
    reason: '用户暂停当前执行。',
    termination: {
      schemaVersion: '1.0',
      terminationId: 'termination-pause',
      kind: 'user_cancelled',
      source: 'user',
      scope: 'invocation',
      occurredAt: now
    }
  });
  await settle();

  assert.equal(setup.runtime.get(run.id).status, 'running');
  assert.equal(nodeRun.status, 'running');
  assert.equal(setup.taskItems[0].status, 'waiting');
  assert.equal(await setup.runtime.resumeCurrentExecution(run.id), true);
  assert.equal(setup.taskItems[0].status, 'pending');
  assert.equal(setup.callbacks.length, 2);
});

test('WorkflowRuntimeService retries a failed workflow node as a new auditable attempt', async () => {
  const setup = fixture([{ id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 }]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-failed-retry'
  });
  const firstTask = setup.taskItems[0]!;
  const firstNodeRun = setup.runtime.listNodeRuns(run.id)[0]!;
  firstTask.status = 'failed';
  setup.callbacks[0]({ kind: 'failed', reason: 'Runtime failed.' });
  await settle();

  assert.equal(run.status, 'failed');
  assert.equal(run.currentNodeId, undefined);
  assert.equal(firstNodeRun.status, 'failed');
  assert.equal(firstNodeRun.error?.code, 'WORKFLOW_NODE_EXECUTION_FAILED');
  assert.ok(firstNodeRun.completedAt);

  assert.equal(await setup.runtime.resumeCurrentExecution(run.id), true);

  const secondTask = setup.taskItems[1]!;
  const secondNodeRun = setup.runtime.listNodeRuns(run.id)[1]!;
  assert.equal(run.status, 'running');
  assert.equal(run.currentNodeId, 'requirements-node');
  assert.equal(run.failure, undefined);
  assert.equal(run.completedAt, undefined);
  assert.equal(firstTask.status, 'failed');
  assert.equal(secondTask.status, 'assigned');
  assert.equal(secondNodeRun.status, 'running');
  assert.equal(secondNodeRun.attempt, 2);

  secondTask.status = 'failed';
  setup.callbacks[1]({ kind: 'failed', reason: 'Runtime failed again.' });
  await settle();

  assert.equal(run.status, 'failed');
  assert.equal(secondNodeRun.status, 'failed');
  assert.equal(setup.eventItems.filter((item) => item.type === 'workflow_run_failed').length, 2);
});

test('WorkflowRuntimeService refuses to resume a run owned by a different active WorkItem', async () => {
  const setup = fixture([{ id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 }]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-work-item-guard'
  });
  setup.taskItems[0]!.status = 'failed';
  setup.callbacks[0]!({ kind: 'failed', reason: 'Runtime failed.' });
  await settle();

  const switchedSession = { ...setup.session, activeWorkItemId: 'work-item-2' };
  const resumed = await setup.runtime.resumeCurrentExecution(run.id, {
    session: switchedSession,
    brief: setup.brief,
    coordinatorId: 'coordinator'
  });

  assert.equal(resumed, false);
  assert.equal(setup.runtime.get(run.id).status, 'failed');
  assert.equal(setup.callbacks.length, 1);
});

test('WorkflowRuntimeService keeps the current node resumable while workspace conflict is resolved', async () => {
  const setup = fixture([{ id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 }]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-workspace-conflict'
  });
  const nodeRun = setup.runtime.listNodeRuns(run.id)[0];
  setup.taskItems[0].status = 'waiting';

  setup.callbacks[0]({ kind: 'workspace_conflict', reason: 'merge conflict' });
  await settle();

  assert.equal(setup.runtime.get(run.id).status, 'running');
  assert.equal(nodeRun.status, 'running');
  assert.equal(setup.taskItems[0].status, 'waiting');
  assert.ok(setup.updates.some((item) => item.kind === 'session_outcome' && item.outcome.kind === 'workspace_conflict'));
});

test('WorkflowRuntimeService treats a session-level user cancellation as terminal', async () => {
  const setup = fixture([{ id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 }]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-cancel'
  });

  setup.callbacks[0]({
    kind: 'cancelled',
    reason: '用户取消会话。',
    termination: {
      schemaVersion: '1.0',
      terminationId: 'termination-cancel',
      kind: 'user_cancelled',
      source: 'user',
      scope: 'session',
      occurredAt: now
    }
  });
  await settle();

  assert.equal(setup.runtime.get(run.id).status, 'cancelled');
  assert.equal(await setup.runtime.resumeCurrentExecution(run.id), false);
});

test('WorkflowRuntimeService cancels a persisted run without ephemeral runtime context', async () => {
  const setup = fixture([{ id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 }]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-restored-cancel'
  });

  (setup.runtime as unknown as { contexts: Map<string, unknown> }).contexts.clear();

  const cancelled = await setup.runtime.cancel(run.id, 'Cancel after process recovery.');

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(setup.cancelCalls.length, 1);
  assert.equal(setup.cancelCalls[0][1].scope, 'session');
});
