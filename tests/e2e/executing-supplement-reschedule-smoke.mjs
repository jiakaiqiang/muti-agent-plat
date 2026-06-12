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

let server;

try {
  server = await startSmokeServer('executing-supplement-reschedule-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_RUNTIME_DELAY_MS: '1800'
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Execute a delayed task so a supplemental requirement can be absorbed before completion.'
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });

  const firstTaskStarted = await waitForEvent(server.apiBase, sessionId, 'task_started', 20_000);
  const firstTaskId = firstTaskStarted.taskId;
  if (!firstTaskId) {
    throw new Error('Expected a running task before sending the supplemental requirement.');
  }

  await api(server.apiBase, `/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: 'While executing, add this supplemental constraint to the active backend task context.',
      mentionedAgentIds: ['backend']
    })
  });

  const rescheduled = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'session_status_changed',
    (event) => event.metadata.payload?.reason === 'executing_user_interrupt_rescheduled',
    20_000
  );
  const affectedTaskIds = rescheduled.metadata.payload?.affectedTaskIds ?? [];
  if (!affectedTaskIds.includes(firstTaskId)) {
    throw new Error('Reschedule event must reference the task that was active when the user supplemented the requirement.');
  }

  const cancelledRuntime = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'runtime_failed',
    (event) => event.taskId === firstTaskId && event.metadata.payload?.code === 'RUNTIME_CANCELLED',
    20_000
  );
  if (!cancelledRuntime) {
    throw new Error('Expected the in-flight runtime to be cancelled before rescheduling.');
  }

  await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'memory_used',
    (event) => event.taskId === firstTaskId,
    20_000
  );
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);

  const events = await listEvents(server.apiBase, sessionId);
  const startsForTask = events.filter((event) => event.type === 'task_started' && event.taskId === firstTaskId);
  if (startsForTask.length < 2) {
    throw new Error(`Expected active task to restart after supplement, got ${startsForTask.length} starts.`);
  }

  const routed = events.find(
    (event) => event.type === 'agent_message' && event.metadata.payload?.phase === 'user_message_routing'
  );
  if (!routed?.toAgentIds?.length) {
    throw new Error('Supplemental requirement must remain visible as an Agent routing message.');
  }

  console.log('executing supplement reschedule smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
