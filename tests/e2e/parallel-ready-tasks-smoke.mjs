import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;

async function waitForStartedTaskCount(apiBase, sessionId, count, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await listEvents(apiBase, sessionId);
    const started = events.filter((event) => event.type === 'task_started');
    if (started.length >= count) {
      return { events, started };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${count} task_started events.`);
}

try {
  server = await startSmokeServer('parallel-ready-tasks-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_PARALLEL_TASKS: 'true',
    MOCK_RUNTIME_DELAY_MS: '1600'
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Coordinate independent frontend and backend coding work in parallel.',
    {
      agentIds: ['coordinator', 'requirements', 'architect', 'frontend', 'backend', 'test', 'review', 'notification']
    }
  );

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  const { events, started } = await waitForStartedTaskCount(server.apiBase, sessionId, 2);

  const implementationStarts = started.filter((event) => {
    const title = String(event.metadata.payload?.title ?? '');
    return title.startsWith('Frontend implementation:') || title.startsWith('Backend implementation:');
  });
  if (implementationStarts.length < 2) {
    throw new Error('Expected frontend and backend implementation tasks to both start.');
  }

  const firstImplementationCompletionIndex = events.findIndex(
    (event) =>
      event.type === 'task_completed' &&
      implementationStarts.some((startedEvent) => startedEvent.taskId === event.taskId)
  );
  const secondImplementationStartIndex = events.findIndex((event) => event.id === implementationStarts[1].id);
  if (firstImplementationCompletionIndex !== -1 && firstImplementationCompletionIndex < secondImplementationStartIndex) {
    throw new Error('Ready implementation tasks must start in the same wave before either one completes.');
  }

  const claimedAgentIds = new Set(
    events
      .filter((event) => event.type === 'task_claimed' && implementationStarts.some((start) => start.taskId === event.taskId))
      .map((event) => event.fromAgentId)
  );
  if (claimedAgentIds.size < 2) {
    throw new Error('Parallel implementation tasks must be claimed by multiple Agents.');
  }

  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 90_000);

  console.log('parallel ready tasks smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
