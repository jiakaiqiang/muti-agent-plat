import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const message = '先解释登录失败的原因，再评审修改建议。不要修改源码。';
let server, count = 2, calls = 0;
const results = [], sessions = [];
const check = (id, condition, actual) => { results.push({ id, passed: Boolean(condition), actual }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); };
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return response.writeHead(404).end();
    let raw = ''; for await (const chunk of request) raw += chunk;
    const prompt = JSON.stringify(JSON.parse(raw).messages); calls++;
    assert.ok(prompt.includes('Return only intent_understanding@1.0'));
    const sourceEventId = prompt.match(/Current source event ID: ([^\s"\\]+)/)?.[1]; assert.ok(sourceEventId);
    const output = { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
      segments: Array.from({ length: count }, (_, index) => ({ localKey: `part-${index}`, dialogueAct: 'question', goal: `待澄清目标 ${index + 1}`,
        scopeRelation: 'session_context', suggestedAction: 'answer_in_chat', contextPolicy: 'clean_task_context',
        target: { workItemId: null, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
        correction: null, requestedEffects: [{ kind: 'answer', target: { kind: 'unresolved', refId: null }, evidenceRefs: ['request'] }],
        prohibitions: [], evidence: [{ refId: 'request', sourceEventId, start: 0, end: message.length, quote: message }],
        dependencies: index ? [{ segmentKey: `part-${index - 1}`, condition: 'execution_completed' }] : [] })),
      missingFields: [], ambiguityReasons: [], modelConfidence: null };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
  } catch (error) { console.error(error); response.writeHead(500).end(); }
});
const port = await findFreePort(); await new Promise(done => provider.listen(port, '127.0.0.1', done));
const environment = { GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm', INTENT_UNDERSTANDING_ENABLED: 'true', INTENT_ROUTING_MODE: 'enforce_all_current_epoch',
  AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED: 'false', ENABLE_BULLMQ: 'false', LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'multi-segment-fixture',
  LLM_API_KEY: 'fixture-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false', LLM_REMOTE_STREAMING: 'false' };
const state = () => readFile(server.dataFile, 'utf8').then(JSON.parse);
async function waitRoute(sessionId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = await state(), route = current.intentRoutingRecordsBySession?.[sessionId]?.[0];
    if (route?.status === 'CLARIFICATION_REQUIRED') return { current, route };
    if (route && ['BLOCKED', 'REJECTED'].includes(route.status)) throw new Error(JSON.stringify(route.reasonCodes));
    await new Promise(done => setTimeout(done, 80));
  }
  throw new Error('Multi-segment classification did not settle');
}
try {
  server = await startSmokeServer('intent-multi-segment-review', environment);
  for (const role of ['intent_router', 'coordinator']) await api(server.apiBase, `/system-agent-runtime-policies/${role}`,
    { method: 'PATCH', body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  for (const size of [2, 8]) {
    count = size;
    const created = (await api(server.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({ input: message }) })).data;
    const sessionId = created.session.id; sessions.push(sessionId);
    const { current, route } = await waitRoute(sessionId), event = current.eventsBySession[sessionId].find(row => row.metadata?.payload?.multiSegmentReview);
    const review = event?.metadata.payload.multiSegmentReview;
    check(`MS${size === 2 ? '01' : '03'}`, review?.understanding.segments.length === size && route.semanticPlan.steps.length === size &&
      review.routingId === route.id && review.sourceEventId === route.sourceEventId && review.dataEpoch === created.session.dataEpoch &&
      JSON.stringify(review.understanding) === JSON.stringify(route.semanticProposal.understanding), { segments: size, completeDiagnostic: true });
    check(`MS${size === 2 ? '02' : '04'}`, !current.workItemsBySession?.[sessionId]?.length && !current.intentPlanStepsBySession?.[sessionId]?.length &&
      !current.briefsBySession?.[sessionId] && current.eventOutbox.some(row => row.id === `outbox:${event.id}` && row.payload.event.metadata.payload.multiSegmentReview),
      { noPartialTaskStepBrief: true, diagnosticOutbox: true });
    const queried = (await api(server.apiBase, `/sessions/${sessionId}/message-routings/${route.id}`)).data;
    assert.deepEqual(queried.semanticProposal.understanding, review.understanding);
    const response = await fetch(`${server.apiBase}/sessions/${sessionId}/message-routings/${route.id}/clarify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contractVersion: 'intent-clarify-v1',
        confirmationId: event.id, expectedRoutingRevision: route.routingRevision, choice: 'independent_new', idempotencyKey: randomUUID() }) });
    assert.ok([400, 409, 410].includes(response.status), `Unexpected relation resolution status ${response.status}`);
  }
  check('MS05', calls === 2, { oneClassificationPerMessage: true, forgedRelationChoiceCannotExecuteSubset: true });
  const before = await state(), dataFile = server.dataFile;
  await stopSmokeServer(server); server = undefined;
  await writeFile(dataFile, JSON.stringify(before));
  server = await startSmokeServer('intent-multi-segment-review-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: dataFile });
  const unusedSeed = server.dataFile; server.dataFile = dataFile; await rm(unusedSeed, { force: true });
  const restored = await state();
  check('MS06', calls === 2 && sessions.every(id => !restored.intentPlanStepsBySession?.[id]?.length &&
    JSON.stringify(restored.eventsBySession[id].filter(row => row.metadata?.payload?.multiSegmentReview)) ===
    JSON.stringify(before.eventsBySession[id].filter(row => row.metadata?.payload?.multiSegmentReview))), { realRestart: true, noModelOrPartialExecution: true });
} finally {
  if (server) await stopSmokeServer(server);
  provider.closeAllConnections(); await new Promise(done => provider.close(done));
  await writeFile(resolve(directory, 'multi-segment-review-http-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'Real Nest HTTP/Generic LLM adapter with deterministic provider, File persistence and restart; not model accuracy or ordered execution', results }, null, 2));
}
assert.equal(results.length, 6); assert.ok(results.every(row => row.passed));
