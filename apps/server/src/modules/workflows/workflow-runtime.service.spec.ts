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
    participatingAgentIds: ['coordinator', 'requirements', 'frontend', 'reviewer', 'architect'],
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
  const createRuntime = () => new WorkflowRuntimeService(
    {
      get: () => ({ id: 'workflow-1', status: 'published' }),
      getVersion: () => version
    } as never,
    {
      getByIdOrKey: (id: string) => ({ id, key: id, name: id, role: id }),
      getForSurface: (id: string) => ({ id, key: id, name: id, role: id })
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
      create(input: Record<string, unknown>) {
        const event = { id: `event-${eventItems.length + 1}`, ...input };
        eventItems.push(event);
        return event;
      },
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
      getCollection: (key: string, fallback: unknown) => structuredClone(collections.get(key) ?? fallback),
      setCollection: (key: string, value: unknown) => collections.set(key, structuredClone(value))
    } as never
  );
  const runtime = createRuntime();
  runtime.updates().subscribe((update) => updates.push(update));
  return {
    runtime,
    createRuntime,
    session,
    brief,
    taskItems,
    eventItems,
    callbacks,
    cancelCalls,
    updates,
    collections,
    executionTaskBatches
  };
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('reliability flow preserves requirements and architecture across development, QA revise, retest and delivery handoff', async () => {
  const setup = fixture([
    { id: 'requirements', type: 'agent', agentId: 'requirements', order: 0 },
    { id: 'architecture', type: 'agent', agentId: 'architect', order: 1 },
    { id: 'development', type: 'agent', agentId: 'frontend', order: 2 },
    { id: 'quality', type: 'robot_approval', reviewerAgentId: 'reviewer', reviewPrompt: 'Check the implementation.',
      criteria: ['Tests pass.'], maxRevisionAttempts: 2, fallback: 'human_approval', order: 3 }
  ]);
  const run = await setup.runtime.start({ session: setup.session, brief: setup.brief, coordinatorId: 'coordinator',
    workflowId: 'workflow-1', confirmationId: 'reliability-full-flow' });
  const frozen = JSON.stringify(run.definitionSnapshot);
  const finish = async (index: number, summary: string) => {
    setup.taskItems[index].status = 'completed';
    setup.callbacks[index]({ kind: 'workflow_step_completed', taskId: setup.taskItems[index].id, resultSummary: summary });
    await settle();
  };
  await finish(0, 'Requirement confirmed');
  await finish(1, 'Architecture complete');
  await finish(2, 'Development complete');
  await finish(3, JSON.stringify({ decision: 'revise', reason: 'One test fails.', revisionInstruction: 'Fix the failed test.', evidenceRefs: [] }));
  assert.equal(setup.taskItems[4].workflowNodeId, 'development');
  await finish(4, 'Fixed and tested');
  await finish(5, JSON.stringify({ decision: 'approve', reason: 'Retest passed.', revisionInstruction: null, evidenceRefs: [] }));
  assert.equal(run.status, 'completed');
  assert.equal(setup.taskItems.filter(task => task.workflowNodeId === 'requirements').length, 1);
  assert.equal(setup.taskItems.filter(task => task.workflowNodeId === 'architecture').length, 1);
  assert.equal(setup.taskItems.filter(task => task.workflowNodeId === 'development').length, 2);
  assert.deepEqual(setup.runtime.listApprovals(run.id).map(item => item.decision), ['revise', 'approve']);
  assert.equal(JSON.stringify(run.definitionSnapshot), frozen);
  const count = setup.taskItems.length;
  setup.callbacks[5]({ kind: 'workflow_step_completed', taskId: setup.taskItems[5].id, resultSummary: 'late duplicate' });
  await settle();
  assert.equal(setup.taskItems.length, count);
});

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
  assert.deepEqual(setup.taskItems[0].eligibleAgentIds, ['requirements']);
  assert.equal(setup.taskItems[0].workflowAgentOverride, false);
  const taskEvents = setup.eventItems.filter((event) => event.type === 'task_created' || event.type === 'task_assigned');
  assert.deepEqual(taskEvents.map((event) => event.type), ['task_created', 'task_assigned']);
  const assignmentMetadata = taskEvents[1].metadata as { payload?: { assignee?: { id?: string } } };
  assert.equal(assignmentMetadata.payload?.assignee?.id, 'requirements');

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
      revisionInstruction: null,
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
  frontendTask.assignee = { type: 'agent', id: 'requirements' };
  frontendTask.eligibleAgentIds = undefined;

  assert.equal(await setup.runtime.resumeCurrentExecution(run.id), true);
  assert.deepEqual(frontendTask.assignee, { type: 'agent', id: 'frontend' });
  assert.deepEqual(frontendTask.eligibleAgentIds, ['frontend']);
  assert.deepEqual(frontendTask.dependsOnTaskIds, [architectTask.id]);
  assert.deepEqual(setup.executionTaskBatches.at(-1)?.map((task) => task.id), [architectTask.id, frontendTask.id]);
  assert.equal(setup.eventItems.filter((item) => item.type === 'task_dependency_reconciled').length, 1);
});

