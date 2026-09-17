import {
  api,
  buildServer,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('session-delete-smoke', {
    DISCUSSION_MAX_ROUNDS: '0',
    MOCK_RUNTIME_DELAY_MS: '300',
    GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock'
  });

  const createSession = (input) => api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input,
      agentIds: ['requirements', 'backend', 'test', 'review'],
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    })
  });
  const first = await createSession('Create a recoverable Session while another Session keeps running.');
  const second = await createSession('Keep this sibling Session isolated from the first deletion.');
  const sessionId = first.data.session.id;
  const siblingId = second.data.session.id;
  await Promise.all([
    waitForEvent(server.apiBase, sessionId, 'user_message'),
    waitForEvent(server.apiBase, siblingId, 'user_message')
  ]);

  const before = await api(server.apiBase, '/sessions');
  if (![sessionId, siblingId].every((id) => before.data.items.some((session) => session.id === id))) {
    throw new Error('Expected both Sessions in the active list before deletion');
  }

  const deleteRequestId = `delete-smoke-${Date.now()}`;
  const deleted = await api(server.apiBase, `/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: { 'Idempotency-Key': deleteRequestId }
  });
  if (!deleted.data.deleted || deleted.data.sessionId !== sessionId) {
    throw new Error(`Unexpected delete response: ${JSON.stringify(deleted.data)}`);
  }
  if (deleted.data.lifecycle?.deleteRequestId !== deleteRequestId || deleted.data.lifecycle?.state !== 'deleted') {
    throw new Error(`Deletion did not persist its lifecycle request: ${JSON.stringify(deleted.data.lifecycle)}`);
  }

  const after = await api(server.apiBase, '/sessions');
  if (after.data.items.some((session) => session.id === sessionId)) {
    throw new Error('Deleted Session should be hidden from the active list');
  }
  if (!after.data.items.some((session) => session.id === siblingId)) {
    throw new Error('Deleting one Session removed its sibling');
  }

  const tombstones = await api(server.apiBase, '/sessions?visibility=deleted');
  if (!tombstones.data.items.some((session) =>
    session.id === sessionId && session.lifecycleState === 'deleted'
  )) {
    throw new Error('Deleted Session is missing from the recoverable tombstone list');
  }
  const retainedDetail = await api(server.apiBase, `/sessions/${sessionId}`);
  if (retainedDetail.data.id !== sessionId || retainedDetail.data.status !== 'PAUSED') {
    throw new Error(`Deleted Session history was not retained: ${JSON.stringify(retainedDetail.data)}`);
  }
  const runtimeStartsBeforeRestore = (await listEvents(server.apiBase, sessionId))
    .filter((event) => event.type === 'runtime_started').length;

  const restored = await api(server.apiBase, `/sessions/${sessionId}/restore`, {
    method: 'POST',
    body: JSON.stringify({
      requestId: `restore-smoke-${Date.now()}`,
      expectedGeneration: deleted.data.lifecycle.generation
    })
  });
  if (!restored.data.restored || restored.data.session.status !== 'PAUSED' ||
    restored.data.lifecycle.state !== 'active' || restored.data.lifecycle.admission !== 'closed') {
    throw new Error(`Unexpected restore response: ${JSON.stringify(restored.data)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const runtimeStartsAfterRestore = (await listEvents(server.apiBase, sessionId))
    .filter((event) => event.type === 'runtime_started').length;
  if (runtimeStartsAfterRestore !== runtimeStartsBeforeRestore) {
    throw new Error('Restoring a Session started model work before explicit user continuation');
  }

  await api(server.apiBase, `/sessions/${sessionId}/resume`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Explicitly continue the restored Session.' })
  });
  await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_CONFIRM', 30_000);
  const reopened = await api(server.apiBase, `/sessions/${sessionId}/lifecycle`);
  if (reopened.data.lifecycle.generation !== deleted.data.lifecycle.generation + 1 ||
    reopened.data.lifecycle.admission !== 'open') {
    throw new Error(`Explicit continuation did not open the restored generation: ${JSON.stringify(reopened.data)}`);
  }

  const sibling = await api(server.apiBase, `/sessions/${siblingId}`);
  if (sibling.data.id !== siblingId || sibling.data.status === 'PAUSED') {
    throw new Error(`Sibling Session was changed by delete/restore: ${JSON.stringify(sibling.data)}`);
  }

  console.log('session delete smoke passed: tombstone restore and sibling isolation are preserved');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
