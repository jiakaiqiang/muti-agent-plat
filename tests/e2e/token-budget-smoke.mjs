import {
  api,
  buildServer,
  confirmBriefAndSelectWorkflow,
  createPublishedAgentWorkflow,
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

  const workflow = await createPublishedAgentWorkflow(server.apiBase, 'Token budget workflow', ['product-manager']);

  const normal = await createSessionAndWaitForBrief(server.apiBase, '分析并记录 token 使用情况，仅输出说明。', {
    tokenBudget: 50_000,
    runtimePreference: {
      preferredRuntimeType: 'mock',
      allowedRuntimeTypes: ['mock']
    }
  });
  await confirmBriefAndSelectWorkflow(server.apiBase, normal.sessionId, normal.briefId, workflow);
  await waitForStatus(server.apiBase, normal.sessionId, 'COMPLETED');
  const tokenUsage = await api(server.apiBase, `/sessions/${normal.sessionId}/debug/token-usage`);
  if (tokenUsage.data.invocationCount < 1 || tokenUsage.data.tokenUsed < 1 || tokenUsage.data.totalTokens < 1) {
    throw new Error(`Expected nonzero token usage: ${JSON.stringify(tokenUsage)}`);
  }

  const tiny = await api(server.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Tiny token budget should fail preflight.',
      tokenBudget: 10,
      runtimePreference: {
        preferredRuntimeType: 'mock',
        allowedRuntimeTypes: ['mock']
      }
    })
  });
  const tinySessionId = tiny.data.session.id;
  await waitForMatchingEvent(
    server.apiBase,
    tinySessionId,
    'error_reported',
    (event) =>
      event.metadata.payload.code === 'TOKEN_BUDGET_EXCEEDED' ||
      event.metadata.payload.runtimeError?.code === 'TOKEN_BUDGET_EXCEEDED',
    60_000
  );
  const tinyEvents = await api(server.apiBase, `/sessions/${tinySessionId}/events`);
  const budgetError = tinyEvents.data.items.find(
    (event) =>
      event.type === 'error_reported' && event.metadata.payload?.runtimeError?.code === 'TOKEN_BUDGET_EXCEEDED'
  );
  const budgetDetails = budgetError?.metadata?.payload?.runtimeError?.details;
  if (!(budgetDetails?.estimatedTokens > budgetDetails?.maxInputTokens)) {
    throw new Error(`Expected structured token budget details on failure: ${JSON.stringify(budgetError)}`);
  }

  console.log('token budget smoke ok');
} finally {
  if (server) {
    await stopSmokeServer(server);
  }
}