test('WorkflowRuntimeService applies an explicit Agent substitution without restoring the node default', async () => {
  const setup = fixture([
    { id: 'backend-node', type: 'agent', agentId: 'requirements', order: 0 }
  ]);
  setup.session.participatingAgentIds.push('frontend');
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-substitution'
  });
  const task = setup.taskItems[0]!;
  task.status = 'blocked';
  setup.callbacks[0]({
    kind: 'cancelled',
    reason: 'Waiting for user selection.',
    termination: {
      schemaVersion: '1.0',
      terminationId: 'workflow-substitution-wait',
      kind: 'user_cancelled',
      source: 'user',
      scope: 'invocation',
      occurredAt: now
    }
  });
  await settle();

  await setup.runtime.substituteCurrentAgent({ runId: run.id, taskId: task.id, agentId: 'frontend' });

  assert.deepEqual(task.assignee, { type: 'agent', id: 'frontend' });
  assert.deepEqual(task.eligibleAgentIds, ['frontend']);
  assert.equal(task.workflowAgentOverride, true);
  assert.equal(task.status, 'pending');
  assert.deepEqual(setup.executionTaskBatches.at(-1)?.map((item) => item.id), [task.id]);
  assert.equal(setup.eventItems.filter((item) => item.type === 'task_reassigned').length, 1);
});

test('WorkflowRuntimeService persists an explicit Agent substitution park and validates its confirmation', async () => {
  const setup = fixture([{ id: 'backend-node', type: 'agent', agentId: 'requirements', order: 0 }]);
  setup.session.participatingAgentIds.push('frontend');
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-persisted-substitution'
  });
  const task = setup.taskItems[0]!;
  task.status = 'blocked';
  setup.callbacks[0]!({ kind: 'ask_user', reason: 'Assigned Agent cannot accept this stage.' });
  await settle();

  const confirmationId = `workflow-agent-substitution:${run.id}:${task.id}`;
  await setup.runtime.requestAgentSubstitution({
    taskId: task.id,
    workflowRunId: run.id,
    workflowNodeId: 'backend-node',
    currentAgentId: 'requirements',
    candidates: [{ id: 'frontend', key: 'frontend', name: 'frontend', role: 'frontend' }],
    reason: 'Assigned Agent cannot accept this stage.',
    confirmationId
  });

  const parked = setup.runtime.get(run.id);
  assert.equal(parked.status, 'waiting_human');
  assert.equal(parked.pendingAgentSubstitution?.confirmationId, confirmationId);
  assert.equal(setup.runtime.listNodeRuns(run.id)[0]?.status, 'waiting');
  task.status = 'failed';
  assert.equal(setup.runtime.awaitsAgentSubstitution(run.id), true);
  assert.equal(await setup.runtime.resumeCurrentExecution(run.id), false);
  const persisted = setup.collections.get('workflowRuntime') as { runs?: Array<{ pendingAgentSubstitution?: unknown }> };
  assert.ok(persisted.runs?.[0]?.pendingAgentSubstitution);

  await assert.rejects(
    setup.runtime.substituteCurrentAgent({
      runId: run.id,
      taskId: task.id,
      agentId: 'frontend',
      confirmationId: 'stale-confirmation'
    }),
    /Bad Request/
  );
  await setup.runtime.substituteCurrentAgent({
    runId: run.id,
    taskId: task.id,
    agentId: 'frontend',
    confirmationId
  });
  assert.equal(setup.runtime.get(run.id).pendingAgentSubstitution, undefined);
  assert.equal(setup.runtime.listNodeRuns(run.id)[0]?.status, 'running');
  await assert.rejects(
    setup.runtime.substituteCurrentAgent({ runId: run.id, taskId: task.id, agentId: 'frontend', confirmationId }),
    /Bad Request/
  );
  assert.equal(setup.executionTaskBatches.length, 2);
});

