import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXECUTION_PROGRESS_HEADLINES,
  executionProgressView,
  type ExecutionProgressInput
} from './execution-progress-projection.js';

function input(overrides: Partial<ExecutionProgressInput> = {}): ExecutionProgressInput {
  return {
    run: {
      status: 'running',
      currentNodeId: 'develop',
      nodes: [
        { id: 'requirements', type: 'agent', name: '需求梳理', order: 0 },
        { id: 'develop', type: 'agent', name: '开发实现', order: 1 },
        { id: 'quality', type: 'robot_approval', name: '质量验证', order: 2 }
      ]
    },
    tasks: [
      { id: 'task-1', title: '梳理导出范围', status: 'completed', workflowNodeId: 'requirements' },
      { id: 'task-2', title: '实现导出接口', status: 'running', workflowNodeId: 'develop' }
    ],
    ...overrides
  };
}

test('a status question is answered from the published graph, not from invented stage names', () => {
  const view = executionProgressView(input());

  assert.equal(view.headline, EXECUTION_PROGRESS_HEADLINES.running);
  assert.equal(view.currentStage, '开发实现');
  assert.deepEqual(view.completedStages, ['需求梳理']);
  assert.deepEqual(view.remainingStages, ['质量验证']);
  // Every stage name comes from the snapshot the user approved.
  for (const stage of [view.currentStage, ...view.completedStages, ...view.remainingStages]) {
    assert.ok(['需求梳理', '开发实现', '质量验证'].includes(stage!), `unexpected stage: ${stage}`);
  }
});

test('the headline is drawn from a fixed vocabulary so an answer cannot carry model prose', () => {
  const allowed = Object.values(EXECUTION_PROGRESS_HEADLINES);
  const cases: ExecutionProgressInput[] = [
    input(),
    input({ run: { ...input().run!, status: 'waiting_human' } }),
    input({ run: { ...input().run!, status: 'completed', currentNodeId: undefined } }),
    input({ run: { ...input().run!, status: 'failed', currentNodeId: undefined } }),
    input({ run: { ...input().run!, status: 'cancelled', currentNodeId: undefined } }),
    input({ run: undefined, tasks: [] })
  ];

  for (const item of cases) {
    assert.ok(allowed.includes(executionProgressView(item).headline), 'headline must be a known phrase');
  }
});

test('a blocked or failed task is surfaced instead of reading as ordinary progress', () => {
  const view = executionProgressView(input({
    tasks: [
      { id: 'task-1', title: '梳理导出范围', status: 'completed', workflowNodeId: 'requirements' },
      { id: 'task-2', title: '实现导出接口', status: 'blocked', workflowNodeId: 'develop' },
      { id: 'task-3', title: '补充用例', status: 'failed', workflowNodeId: 'develop' }
    ]
  }));

  assert.deepEqual(
    view.attentionTasks.map((item) => [item.id, item.reason]),
    [['task-2', 'blocked'], ['task-3', 'failed']]
  );
  // "Still running" would hide a stuck requirement behind a spinner.
  assert.equal(view.needsAttention, true);
});

test('an approval gate is an explicit wait on the user, not a running stage', () => {
  const view = executionProgressView(input({
    run: { ...input().run!, status: 'waiting_human', currentNodeId: 'quality' }
  }));

  assert.equal(view.headline, EXECUTION_PROGRESS_HEADLINES.waitingUser);
  assert.equal(view.awaitingUser, true);
  assert.equal(view.currentStage, '质量验证');
});

test('a parked rework handoff reads as a wait with its own reason, never as progress', () => {
  const view = executionProgressView(input({
    run: { ...input().run!, status: 'waiting_human', pendingRevisionHandoff: true }
  }));

  assert.equal(view.awaitingUser, true);
  assert.equal(view.waitReason, 'revision_handoff');
});

test('an upstream rerun park is distinguishable from an ordinary approval wait', () => {
  const upstream = executionProgressView(input({
    run: { ...input().run!, status: 'waiting_human', pendingUpstreamRerun: true }
  }));
  const gate = executionProgressView(input({
    run: { ...input().run!, status: 'waiting_human' }
  }));

  assert.equal(upstream.waitReason, 'upstream_rerun');
  assert.equal(gate.waitReason, 'approval_gate');
});

test('queued scope changes are part of the answer so the user is not told work is simply proceeding', () => {
  const view = executionProgressView(input({
    pendingChangeRequests: [
      { id: 'change-1', summary: '顺便加一个导出按钮', status: 'waiting_user' },
      { id: 'change-2', summary: '导出要含退款明细', status: 'deferred' }
    ]
  }));

  assert.deepEqual(view.pendingChanges.map((item) => item.id), ['change-1', 'change-2']);
  assert.equal(view.pendingChanges[0]?.awaitingUser, true, 'a change waiting on the user is called out');
  assert.equal(view.pendingChanges[1]?.awaitingUser, false, 'a deferred change is parked, not asking anything');
});

test('a session with no run yet answers plainly instead of reporting an empty stage list', () => {
  const view = executionProgressView({ run: undefined, tasks: [] });

  assert.equal(view.headline, EXECUTION_PROGRESS_HEADLINES.notStarted);
  assert.equal(view.currentStage, undefined);
  assert.deepEqual(view.completedStages, []);
  assert.deepEqual(view.remainingStages, []);
  assert.equal(view.awaitingUser, false);
});

test('the same state always produces the same answer, so a repeated question costs no model call', () => {
  const state = input({ pendingChangeRequests: [{ id: 'change-1', summary: 'x', status: 'waiting_user' }] });

  assert.deepEqual(executionProgressView(state), executionProgressView(state));
});

test('a node the graph never declared cannot become the current stage', () => {
  const view = executionProgressView(input({
    run: { ...input().run!, currentNodeId: 'ghost-node' }
  }));

  // An unknown current node means the projection reports no stage rather than
  // inventing one; the run is still described by its status.
  assert.equal(view.currentStage, undefined);
  assert.equal(view.headline, EXECUTION_PROGRESS_HEADLINES.running);
});
