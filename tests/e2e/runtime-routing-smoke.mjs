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

try {
  server = await startSmokeServer('runtime-routing-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

  await api(server.apiBase, '/agents/backend', {
    method: 'PATCH',
    body: JSON.stringify({ runtimeType: 'mcp_tool' })
  });

  const { sessionId, briefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Runtime routing smoke should fail unsupported runtime visibly.'
  );
  await api(server.apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_DECISION');

  const runtimeFailed = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'runtime_failed',
    (event) => event.metadata.payload.code === 'CAPABILITY_BLOCKED'
  );
  if (!String(runtimeFailed.metadata.payload.message).includes('runtime not implemented')) {
    throw new Error(`Unsupported runtime failure should mention not implemented: ${JSON.stringify(runtimeFailed)}`);
  }

  const events = await listEvents(server.apiBase, sessionId);
  if (
    events.some(
      (event) =>
        event.type === 'runtime_completed' &&
        event.taskId === runtimeFailed.taskId &&
        String(event.metadata.payload.runtimeType) === 'mock'
    )
  ) {
    throw new Error('Unsupported runtime must not silently fall back to mock execution');
  }

  console.log('runtime routing smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