test('WorkflowRuntimeService restores one pending Agent substitution without scheduling a new attempt', async () => {
  const setup = fixture([{ id: 'backend-node', type: 'agent', agentId: 'requirements', order: 0 }]);
  setup.session.participatingAgentIds.push('frontend');
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-restored-substitution'
  });
  const task = setup.taskItems[0]!;
  task.status = 'blocked';
  setup.callbacks[0]!({ kind: 'ask_user', reason: 'Assigned Agent cannot accept this stage.' });
  await settle();

  const confirmationId = `workflow-agent-substitution:${run.id}:${task.id}`;
  await setup.runtime.requestAgentSubstitution({
    taskId: task.id,
    workflowRunId: run.id,
    workflowNodeId: 'backend-node',
    currentAgentId: 'requirements',
    candidates: [{ id: 'frontend', key: 'frontend', name: 'frontend', role: 'frontend' }],
    reason: 'Assigned Agent cannot accept this stage.',
    confirmationId
  });
  const confirmationKey = `workflow-agent-substitution-confirmation:${run.id}:${task.id}`;
  const taskCountBeforeRecovery = setup.taskItems.length;
  const callbackCountBeforeRecovery = setup.callbacks.length;

  const restoredRuntime = setup.createRuntime();
  const restored = await restoredRuntime.recover(setup.session, setup.brief, 'coordinator');

  assert.equal(restored?.id, run.id);
  assert.equal(restored?.status, 'waiting_human');
  assert.equal(restored?.pendingAgentSubstitution?.confirmationId, confirmationId);
  assert.deepEqual(restored?.pendingAgentSubstitution?.candidates.map((agent) => agent.id), ['frontend']);
  assert.equal(restoredRuntime.listNodeRuns(run.id)[0]?.status, 'waiting');
  assert.equal(restoredRuntime.listNodeRuns(run.id)[0]?.attempt, 1);
  assert.equal(await restoredRuntime.resumeCurrentExecution(run.id), false);
  assert.equal(setup.taskItems.length, taskCountBeforeRecovery);
  assert.equal(setup.callbacks.length, callbackCountBeforeRecovery);
  assert.equal(setup.eventItems.filter((event) => event.idempotencyKey === confirmationKey).length, 1);
});

test('WorkflowRuntimeService skips the blocked current Agent and advances without reopening discussion', async () => {
  const setup = fixture([
    { id: 'backend-node', type: 'agent', agentId: 'requirements', order: 0 },
    { id: 'frontend-node', type: 'agent', agentId: 'frontend', order: 1 }
  ]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-skip'
  });
  const skippedTask = setup.taskItems[0]!;
  skippedTask.status = 'blocked';
  setup.callbacks[0]({
    kind: 'cancelled',
    reason: 'Waiting for user selection.',
    termination: {
      schemaVersion: '1.0',
      terminationId: 'workflow-skip-wait',
      kind: 'user_cancelled',
      source: 'user',
      scope: 'invocation',
      occurredAt: now
    }
  });
  await settle();

  await setup.runtime.skipCurrentAgent({
    runId: run.id,
    taskId: skippedTask.id,
    reason: '跳过当前 Agent，继续执行'
  });

  const skippedNodeRun = setup.runtime.listNodeRuns(run.id).find((item) => item.relatedTaskId === skippedTask.id);
  assert.equal(skippedTask.status, 'cancelled');
  assert.equal(skippedNodeRun?.status, 'skipped');
  assert.equal(run.currentNodeId, 'frontend-node');
  assert.equal(setup.executionTaskBatches.at(-1)?.[0]?.workflowNodeId, 'frontend-node');
  const completedEvent = setup.eventItems.find((item) =>
    item.type === 'workflow_node_completed' && item.taskId === skippedTask.id
  );
  assert.equal((completedEvent?.metadata as { payload?: { status?: string } })?.payload?.status, 'skipped');
});

