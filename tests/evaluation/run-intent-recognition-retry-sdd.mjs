import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const out = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const fixture = await mkdtemp(join(tmpdir(), 'intent-recognition-http-'));
const message = '为天气查询建立任务'; let fail = true, modelCalls = 0, server, sessionId;
const results = [];
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), prompt = JSON.stringify(input.messages); modelCalls++;
    assert.ok(prompt.includes('Return only intent_understanding@1.0'));
    if (fail) { response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'fixture unauthorized' } })); return; }
    const sourceEventId = prompt.match(/Current source event ID: ([^\s"\\]+)/)?.[1]; assert.ok(sourceEventId);
    const content = { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
      segments: [{ localKey: 'initial', dialogueAct: 'command', goal: message, scopeRelation: 'initial_requirement', suggestedAction: 'create_initial_work_item',
        target: { workItemId: null, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
        correction: null, contextPolicy: 'clean_task_context', requestedEffects: [], prohibitions: [],
        evidence: [{ refId: 'request', sourceEventId, start: 0, end: message.length, quote: message }], dependencies: [] }],
      missingFields: [], ambiguityReasons: [], modelConfidence: null };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
  } catch (error) { console.error(error); response.writeHead(500).end(); }
});
const port = await findFreePort(); await new Promise(done => provider.listen(port, '127.0.0.1', done));
const environment = { GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm', INTENT_UNDERSTANDING_ENABLED: 'true', INTENT_ROUTING_MODE: 'enforce_all_current_epoch',
  AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED: 'false', ENABLE_BULLMQ: 'false', LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'recognition-retry-fixture',
  LLM_API_KEY: 'fixture-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false', LLM_REMOTE_STREAMING: 'false' };
const state = () => readFile(server.dataFile, 'utf8').then(JSON.parse);
async function until(predicate) { const deadline = Date.now() + 30_000; let value;
  do { value = await state(); if (predicate(value)) return value; await new Promise(done => setTimeout(done, 80)); } while (Date.now() < deadline);
  throw new Error(JSON.stringify({ routes: value.intentRoutingRecordsBySession, modelCalls })); }
async function post(path, body) { const response = await fetch(`${server.apiBase}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() }; }
async function check(id, condition, actual) { results.push({ id, passed: Boolean(condition), actual }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); }
try {
  server = await startSmokeServer('intent-recognition-retry', environment);
  for (const role of ['intent_router', 'coordinator']) await api(server.apiBase, `/system-agent-runtime-policies/${role}`,
    { method: 'PATCH', body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const created = (await api(server.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({ input: message }) })).data;
  sessionId = created.session.id;
  const routeIn = value => value.intentRoutingRecordsBySession?.[sessionId]?.[0];
  const first = await until(value => routeIn(value)?.status === 'BLOCKED' && value.eventsBySession[sessionId].some(row => row.metadata?.payload?.recognitionRetry));
  const original = routeIn(first), path = `/sessions/${sessionId}/message-routings/${original.id}/retry-recognition`;
  const input = (route, key) => ({ contractVersion: 'intent-recognition-retry-v1', dataEpoch: created.session.dataEpoch,
    expectedRoutingRevision: route.routingRevision, idempotencyKey: key });
  await check('RR01', modelCalls === 1 && original.failureClass === 'auth' && original.classificationAttempts === 1 && !first.workItemsBySession?.[sessionId]?.length,
    { failure: original.failureClass, modelCalls, noAutomaticAuthRetryOrTask: true });
  const request = input(original, 'still-broken');
  await check('RR02', (await post(path, { ...request, attempts: 999 })).status === 400 &&
    (await post(path, { ...request, dataEpoch: 'old' })).status === 409 && (await post(path, { ...request, expectedRoutingRevision: 999 })).status === 409,
    { injectedBudgetAndStaleIdentitiesRejected: true });
  const repeatedFailure = await post(path, request); assert.equal(repeatedFailure.status, 202);
  const failedAgain = await until(value => routeIn(value)?.status === 'BLOCKED' && routeIn(value).recognitionRetryReceipts?.length === 1 &&
    value.eventsBySession[sessionId].filter(row => row.metadata?.payload?.recognitionRetry).length === 2);
  await check('RR03', modelCalls === 1 && routeIn(failedAgain).blockedReason === 'INTENT_PROVIDER_CIRCUIT_OPEN' && routeIn(failedAgain).classificationAttempts === 1 &&
    routeIn(failedAgain).recognitionRetryReceipts[0].previous.classificationAttempts === 1,
    { explicitRetryGetsSeparateBoundedOperation: true, providerCircuitStillBlocksNetwork: true, modelCalls,
      blockedReason: routeIn(failedAgain).blockedReason, failureClass: routeIn(failedAgain).failureClass });
  fail = false;
  // Respect the real provider circuit rather than resetting it or bypassing its admission guard.
  const lastLog = failedAgain.runtimeInvocationsBySession[sessionId].at(-1);
  const delay = Number(lastLog.error?.details?.retryAfterMs ?? 120000);
  console.log(JSON.stringify({ waitingForProviderCircuitMs: delay + 1000 }));
  await new Promise(done => setTimeout(done, delay + 1000));
  const repairedRequest = input(routeIn(failedAgain), 'repaired');
  const replies = await Promise.all([post(path, repairedRequest), post(path, repairedRequest)]);
  await check('RR04', replies.every(row => row.status === 202) && replies.filter(row => row.body.data.idempotentReplay).length === 1,
    { oneAcceptanceAndOneReplay: true });
  const finished = await until(value => routeIn(value)?.status === 'ROUTED');
  const current = routeIn(finished), operations = finished.logicalOperationsBySession[sessionId].filter(row => row.phase === 'user_message_routing');
  await check('RR05', modelCalls === 2 && operations.length === 3 && operations.every(row => row.attemptsUsed === 1) &&
    new Set(operations.map(row => row.id)).size === 3 && current.recognitionRetryReceipts.length === 2 &&
    finished.workItemsBySession[sessionId].length === 1 && !finished.briefsBySession?.[sessionId],
    { modelCalls, operations: operations.map(row => ({ id: row.id, attemptsUsed: row.attemptsUsed, maxAttempts: row.maxAttempts, deadlineAt: row.deadlineAt })), oneTaskNoBrief: true });
  await check('RR06', finished.eventsBySession[sessionId].filter(row => row.type === 'user_message').length === 1 &&
    current.sourceEventId === original.sourceEventId && current.recognitionRetryReceipts[1].previousOperationId === current.recognitionRetryReceipts[0].operationId &&
    current.recognitionRetryReceipts[0].previous.classificationDeadlineAt === original.classificationDeadlineAt,
    { originalMessageAndBudgetsPreserved: true, linkedHistory: true });
  const restart = join(fixture, 'restart.json'); await writeFile(restart, JSON.stringify(finished)); await stopSmokeServer(server); server = undefined;
  server = await startSmokeServer('intent-recognition-retry-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: restart }); server.dataFile = restart;
  const replay = await post(path, repairedRequest), oldReplay = await post(path, request);
  await check('RR07', replay.status === 202 && replay.body.data.idempotentReplay && oldReplay.status === 202 &&
    routeIn(await state()).recognitionOperationId === current.recognitionOperationId && modelCalls === 2 &&
    (await post(path, input(current, 'new-after-success'))).status === 409,
    { realRestart: true, bothReceiptsReplayWithoutAnotherModelOrRestoringOldOperation: true });
} finally {
  await writeFile(resolve(out, 'recognition-retry-http-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'real Nest HTTP, actual Generic LLM adapter with deterministic local provider, File persistence and process restart; no model accuracy claim', results }, null, 2));
  if (server) await stopSmokeServer(server); provider.closeAllConnections(); await new Promise(done => provider.close(done));
  const child = relative(resolve(tmpdir()), resolve(fixture)); assert.ok(child.startsWith('intent-recognition-http-') && !child.includes('..') && !isAbsolute(child));
  await rm(fixture, { recursive: true, force: true });
}
assert.equal(results.length, 7); assert.ok(results.every(row => row.passed));
