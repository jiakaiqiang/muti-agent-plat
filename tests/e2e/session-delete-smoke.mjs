import { api, buildServer, startSmokeServer, stopSmokeServer, waitForEvent } from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('session-delete-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Create a temporary session that will be deleted.',
      agentIds: ['coordinator', 'backend', 'test', 'review']
    })
  });
  const sessionId = created.data.session.id;
  await waitForEvent(server.apiBase, sessionId, 'user_message');

  const before = await api(server.apiBase, '/sessions');
  if (!before.data.items.some((session) => session.id === sessionId)) {
    throw new Error('Expected created session in list before deletion');
  }

  const deleted = await api(server.apiBase, `/sessions/${sessionId}`, { method: 'DELETE' });
  if (!deleted.data.deleted || deleted.data.sessionId !== sessionId) {
    throw new Error(`Unexpected delete response: ${JSON.stringify(deleted.data)}`);
  }

  const after = await api(server.apiBase, '/sessions');
  if (after.data.items.some((session) => session.id === sessionId)) {
    throw new Error('Deleted session should not remain in list');
  }

  let detailRejected = false;
  try {
    await api(server.apiBase, `/sessions/${sessionId}`);
  } catch (error) {
    detailRejected = String(error.message).includes('404');
  }
  if (!detailRejected) {
    throw new Error('Deleted session detail should return 404');
  }

  console.log('session delete smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