test('WorkflowRuntimeService parks a node that reports incomplete upstream input', async () => {
  const setup = fixture([
    { id: 'architect-node', type: 'agent', agentId: 'architect', order: 0 },
    { id: 'frontend-node', type: 'agent', agentId: 'frontend', order: 1 }
  ]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-upstream'
  });
  const architectTask = setup.taskItems[0]!;
  architectTask.status = 'completed';
  setup.callbacks[0]({ kind: 'workflow_step_completed', taskId: architectTask.id, resultSummary: '架构完成' });
  await settle();

  const frontendTask = setup.taskItems[1]!;
  frontendTask.status = 'failed';
  setup.callbacks[1]({
    kind: 'ask_user',
    reason: '上游没有交付 API 合同，无法实现前端。',
    workflowUpstreamIncomplete: {
      taskId: frontendTask.id,
      workflowRunId: run.id,
      workflowNodeId: 'frontend-node',
      reason: '上游没有交付 API 合同，无法实现前端。',
      missingInputs: ['API 合同']
    }
  });
  await settle();

  const parked = setup.runtime.pendingUpstreamRerun(run.id);
  assert.equal(setup.runtime.awaitsUpstreamRerun(run.id), true);
  assert.equal(parked?.nodeId, 'frontend-node');
  assert.deepEqual(parked?.missingInputs, ['API 合同']);
  assert.deepEqual(parked?.candidates.map((item) => item.nodeId), ['architect-node']);
  assert.equal(setup.runtime.get(run.id).status, 'waiting_human');

  const card = setup.eventItems.find((item) =>
    item.type === 'user_confirmation_requested' &&
    (item.metadata as { payload?: { reason?: string } })?.payload?.reason === 'workflow_upstream_rerun'
  );
  assert.ok(card);
  const options = (card?.metadata as { payload?: { options?: Array<{ key: string }> } })?.payload?.options ?? [];
  assert.deepEqual(options.map((option) => option.key), ['node:architect-node', 'retry_current', 'cancel']);

  // A parked run must never resume implicitly: that would replay the same node
  // against the same missing upstream output.
  assert.equal(await setup.runtime.resumeCurrentExecution(run.id), false);
  assert.equal(setup.runtime.checkpointInterruptedExecution(run.id, { code: 'X', message: 'y' }), false);
  // The park is not an approval gate even though it also sits at waiting_human.
  const gateAttempt = setup.runtime.decideHuman({
    runId: run.id,
    nodeRunId: parked!.nodeRunId,
    confirmationId: `workflow-upstream-rerun:${run.id}:${parked!.nodeRunId}`,
    userId: 'local-user',
    decision: 'approve'
  }).then(() => 'resolved', (error: Error) => error.message);
  assert.match(String(await gateAttempt), /Bad Request/);
  await settle();
});

test('WorkflowRuntimeService re-runs the chosen upstream node and walks forward again', async () => {
  const setup = fixture([
    { id: 'architect-node', type: 'agent', agentId: 'architect', order: 0 },
    { id: 'frontend-node', type: 'agent', agentId: 'frontend', order: 1 }
  ]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-upstream-rerun'
  });
  const architectTask = setup.taskItems[0]!;
  architectTask.status = 'completed';
  setup.callbacks[0]({ kind: 'workflow_step_completed', taskId: architectTask.id, resultSummary: '架构完成' });
  await settle();
  const parkedTask = setup.taskItems[1]!;
  parkedTask.status = 'failed';
  setup.callbacks[1]({
    kind: 'ask_user',
    reason: '缺少数据库结构。',
    workflowUpstreamIncomplete: {
      taskId: parkedTask.id,
      workflowRunId: run.id,
      workflowNodeId: 'frontend-node',
      reason: '缺少数据库结构。',
      missingInputs: ['数据库结构']
    }
  });
  await settle();
  const parked = setup.runtime.pendingUpstreamRerun(run.id)!;

  await setup.runtime.rerunUpstreamNode({
    runId: run.id,
    confirmationId: `workflow-upstream-rerun:${run.id}:${parked.nodeRunId}`,
    nodeId: 'architect-node'
  });

  assert.equal(setup.runtime.awaitsUpstreamRerun(run.id), false);
  assert.equal(setup.runtime.get(run.id).currentNodeId, 'architect-node');
  // The parked task must be terminal, otherwise Post Review re-drives it.
  assert.ok(['failed', 'cancelled'].includes(parkedTask.status));
  assert.match(parkedTask.resultSummary ?? '', /退回上游节点重新执行/);
  const parkedNodeRun = setup.runtime.listNodeRuns(run.id).find((item) => item.id === parked.nodeRunId);
  assert.equal(parkedNodeRun?.status, 'revision_requested');
  assert.ok(setup.eventItems.some((item) => item.type === 'workflow_node_revision_requested'));

  const architectRetry = setup.taskItems.at(-1)!;
  assert.equal(architectRetry.workflowNodeId, 'architect-node');
  assert.equal(architectRetry.workflowAttempt, 2);

  architectRetry.status = 'completed';
  setup.callbacks.at(-1)!({
    kind: 'workflow_step_completed',
    taskId: architectRetry.id,
    resultSummary: '补齐数据库结构'
  });
  await settle();

  // Forward walk reaches the parked node again as a fresh attempt fed by the new output.
  const frontendRetry = setup.taskItems.at(-1)!;
  assert.equal(frontendRetry.workflowNodeId, 'frontend-node');
  assert.equal(frontendRetry.workflowAttempt, 2);
  assert.deepEqual(frontendRetry.dependsOnTaskIds, [architectRetry.id]);
});

