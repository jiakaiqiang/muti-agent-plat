import {
  api,
  buildServer,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('memory-confirm-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

  const marker = `MEMORY_CONFIRM_MARKER_${Date.now()}`;
  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Memory confirmation smoke session.',
      agentIds: ['coordinator', 'backend', 'test', 'review']
    })
  });
  const sessionId = created.data.session.id;

  await api(server.apiBase, `/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: `请记住：以后偏好标记为 ${marker}。` })
  });

  const before = await api(server.apiBase, `/sessions/${sessionId}/memories?q=${encodeURIComponent(marker)}`);
  if (before.data.items.length !== 0) {
    throw new Error('Preference memory must wait for explicit confirmation');
  }

  const confirmation = await waitForMatchingEvent(
    server.apiBase,
    sessionId,
    'user_confirmation_requested',
    (event) => event.metadata.payload.reason === 'confirm_memory_write'
  );
  const candidate = confirmation.metadata.payload.candidate;
  const confirmed = await api(server.apiBase, `/sessions/${sessionId}/memories/confirm`, {
    method: 'POST',
    body: JSON.stringify({
      confirmationId: confirmation.metadata.payload.confirmationId,
      content: candidate.content,
      sourceEventId: candidate.sourceEventId,
      confidence: candidate.confidence
    })
  });

  const after = await api(server.apiBase, `/sessions/${sessionId}/memories?q=${encodeURIComponent(marker)}`);
  if (!after.data.items.some((memory) => memory.id === confirmed.data.memory.id)) {
    throw new Error('Confirmed preference memory should be written and searchable');
  }

  console.log('memory confirm smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
