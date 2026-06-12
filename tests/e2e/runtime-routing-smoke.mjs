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

  await api(server.apiBase, '/agents/backend', {
    method: 'PATCH',
    body: JSON.stringify({ runtimeType: 'claude_code' })
  });

  const { sessionId: claudeSessionId, briefId: claudeBriefId } = await createSessionAndWaitForBrief(
    server.apiBase,
    'Claude Code runtime must be explicitly enabled before it can edit server-local files.'
  );
  await api(server.apiBase, `/sessions/${claudeSessionId}/briefs/${claudeBriefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, claudeSessionId, 'WAIT_USER_DECISION');

  const claudeBlocked = await waitForMatchingEvent(
    server.apiBase,
    claudeSessionId,
    'runtime_failed',
    (event) =>
      event.metadata.payload.code === 'CAPABILITY_BLOCKED' &&
      String(event.metadata.payload.message).includes('CLAUDE_CODE_ENABLED=true')
  );
  if (!claudeBlocked) {
    throw new Error('Claude Code runtime must fail closed until explicitly enabled');
  }

  console.log('runtime routing smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