test('WorkflowRuntimeService retries the parked node itself without re-running upstream', async () => {
  const setup = fixture([
    { id: 'architect-node', type: 'agent', agentId: 'architect', order: 0 },
    { id: 'frontend-node', type: 'agent', agentId: 'frontend', order: 1 }
  ]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-retry-parked'
  });
  setup.taskItems[0]!.status = 'completed';
  setup.callbacks[0]({ kind: 'workflow_step_completed', taskId: setup.taskItems[0]!.id, resultSummary: '架构完成' });
  await settle();
  const parkedTask = setup.taskItems[1]!;
  parkedTask.status = 'failed';
  setup.callbacks[1]({
    kind: 'ask_user',
    reason: '缺少接口定义。',
    workflowUpstreamIncomplete: {
      taskId: parkedTask.id,
      workflowRunId: run.id,
      workflowNodeId: 'frontend-node',
      reason: '缺少接口定义。',
      missingInputs: []
    }
  });
  await settle();
  const parked = setup.runtime.pendingUpstreamRerun(run.id)!;

  await setup.runtime.retryParkedNode({
    runId: run.id,
    confirmationId: `workflow-upstream-rerun:${run.id}:${parked.nodeRunId}`
  });

  assert.equal(setup.runtime.awaitsUpstreamRerun(run.id), false);
  assert.equal(setup.runtime.get(run.id).status, 'running');
  assert.equal(setup.runtime.get(run.id).currentNodeId, 'frontend-node');
  const retry = setup.taskItems.at(-1)!;
  assert.equal(retry.workflowNodeId, 'frontend-node');
  assert.equal(retry.workflowAttempt, 2);
});

