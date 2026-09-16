import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;
const workspacePath = mkdtempSync(join(tmpdir(), 'agent-cluster-workflow-substitution-'));
writeFileSync(join(workspacePath, 'README.md'), 'workflow substitution smoke fixture\n');

async function createRejectedWorkflow(apiBase, name) {
  const agents = (await api(apiBase, '/agents')).data;
  const byKey = new Map(agents.map((agent) => [agent.key, agent]));
  const requirements = byKey.get('requirements');
  const frontend = byKey.get('frontend');
  if (!requirements || !frontend) {
    throw new Error('Workflow substitution smoke requires requirements and frontend Agents.');
  }

  const draft = (await api(apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name,
      nodes: [{
        id: `${name}-node`,
        type: 'agent',
        agentId: requirements.id,
        stageDescription: 'Run the rejected workflow stage.',
        outputContract: ['Produce a deterministic workflow result.'],
        order: 0
      }]
    })
  })).data;
  const workflow = (await api(apiBase, `/workflows/${draft.id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
  })).data;

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    apiBase,
    '验证工作流 Agent 接单拒绝后的显式用户决策闭环。',
    {
      agentIds: ['requirements', 'frontend'],
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] },
      workingDirectory: {
        kind: 'server_local',
        path: workspacePath,
        name: basename(workspacePath)
      }
    }
  );
  await api(apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(apiBase, sessionId, 'WAIT_WORKFLOW_SELECT');
  const selection = await waitForMatchingEvent(
    apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload?.reason === 'select_workflow'
  );
  const selected = (await api(apiBase, `/sessions/${sessionId}/workflow/select`, {
    method: 'POST',
    body: JSON.stringify({
      workflowId: workflow.id,
      workflowVersion: workflow.currentPublishedVersion,
      confirmationId: selection.metadata.payload.confirmationId
    })
  })).data;

  const waitingSession = await waitForStatus(apiBase, sessionId, 'WAIT_USER_DECISION', 30_000);
  const waitingRun = (await api(apiBase, `/workflow-runs/${selected.workflowRun.id}`)).data;
  const taskId = waitingRun.run.nodeTaskIds?.[0] ?? waitingRun.nodeRuns[0]?.relatedTaskId;
  if (!taskId) throw new Error(`Waiting workflow run did not expose its current task: ${JSON.stringify(waitingRun)}`);
  const confirmation = await waitForMatchingEvent(
    apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) =>
      event.metadata.payload?.reason === 'workflow_agent_substitution' &&
      event.metadata.payload?.relatedTaskId === taskId,
    30_000
  );

  const session = (await api(apiBase, `/sessions/${sessionId}`)).data;
  const runDetail = (await api(apiBase, `/workflow-runs/${selected.workflowRun.id}`)).data;
  const tasks = (await api(apiBase, `/sessions/${sessionId}/tasks`)).data;
  const nodeRun = runDetail.nodeRuns.find((item) => item.relatedTaskId === taskId);
  const task = tasks.find((item) => item.id === taskId);
  if (waitingSession.status !== 'WAIT_USER_DECISION' || session.status !== 'WAIT_USER_DECISION') {
    throw new Error(`Expected WAIT_USER_DECISION: ${JSON.stringify({ waitingSession, session })}`);
  }
  if (runDetail.run.status !== 'waiting_human') throw new Error(`Expected waiting_human: ${runDetail.run.status}`);
  if (runDetail.run.pendingAgentSubstitution?.confirmationId !== confirmation.metadata.payload.confirmationId) {
    throw new Error('Workflow run did not persist the active substitution confirmation.');
  }
  if (nodeRun?.status !== 'waiting' || task?.status !== 'blocked') {
    throw new Error(`Expected parked NodeRun/Task: ${JSON.stringify({ nodeRun, task })}`);
  }
  return {
    sessionId,
    runId: selected.workflowRun.id,
    taskId,
    confirmationId: confirmation.metadata.payload.confirmationId,
    candidateAgentId: confirmation.metadata.payload.candidateAgentIds?.[0],
    initialInvocationCount: (await api(apiBase, `/sessions/${sessionId}/debug/runtime-invocations`)).data.items.length
  };
}

async function assertNoImplicitResume(apiBase, fixture) {
  await api(apiBase, `/sessions/${fixture.sessionId}/resume`, {
    method: 'POST',
    body: JSON.stringify({ reason: '继续执行' })
  });
  await new Promise((resolve) => setTimeout(resolve, 750));
  const invocations = (await api(apiBase, `/sessions/${fixture.sessionId}/debug/runtime-invocations`)).data.items;
  if (invocations.length !== fixture.initialInvocationCount) {
    throw new Error(`Ordinary resume started a new Runtime invocation: ${JSON.stringify(invocations)}`);
  }
}

try {
  server = await startSmokeServer('workflow-agent-substitution-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    PROJECT_POLICY_RUNTIME_TYPE: '',
    REQUIRE_USER_CONFIRMATION: 'false',
    MOCK_REJECT_ACCEPTANCE_AGENT_KEYS: 'requirements'
  });

  const reassignment = await createRejectedWorkflow(server.apiBase, 'Workflow substitution reassignment');
  await assertNoImplicitResume(server.apiBase, reassignment);
  if (!reassignment.candidateAgentId) throw new Error('Substitution confirmation did not expose a candidate Agent.');
  await api(server.apiBase, `/sessions/${reassignment.sessionId}/workflow/agent-substitution`, {
    method: 'POST',
    body: JSON.stringify({
      confirmationId: reassignment.confirmationId,
      taskId: reassignment.taskId,
      agentId: reassignment.candidateAgentId
    })
  });
  await waitForStatus(server.apiBase, reassignment.sessionId, 'COMPLETED', 30_000);
  const reassignedTask = (await api(server.apiBase, `/sessions/${reassignment.sessionId}/tasks`)).data
    .find((item) => item.id === reassignment.taskId);
  if (reassignedTask?.assignee?.id !== reassignment.candidateAgentId) {
    throw new Error(`Explicit substitution did not retain the selected Agent: ${JSON.stringify(reassignedTask)}`);
  }

  const skipped = await createRejectedWorkflow(server.apiBase, 'Workflow substitution skip');
  await api(server.apiBase, `/sessions/${skipped.sessionId}/workflow/agent-skip`, {
    method: 'POST',
    body: JSON.stringify({
      confirmationId: skipped.confirmationId,
      taskId: skipped.taskId,
      reason: '跳过当前 Agent，继续执行'
    })
  });
  await waitForStatus(server.apiBase, skipped.sessionId, 'COMPLETED', 30_000);
  const skippedRun = (await api(server.apiBase, `/workflow-runs/${skipped.runId}`)).data;
  const skippedTask = (await api(server.apiBase, `/sessions/${skipped.sessionId}/tasks`)).data
    .find((item) => item.id === skipped.taskId);
  const skippedNodeRun = skippedRun.nodeRuns.find((item) => item.relatedTaskId === skipped.taskId);
  if (skippedRun.run.status !== 'completed' || skippedNodeRun?.status !== 'skipped' || skippedTask?.status !== 'cancelled') {
    throw new Error(`Skip did not advance the workflow: ${JSON.stringify({ skippedRun, skippedTask, skippedNodeRun })}`);
  }

  const cancelled = await createRejectedWorkflow(server.apiBase, 'Workflow substitution cancel');
  await api(server.apiBase, `/sessions/${cancelled.sessionId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ confirmationId: cancelled.confirmationId, reason: '取消当前工作流' })
  });
  await waitForStatus(server.apiBase, cancelled.sessionId, 'CANCELLED', 10_000);
  const cancelledRun = (await api(server.apiBase, `/workflow-runs/${cancelled.runId}`)).data;
  if (cancelledRun.run.status !== 'cancelled') {
    throw new Error(`Cancel did not terminate the workflow run: ${JSON.stringify(cancelledRun.run)}`);
  }

  console.log('workflow-agent-substitution smoke passed: parked state, fail-closed resume, reassign, skip and cancel');
} finally {
  if (server) await stopSmokeServer(server);
  rmSync(workspacePath, { recursive: true, force: true });
}
