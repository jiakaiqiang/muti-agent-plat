import {
  api,
  buildServer,
  listEvents,
  startSmokeServer,
  stopSmokeServer,
  waitForStatus
} from './smoke-server.mjs';

async function waitForBriefCount(apiBase, sessionId, count, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const briefs = await api(apiBase, `/sessions/${sessionId}/briefs`);
    if (briefs.data.length >= count) {
      return briefs.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${count} briefs`);
}

await buildServer();

let server;

try {
  server = await startSmokeServer('requirement-revision-loop-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

  const created = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Build a workflow that requires user confirmation before task assignment.',
      agentIds: ['coordinator', 'requirements', 'backend', 'test', 'review', 'notification']
    })
  });
  const sessionId = created.data.session.id;

  const [firstBrief] = await waitForBriefCount(server.apiBase, sessionId, 1);
  await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_CONFIRM');

  await api(server.apiBase, `/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: 'Supplement: every agent must decide whether this update is relevant before the tasks are assigned.'
    })
  });

  const briefs = await waitForBriefCount(server.apiBase, sessionId, 2);
  const secondBrief = briefs.at(-1);
  await waitForStatus(server.apiBase, sessionId, 'WAIT_USER_CONFIRM');

  let staleRejected = false;
  try {
    await api(server.apiBase, `/sessions/${sessionId}/briefs/${firstBrief.id}/confirm`, { method: 'POST' });
  } catch (error) {
    staleRejected = String(error.message).includes('400');
  }
  if (!staleRejected) {
    throw new Error('Stale brief confirmation should be rejected');
  }

  await api(server.apiBase, `/sessions/${sessionId}/briefs/${secondBrief.id}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, sessionId, 'COMPLETED', 30_000);

  const events = await listEvents(server.apiBase, sessionId);
  const agentContextEvents = events.filter(
    (event) =>
      event.type === 'agent_status_changed' &&
      event.metadata.payload?.thoughtSummary === '已将相关需求更新加入 Agent 上下文。'
  );
  if (!agentContextEvents.length) {
    throw new Error('Expected at least one agent to add the supplement to its session context');
  }
  if (!events.some((event) => event.type === 'final_delivery_created')) {
    throw new Error('Expected final delivery marker before session completion');
  }

  console.log('requirement revision loop smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