test('WorkflowRuntimeService forwards ask_user unchanged when there is no upstream Agent node', async () => {
  const setup = fixture([
    { id: 'architect-node', type: 'agent', agentId: 'architect', order: 0 }
  ]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-no-upstream'
  });
  const task = setup.taskItems[0]!;
  task.status = 'failed';
  setup.callbacks[0]({
    kind: 'ask_user',
    reason: '读不到工作区文件。',
    workflowUpstreamIncomplete: {
      taskId: task.id,
      workflowRunId: run.id,
      workflowNodeId: 'architect-node',
      reason: '读不到工作区文件。',
      missingInputs: ['src/main.ts']
    }
  });
  await settle();

  assert.equal(setup.runtime.awaitsUpstreamRerun(run.id), false);
  assert.ok(setup.updates.some((item) => item.kind === 'session_outcome' && item.outcome.kind === 'ask_user'));
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

test('WorkflowRuntimeService sends incomplete or extended robot decisions to one human fallback', async () => {
  for (const resultSummary of [
    JSON.stringify({ decision: 'revise', reason: 'Needs changes.', revisionInstruction: null, evidenceRefs: [] }),
    JSON.stringify({ decision: 'approve', reason: 'Looks good.', revisionInstruction: null, evidenceRefs: [], extra: true })
  ]) {
    const setup = fixture([
      { id: 'frontend-node', type: 'agent', agentId: 'frontend', order: 0 },
      {
        id: 'robot-node',
        type: 'robot_approval',
        reviewerAgentId: 'reviewer',
        reviewPrompt: 'Review the frontend.',
        criteria: ['The UI is correct.'],
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
      confirmationId: `select-invalid-${resultSummary.length}`
    });
    setup.taskItems[0]!.status = 'completed';
    setup.callbacks[0]!({ kind: 'workflow_step_completed', taskId: setup.taskItems[0]!.id, resultSummary: 'Frontend done.' });
    await settle();
    setup.taskItems[1]!.status = 'completed';
    setup.callbacks[1]!({ kind: 'workflow_step_completed', taskId: setup.taskItems[1]!.id, resultSummary });
    await settle();
    setup.callbacks[1]!({ kind: 'workflow_step_completed', taskId: setup.taskItems[1]!.id, resultSummary });
    await settle();

    assert.equal(setup.runtime.get(run.id).status, 'waiting_human');
    assert.equal(setup.runtime.listNodeRuns(run.id).filter((item) => item.fallbackFromRobot).length, 1);
    assert.equal(setup.runtime.listApprovals(run.id).length, 0);
  }
});

test('WorkflowRuntimeService treats strict robot reject as terminal without creating a rework attempt', async () => {
  const setup = fixture([
    { id: 'frontend-node', type: 'agent', agentId: 'frontend', order: 0 },
    {
      id: 'robot-node',
      type: 'robot_approval',
      reviewerAgentId: 'reviewer',
      reviewPrompt: 'Review the frontend.',
      criteria: ['The result is policy compliant.'],
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
    confirmationId: 'select-terminal-reject'
  });
  setup.taskItems[0]!.status = 'completed';
  setup.callbacks[0]!({ kind: 'workflow_step_completed', taskId: setup.taskItems[0]!.id, resultSummary: 'Frontend done.' });
  await settle();
  setup.taskItems[1]!.status = 'completed';
  setup.callbacks[1]!({
    kind: 'workflow_step_completed',
    taskId: setup.taskItems[1]!.id,
    resultSummary: JSON.stringify({
      decision: 'reject',
      reason: 'The result violates a non-negotiable policy.',
      revisionInstruction: null,
      evidenceRefs: ['policy:1']
    })
  });
  await settle();

  assert.equal(setup.runtime.get(run.id).status, 'failed');
  assert.equal(setup.runtime.get(run.id).failure?.code, 'WORKFLOW_ROBOT_REJECTED');
  assert.equal(setup.taskItems.filter((task) => task.workflowNodeId === 'frontend-node').length, 1);
  assert.equal(setup.runtime.listApprovals(run.id).at(-1)?.decision, 'reject');
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

test('WorkflowRuntimeService checkpoints an interrupted node and resumes it as a new attempt', async () => {
  const setup = fixture([{ id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 }]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-interruption-recovery'
  });
  const firstTask = setup.taskItems[0]!;
  const firstNodeRun = setup.runtime.listNodeRuns(run.id)[0]!;

  firstTask.executionOperationId = 'operation-interrupted';
  firstTask.executionCheckpoint = { operationId: 'operation-interrupted', invocationId: 'invocation-interrupted',
    candidateId: 'candidate-interrupted', candidateHash: 'hash', stage: 'candidate_captured' };
  assert.equal(setup.runtime.checkpointInterruptedExecution(run.id, {
    code: 'SERVICE_SHUTDOWN',
    message: 'Backend stopped during execution.'
  }), true);
  assert.equal(run.status, 'failed');
  assert.equal(firstNodeRun.status, 'failed');
  assert.equal(firstTask.status, 'failed');
  setup.callbacks[0]({ kind: 'cancelled', reason: 'Backend stopped during execution.' });
  await settle();

  assert.equal(await setup.runtime.resumeCurrentExecution(run.id, {
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator'
  }), true);
  assert.equal(run.status, 'running');
  assert.equal(setup.runtime.listNodeRuns(run.id)[1]?.attempt, 2);
  assert.equal(setup.taskItems[1]?.status, 'assigned');
  assert.equal(firstNodeRun.executionCheckpoint?.candidateId, 'candidate-interrupted');
  assert.equal(setup.taskItems[1]?.recoveryOriginTaskId, firstTask.id);
  assert.equal(setup.taskItems[1]?.previousExecutionOperationId, 'operation-interrupted');
});

test('WorkflowRuntimeService reworks only the last agent node instead of replaying the whole definition', async () => {
  const setup = fixture([
    { id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 },
    { id: 'frontend-node', type: 'agent', agentId: 'frontend', order: 1 }
  ]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-rework-last-node'
  });

  setup.taskItems[0]!.status = 'completed';
  setup.callbacks[0]!({ kind: 'workflow_step_completed', taskId: setup.taskItems[0]!.id, resultSummary: '需求完成' });
  await settle();
  setup.taskItems[1]!.status = 'completed';
  setup.callbacks[1]!({ kind: 'workflow_step_completed', taskId: setup.taskItems[1]!.id, resultSummary: '前端完成' });
  await settle();
  assert.equal(setup.runtime.get(run.id).status, 'completed');
  assert.equal(setup.taskItems.length, 2);

  // Completing the last node starts the post review, which holds the execution
  // slot. Rework is only requested once that review reports back.
  assert.equal(setup.callbacks.length, 3);
  setup.callbacks[2]!({ kind: 'rework', reason: '复盘要求返工。' });
  await settle();

  const reworked = await setup.runtime.reworkLastAgentNode(run.id, '复盘要求返工。', {
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator'
  });

  assert.equal(reworked, true);
  assert.equal(setup.runtime.get(run.id).id, run.id);
  assert.equal(setup.runtime.get(run.id).status, 'running');
  assert.equal(setup.runtime.get(run.id).currentNodeId, 'frontend-node');
  // Only the last agent node runs again: the approved upstream node keeps its
  // single task and never re-enters execution.
  assert.equal(setup.taskItems.length, 3);
  assert.equal(setup.taskItems[2]!.workflowNodeId, 'frontend-node');
  assert.equal(setup.taskItems.filter((item) => item.workflowNodeId === 'requirements-node').length, 1);
  assert.equal(setup.executionTaskBatches.length, 4);
  // The approved upstream task still travels along as context, but only the
  // frontend node is assigned again.
  assert.deepEqual(
    setup.executionTaskBatches[3]!.filter((item) => item.status === 'assigned').map((item) => item.workflowNodeId),
    ['frontend-node']
  );
});

test('WorkflowRuntimeService refuses to resume a node parked on an agent that declined', async () => {
  const setup = fixture([{ id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 }]);
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'select-awaits-substitution'
  });
  const nodeRun = setup.runtime.listNodeRuns(run.id)[0]!;
  setup.taskItems[0]!.status = 'blocked';

  setup.callbacks[0]!({ kind: 'ask_user', reason: 'Agent 拒绝该任务。' });
  await settle();

  assert.equal(setup.runtime.get(run.id).status, 'running');
  assert.equal(nodeRun.status, 'running');
  assert.equal(setup.runtime.awaitsAgentSubstitution(run.id), true);
  assert.equal(await setup.runtime.resumeCurrentExecution(run.id, {
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator'
  }), false);
  assert.equal(setup.callbacks.length, 1);
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

test('WorkflowRuntimeService rejects an old generation outcome and adopts the restored generation only on explicit resume', async () => {
  const setup = fixture([
    { id: 'development', type: 'agent', agentId: 'frontend', order: 0 }
  ]);
  setup.collections.set('sessionLifecyclesBySession', {
    [setup.session.id]: {
      contractVersion: 'main-agent-collaboration/v1',
      sessionId: setup.session.id,
      dataEpoch: setup.session.dataEpoch,
      generation: 1,
      revision: 1,
      state: 'active',
      admission: 'open',
      stopStatus: 'idle'
    }
  });
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    confirmationId: 'generation-bound-workflow',
    sessionGeneration: 1
  });
  const task = setup.taskItems[0]!;
  setup.collections.set('sessionLifecyclesBySession', {
    [setup.session.id]: {
      contractVersion: 'main-agent-collaboration/v1',
      sessionId: setup.session.id,
      dataEpoch: setup.session.dataEpoch,
      generation: 3,
      revision: 4,
      state: 'active',
      admission: 'open',
      stopStatus: 'confirmed'
    }
  });

  setup.callbacks[0]({ kind: 'workflow_step_completed', taskId: task.id, resultSummary: 'obsolete result' });
  await settle();

  assert.equal(task.status, 'assigned');
  assert.equal(run.sessionGeneration, 1);
  assert.equal(await setup.runtime.resumeCurrentExecution(run.id, {
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    sessionGeneration: 3
  }), true);
  assert.equal(run.sessionGeneration, 3);
  assert.equal(setup.callbacks.length, 2);
});

test('a start bound to a republished version hash is refused instead of running a different graph', async () => {
  const setup = fixture([
    { id: 'requirements-node', type: 'agent', agentId: 'requirements', order: 0 }
  ]);

  // The user approved a member mapping against the graph they were shown. If the
  // workflow is republished before the start lands, the same version number can
  // carry different nodes, so the captured hash is what makes the start safe.
  await assert.rejects(
    () => setup.runtime.start({
      session: setup.session,
      brief: setup.brief,
      coordinatorId: 'coordinator',
      workflowId: 'workflow-1',
      workflowVersion: 1,
      definitionHash: 'hash-the-user-saw-earlier',
      confirmationId: 'select-stale-hash'
    }),
    (error: unknown) => String((error as Error).message).includes('WORKFLOW_VERSION_CHANGED')
  );
  assert.equal(setup.taskItems.length, 0, 'no node may start against an unverified graph');

  // The same selection with the hash it was actually evaluated against runs.
  const run = await setup.runtime.start({
    session: setup.session,
    brief: setup.brief,
    coordinatorId: 'coordinator',
    workflowId: 'workflow-1',
    workflowVersion: 1,
    definitionHash: 'hash',
    confirmationId: 'select-good-hash'
  });
  assert.equal(run.definitionSnapshot.definitionHash, 'hash');
  assert.equal(setup.taskItems.length, 1);
});

test('rework follows the published graph edges, not the node array order', async () => {
  // The graph sends the gate back to "early", even though "late" is the closest
  // preceding node in definition order. Rework that ignores edges would re-run a
  // node the published graph never connected to this gate.
  const setup = fixture([
    { id: 'early', type: 'agent', agentId: 'requirements', order: 0 },
    { id: 'late', type: 'agent', agentId: 'frontend', order: 1 },
    { id: 'gate', type: 'human_approval', title: 'Check', assignee: 'session_owner', allowedDecisions: ['approve', 'revise', 'cancel'], order: 2 }
  ], [
    { id: 'edge:early:gate', sourceNodeId: 'early', targetNodeId: 'gate' }
  ]);
  const run = await setup.runtime.start({ session: setup.session, brief: setup.brief, coordinatorId: 'coordinator',
    workflowId: 'workflow-1', confirmationId: 'rework-graph' });

  const finish = async (index: number, summary: string) => {
    setup.taskItems[index].status = 'completed';
    setup.callbacks[index]({ kind: 'workflow_step_completed', taskId: setup.taskItems[index].id, resultSummary: summary });
    await settle();
  };
  await finish(0, 'early done');
  await finish(1, 'late done');

  const gateRun = setup.runtime.listNodeRuns(run.id).find((item) => item.nodeType === 'human_approval' && item.status === 'waiting');
  assert.ok(gateRun, 'the gate must be waiting for a human decision');
  await setup.runtime.decideHuman({ runId: run.id, nodeRunId: gateRun.id, confirmationId: gateRun.confirmationId!,
    userId: setup.session.ownerId, decision: 'revise', instruction: '补充验收标准' });
  await settle();

  assert.equal(run.currentNodeId, 'early', 'the graph edge decides the rework target');
  const reworkTask = setup.taskItems[setup.taskItems.length - 1];
  assert.equal(reworkTask.workflowNodeId, 'early');
});

test('a gate with no legal rework edge waits for explicit handling instead of failing the run', async () => {
  // AC7: no legal edge is a reason to wait with a stated cause, not to declare the
  // requirement failed. Failing here would lose the user's approved document.
  const setup = fixture([
    { id: 'gate', type: 'human_approval', title: 'Check', assignee: 'session_owner', allowedDecisions: ['approve', 'revise', 'cancel'], order: 0 }
  ]);
  const run = await setup.runtime.start({ session: setup.session, brief: setup.brief, coordinatorId: 'coordinator',
    workflowId: 'workflow-1', confirmationId: 'rework-no-target' });
  await settle();

  const gateRun = setup.runtime.listNodeRuns(run.id).find((item) => item.nodeType === 'human_approval' && item.status === 'waiting');
  assert.ok(gateRun);
  await setup.runtime.decideHuman({ runId: run.id, nodeRunId: gateRun.id, confirmationId: gateRun.confirmationId!,
    userId: setup.session.ownerId, decision: 'revise', instruction: '需要改上一环节' });
  await settle();

  assert.notEqual(run.status, 'failed', 'a missing rework target is a wait, not a failed requirement');
  assert.equal(run.status, 'waiting_human');
  assert.equal(setup.runtime.awaitsRevisionHandoff(run.id), true);
  const handoff = setup.runtime.pendingRevisionHandoff(run.id);
  assert.equal(handoff?.reason, 'WORKFLOW_REVISION_TARGET_MISSING');
  assert.equal(handoff?.instruction, '需要改上一环节');
  // The coordinator needs an event to bring the situation to the user.
  assert.ok(setup.eventItems.some((item) => item.type === 'workflow_gate_requested' &&
    (item.metadata as { payload?: { reason?: string } })?.payload?.reason === 'WORKFLOW_REVISION_TARGET_MISSING'),
    'the wait must be visible as an event, not only as internal state');
  assert.ok(setup.eventItems.some((item) => item.type === 'user_confirmation_requested' &&
    (item.metadata as { payload?: { reason?: string } })?.payload?.reason === 'workflow_revision_handoff'),
    'the user gets a card that names the two ways out');
});

test('a parked revision handoff cannot be walked past by a stray completion', async () => {
  const setup = fixture([
    { id: 'gate', type: 'human_approval', title: 'Check', assignee: 'session_owner', allowedDecisions: ['approve', 'revise', 'cancel'], order: 0 }
  ]);
  const run = await setup.runtime.start({ session: setup.session, brief: setup.brief, coordinatorId: 'coordinator',
    workflowId: 'workflow-1', confirmationId: 'rework-park-guard' });
  await settle();
  const gateRun = setup.runtime.listNodeRuns(run.id).find((item) => item.nodeType === 'human_approval' && item.status === 'waiting')!;
  await setup.runtime.decideHuman({ runId: run.id, nodeRunId: gateRun.id, confirmationId: gateRun.confirmationId!,
    userId: setup.session.ownerId, decision: 'revise', instruction: 'x' });
  await settle();

  // A second decision on the same parked run must be refused rather than
  // silently resolving the wait.
  await assert.rejects(() => setup.runtime.decideHuman({
    runId: run.id, nodeRunId: gateRun.id, confirmationId: gateRun.confirmationId!,
    userId: setup.session.ownerId, decision: 'approve'
  }));
  assert.equal(setup.runtime.awaitsRevisionHandoff(run.id), true);
});
