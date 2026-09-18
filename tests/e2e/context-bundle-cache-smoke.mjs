// Phase 2C / P2C-AC1: a context bundle cache hit must not bypass the pre-send
// budget guard.
//
// Part A proves hits happen in a real flow (a normal session completes with at
// least one hit on the ops metrics). Part B proves the guard survives a hit
// inside ONE session: a tiny-budget session is rejected on its first attempt
// (bundle built → miss), the user sends 继续 to retry, and the retry is served
// from the cache (hit) yet rejected again with TOKEN_BUDGET_EXCEEDED.
//
// Cache outcomes are read from GET /ops/workspace-metrics, which carries only
// layer/outcome labels. Parts run on separate servers so the deltas are exact.
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

const isBudgetError = (event) =>
  event.type === 'error_reported' &&
  (event.metadata?.payload?.code === 'TOKEN_BUDGET_EXCEEDED' ||
    event.metadata?.payload?.runtimeError?.code === 'TOKEN_BUDGET_EXCEEDED');

async function bundleCounts(apiBase) {
  const metrics = await api(apiBase, '/ops/workspace-metrics');
  const counts = { hit: 0, miss: 0, expired: 0, evicted: 0, rejected_backfill: 0 };
  for (const series of metrics.data.series) {
    if (series.name !== 'context_bundle_cache_total') continue;
    if (Object.keys(series.labels).some((label) => label !== 'layer' && label !== 'outcome')) {
      throw new Error(`context_bundle_cache_total must only carry layer/outcome labels: ${JSON.stringify(series.labels)}`);
    }
    counts[series.labels.outcome] = series.value;
  }
  return counts;
}

async function countBudgetErrors(apiBase, sessionId) {
  const events = (await api(apiBase, `/sessions/${sessionId}/events`)).data.items;
  return events.filter(isBudgetError).length;
}

await buildServer();

let normalServer;
let tinyServer;
try {
  // Part A: a normal flow produces real hits.
  normalServer = await startSmokeServer('context-bundle-cache-normal', { DISCUSSION_MAX_ROUNDS: '0' });
  const workflow = await createPublishedAgentWorkflow(normalServer.apiBase, 'Bundle cache workflow', ['product-manager']);
  const normal = await createSessionAndWaitForBrief(normalServer.apiBase, '分析并记录 token 使用情况，仅输出说明。', {
    tokenBudget: 50_000,
    runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
  });
  await confirmBriefAndSelectWorkflow(normalServer.apiBase, normal.sessionId, normal.briefId, workflow);
  await waitForStatus(normalServer.apiBase, normal.sessionId, 'COMPLETED');
  const normalCounts = await bundleCounts(normalServer.apiBase);
  if (normalCounts.hit < 1) {
    throw new Error(`Expected at least one context bundle cache hit in a completed session: ${JSON.stringify(normalCounts)}`);
  }
  if (normalCounts.rejected_backfill !== 0) {
    throw new Error(`A normal flow must not produce rejected backfills: ${JSON.stringify(normalCounts)}`);
  }

  // Part B: inside one session, a cached bundle is still refused by the guard.
  tinyServer = await startSmokeServer('context-bundle-cache-tiny', { DISCUSSION_MAX_ROUNDS: '0' });
  const baseline = await bundleCounts(tinyServer.apiBase);
  const tiny = await api(tinyServer.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Tiny token budget should fail preflight.',
      tokenBudget: 10,
      runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
    })
  });
  const tinySessionId = tiny.data.session.id;
  await waitForMatchingEvent(tinyServer.apiBase, tinySessionId, 'error_reported', isBudgetError, 60_000);
  const afterFirst = await bundleCounts(tinyServer.apiBase);
  if (afterFirst.miss - baseline.miss < 1) {
    throw new Error(`The first attempt must build the bundle (miss) before being refused: ${JSON.stringify({ baseline, afterFirst })}`);
  }
  if (afterFirst.hit !== baseline.hit) {
    throw new Error(`The first attempt must not hit: ${JSON.stringify({ baseline, afterFirst })}`);
  }

  await waitForMatchingEvent(
    tinyServer.apiBase,
    tinySessionId,
    'user_confirmation_requested',
    (event) => event.metadata?.payload?.reason === 'retry_failed_execution',
    30_000
  );
  await api(tinyServer.apiBase, `/sessions/${tinySessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '继续' })
  });

  const deadline = Date.now() + 60_000;
  let budgetErrors = 0;
  while (Date.now() < deadline) {
    budgetErrors = await countBudgetErrors(tinyServer.apiBase, tinySessionId);
    if (budgetErrors >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (budgetErrors < 2) {
    throw new Error(`Expected the retry to be refused again by the budget guard, saw ${budgetErrors} refusal(s)`);
  }
  const afterRetry = await bundleCounts(tinyServer.apiBase);
  if (afterRetry.hit - afterFirst.hit < 1) {
    throw new Error(`Expected the retry to be served from the bundle cache: ${JSON.stringify({ afterFirst, afterRetry })}`);
  }

  console.log(
    `context bundle cache smoke ok: normal flow hits=${normalCounts.hit}; tiny session retry hit the cache and was still refused (${budgetErrors} refusals)`
  );
} finally {
  if (tinyServer) await stopSmokeServer(tinyServer);
  if (normalServer) await stopSmokeServer(normalServer);
}
