import {
  api,
  buildServer,
  createSessionAndWaitForBrief,
  startSmokeServer,
  stopSmokeServer,
  waitForMatchingEvent,
  waitForStatus
} from './smoke-server.mjs';

await buildServer();

let server;

try {
  server = await startSmokeServer('token-budget-smoke', {
    DISCUSSION_MAX_ROUNDS: '0'
  });

  const normal = await createSessionAndWaitForBrief(server.apiBase, 'Token usage should be recorded for runtime calls.', {
    tokenBudget: 50_000
  });
  await api(server.apiBase, `/sessions/${normal.sessionId}/briefs/${normal.briefId}/confirm`, { method: 'POST' });
  await waitForStatus(server.apiBase, normal.sessionId, 'COMPLETED');
  const tokenUsage = await api(server.apiBase, `/sessions/${normal.sessionId}/debug/token-usage`);
  if (tokenUsage.data.invocationCount < 1 || tokenUsage.data.tokenUsed < 1 || tokenUsage.data.totalTokens < 1) {
    throw new Error(`Expected nonzero token usage: ${JSON.stringify(tokenUsage)}`);
  }

  const tiny = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Tiny token budget should fail preflight.',
      agentIds: ['coordinator', 'backend', 'test', 'review'],
      tokenBudget: 10
    })
  });
  const tinySessionId = tiny.data.session.id;
  await waitForMatchingEvent(
    server.apiBase,
    tinySessionId,
    'error_reported',
    (event) => event.metadata.payload.code === 'TOKEN_BUDGET_EXCEEDED'
  );

  console.log('token budget smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
