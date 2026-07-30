import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForEvent,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let firstServer;
let secondServer;
let thirdServer;
let fourthServer;

try {
  firstServer = await startSmokeServer('recovery-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_RUNTIME_DELAY_MS: '1500',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });

  const agents = (await api(firstServer.apiBase, '/agents')).data;
  const taskAgent = agents.find((agent) => agent.key === 'requirements') ?? agents[0];
  if (!taskAgent) throw new Error('Recovery smoke requires at least one Agent.');
  const workflowDraft = (await api(firstServer.apiBase, '/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Recovery smoke workflow',
      nodes: [{ id: 'recovery-smoke-node', type: 'agent', agentId: taskAgent.id, order: 0 }]
    })
  })).data;
  const workflow = (await api(firstServer.apiBase, `/workflows/${workflowDraft.id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: workflowDraft.draftRevision })
  })).data;

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    firstServer.apiBase,
    '验证服务崩溃后任务只进入可唤醒中断状态',
    { runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] } }
  );
  await api(firstServer.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(firstServer.apiBase, sessionId, 'WAIT_WORKFLOW_SELECT');
  const workflowSelection = await waitForMatchingEvent(
    firstServer.apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload.reason === 'select_workflow'
  );
  await api(firstServer.apiBase, `/sessions/${sessionId}/workflow/select`, {
    method: 'POST',
    body: JSON.stringify({
      workflowId: workflow.id,
      confirmationId: workflowSelection.metadata.payload.confirmationId
    })
  });
  await waitForEvent(firstServer.apiBase, sessionId, 'task_started');
  await new Promise((resolve) => setTimeout(resolve, 400));
  firstServer.server.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 500));

  secondServer = await startSmokeServer('recovery-smoke-restart', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    AGENT_CLUSTER_DATA_FILE: firstServer.dataFile
  });

  const interrupted = await waitForStatus(secondServer.apiBase, sessionId, 'INTERRUPTED', 60_000);
  if (interrupted.interruption?.reason !== 'service_shutdown' || interrupted.interruption?.wakeable !== true) {
    throw new Error(`Expected a wakeable service_shutdown interruption, got ${JSON.stringify(interrupted.interruption)}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const stillInterrupted = (await api(secondServer.apiBase, `/sessions/${sessionId}`)).data;
  if (stillInterrupted.status !== 'INTERRUPTED') {
    throw new Error(`Backend restart automatically advanced the Session to ${stillInterrupted.status}`);
  }

  const events = await listEvents(secondServer.apiBase, sessionId);
  const shutdownEvent = events.find(
    (event) =>
      event.type === 'runtime_failed' &&
      event.metadata?.payload?.termination?.kind === 'service_shutdown' &&
      event.metadata.payload.termination.graceful === false
  );
  if (!shutdownEvent) {
    throw new Error('Expected crash reconciliation to record service_shutdown with graceful=false');
  }
  if (events.some((event) => event.type === 'final_delivery_created')) {
    throw new Error('Restarted backend must not create a delivery without a future user wake-up');
  }

  const tasks = (await api(secondServer.apiBase, `/sessions/${sessionId}/tasks`)).data;
  if (tasks.some((task) => task.status !== 'waiting')) {
    throw new Error(`Expected interrupted tasks to wait, got ${tasks.map((task) => `${task.id}:${task.status}`).join(', ')}`);
  }

  console.log('recovery smoke passed: crashed execution became wakeable and did not auto-run');

  thirdServer = await startSmokeServer('recovery-smoke-discussing', {
    DISCUSSION_MAX_ROUNDS: '1',
    MOCK_RUNTIME_DELAY_MS: '1500',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });
  const createdDiscussing = await api(thirdServer.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: '验证讨论阶段崩溃后不会自动重新生成任务契约',
      agentIds: ['coordinator', 'requirements', 'architect', 'backend', 'test', 'review', 'notification'],
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    })
  });
  const discussingSessionId = createdDiscussing.data.session.id;

  await new Promise((resolve) => setTimeout(resolve, 800));
  const beforeCrash = (await api(thirdServer.apiBase, `/sessions/${discussingSessionId}`)).data;
  if (beforeCrash.status !== 'AGENT_DISCUSSING') {
    throw new Error(`Expected AGENT_DISCUSSING before crash, got ${beforeCrash.status}`);
  }
  thirdServer.server.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 500));

  fourthServer = await startSmokeServer('recovery-smoke-discussing-restart', {
    DISCUSSION_MAX_ROUNDS: '0',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock',
    AGENT_CLUSTER_DATA_FILE: thirdServer.dataFile
  });

  const interruptedDiscussion = await waitForStatus(
    fourthServer.apiBase,
    discussingSessionId,
    'INTERRUPTED',
    60_000
  );
  if (interruptedDiscussion.interruption?.reason !== 'service_shutdown') {
    throw new Error(`Expected discussion service_shutdown, got ${JSON.stringify(interruptedDiscussion.interruption)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const discussionEvents = await listEvents(fourthServer.apiBase, discussingSessionId);
  if (discussionEvents.some((event) => event.metadata?.payload?.reason === 'brief_generation_recovered_on_boot')) {
    throw new Error('Discussion was automatically re-driven after restart');
  }

  console.log('recovery smoke passed: crashed discussion became wakeable and did not auto-run');
} finally {
  if (secondServer) await stopSmokeServer(secondServer);
  if (firstServer) await stopSmokeServer(firstServer);
  if (fourthServer) await stopSmokeServer(fourthServer);
  if (thirdServer) await stopSmokeServer(thirdServer);
}

process.exit(0);
