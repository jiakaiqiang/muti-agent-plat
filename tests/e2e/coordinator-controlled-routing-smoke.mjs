import { basename, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  api,
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

async function assertNoSubAgentReassignment(apiBase, sessionId) {
  const events = await listEvents(apiBase, sessionId);
  const invalid = events.find(
    (event) =>
      event.type === 'task_reassigned' &&
      event.actor?.type === 'agent' &&
      event.metadata.payload?.assignedBy?.type === 'agent' &&
      event.actor.id !== event.metadata.payload.assignedBy.id
  );
  if (invalid) {
    throw new Error(`task_reassigned must be emitted by Coordinator only: ${JSON.stringify(invalid)}`);
  }
}

async function waitForMatchingEventWithDebug(apiBase, sessionId, type, predicate, timeoutMs = 20_000) {
  try {
    return await waitForMatchingEvent(apiBase, sessionId, type, predicate, timeoutMs);
  } catch (error) {
    const events = await listEvents(apiBase, sessionId);
    const summary = events
      .map((event) =>
        [
          event.type,
          event.taskId ?? '-',
          event.actor?.id ?? '-',
          event.metadata.payload?.phase ?? '-',
          event.metadata.payload?.status ?? '-',
          event.metadata.payload?.assignee?.id ?? '-',
          event.metadata.payload?.autoResolutionAttempted ?? '-',
          event.content
        ].join(' | ')
      )
      .join('\n');
    console.error(`Event summary before ${type} timeout:\n${summary}`);
    throw error;
  }
}

async function runWorkflowRejectionScenario() {
  let server;
  const workspacePath = mkdtempSync(join(tmpdir(), 'agent-cluster-coordinator-routing-'));
  writeFileSync(join(workspacePath, 'README.md'), 'coordinator routing smoke fixture\n');
  try {
    server = await startSmokeServer('coordinator-controlled-routing-rejection-smoke', {
      DISCUSSION_MAX_ROUNDS: '0',
      GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
      MOCK_PARALLEL_TASKS: 'true',
      MOCK_REJECT_ACCEPTANCE_AGENT_KEYS: 'requirements'
    });
    const workflow = await createPublishedAgentWorkflow(
      server.apiBase,
      'Coordinator controlled workflow rejection smoke',
      ['requirements']
    );

    const { sessionId, briefId } = await createSessionAndWaitForBrief(
      server.apiBase,
      '分析并记录前后端协作路由流程，仅输出说明，不修改代码。',
      {
        agentIds: ['requirements', 'architect', 'frontend', 'backend', 'test', 'review', 'notification'],
        workingDirectory: {
          kind: 'server_local',
          path: workspacePath,
          name: basename(workspacePath)
        },
        runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
      }
    );

    await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);

    const assigned = await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'task_assigned',
      (event) =>
        event.actor?.type === 'agent' &&
        event.metadata.payload?.assignedBy?.type === 'agent' &&
        event.actor.id === event.metadata.payload.assignedBy.id &&
        event.metadata.payload?.routingMode === 'coordinator_controlled',
      30_000
    );
    if (assigned.metadata.payload?.assignee?.type !== 'agent') {
      throw new Error('task_assigned must include an agent assignee ActorRef.');
    }

    const rejected = await waitForMatchingEventWithDebug(
      server.apiBase,
      sessionId,
      'task_rejected',
      (event) => event.actor?.type === 'agent',
      30_000
    );

    const confirmation = await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'user_confirmation_requested',
      (event) =>
        event.metadata.payload?.reason === 'workflow_agent_substitution' &&
        event.metadata.payload?.relatedTaskId === rejected.taskId,
      30_000
    );
    if (!confirmation.metadata.payload?.candidateAgentIds?.length) {
      throw new Error('Workflow rejection must expose explicit substitution candidates.');
    }

    const task = (await api(server.apiBase, `/sessions/${sessionId}/tasks`)).data
      .find((item) => item.id === rejected.taskId);
    if (task?.status !== 'blocked') throw new Error(`Rejected workflow task must park as blocked: ${JSON.stringify(task)}`);

    await assertNoSubAgentReassignment(server.apiBase, sessionId);
  } finally {
    if (server) {
      await stopSmokeServer(server);
    }
    rmSync(workspacePath, { recursive: true, force: true });
  }
}

async function runAllCandidatesRejectedScenario() {
  let server;
  const workspacePath = mkdtempSync(join(tmpdir(), 'agent-cluster-coordinator-routing-'));
  writeFileSync(join(workspacePath, 'README.md'), 'coordinator routing smoke fixture\n');
  try {
    server = await startSmokeServer('coordinator-controlled-routing-all-rejected-smoke', {
      DISCUSSION_MAX_ROUNDS: '0',
      GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
      MOCK_REJECT_ACCEPTANCE_AGENT_KEYS: 'coordinator,requirements,architect,frontend,backend,test,review,notification'
    });
    const workflow = await createPublishedAgentWorkflow(
      server.apiBase,
      'Coordinator controlled user decision smoke',
      ['requirements']
    );

    const { sessionId, briefId } = await createSessionAndWaitForBrief(
      server.apiBase,
      '分析并记录后端接口协作方案，让每个可用 Agent 拒绝接收任务；仅输出说明，不修改代码。',
      {
        agentIds: ['requirements', 'architect', 'frontend', 'backend', 'test', 'review', 'notification'],
        workingDirectory: {
          kind: 'server_local',
          path: workspacePath,
          name: basename(workspacePath)
        },
        runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
      }
    );

    await confirmBriefAndSelectWorkflow(server.apiBase, sessionId, briefId, workflow);

    const rejected = await waitForMatchingEventWithDebug(
      server.apiBase,
      sessionId,
      'task_rejected',
      (event) => event.actor?.type === 'agent',
      30_000
    );

    await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_DECISION', 60_000);

    await waitForMatchingEvent(
      server.apiBase,
      sessionId,
      'user_confirmation_requested',
      (event) =>
        event.metadata.payload?.reason === 'workflow_agent_substitution' &&
        event.metadata.payload?.relatedTaskId === rejected.taskId,
      30_000
    );

    const rejectedEvents = (await listEvents(server.apiBase, sessionId)).filter((event) => event.type === 'task_rejected');
    if (rejectedEvents.length < 1) {
      throw new Error('Expected at least one task_rejected event before user decision.');
    }

    await assertNoSubAgentReassignment(server.apiBase, sessionId);
  } finally {
    if (server) {
      await stopSmokeServer(server);
    }
    rmSync(workspacePath, { recursive: true, force: true });
  }
}

await runWorkflowRejectionScenario();
await runAllCandidatesRejectedScenario();

console.log('coordinator controlled routing smoke ok');
