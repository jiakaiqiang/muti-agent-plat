import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTask, SessionDetail, TaskBrief, WorkflowVersion } from '@agent-cluster/shared';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';

const now = '2026-07-14T00:00:00.000Z';

function fixture(nodes: WorkflowVersion['nodes']) {
  const session: SessionDetail = {
    id: 'session-1',
    dataEpoch: 'epoch-1',
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
    edges: nodes.slice(0, -1).map((node, index) => ({
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
  const cancelCalls: any[][] = [];
  const updates: any[] = [];
  let executionRunning = false;
  const runtime = new WorkflowRuntimeService(
    {
      get: () => ({ id: 'workflow-1', status: 'published' }),
      getVersion: () => version
    } as never,
    {
      getByIdOrKey: (id: string) => ({ id, name: id })
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
      start(_session: SessionDetail, _brief: TaskBrief, _tasks: AgentTask[], callback: (outcome: any) => void) {
        executionRunning = true;
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
  return { runtime, session, brief, taskItems, eventItems, callbacks, cancelCalls, updates, collections };
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

  setup.taskItems[1].status = 'completed';
  setup.callbacks[1]({ kind: 'workflow_step_completed', taskId: setup.taskItems[1].id, resultSummary: '前端完成' });
  await settle();
  assert.equal(setup.runtime.get(run.id).status, 'completed');
  assert.ok(setup.updates.some((item) => item.kind === 'projection' && item.status === 'waiting_human'));
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
