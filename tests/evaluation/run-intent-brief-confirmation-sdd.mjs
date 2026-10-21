import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const message = '请整理登录实现的任务草稿。';
let server, stage = 'success'; const results = [], calls = [];
const check = (id, condition, actual) => { results.push({ id, passed: Boolean(condition), actual: structuredClone(actual) }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); };
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return response.writeHead(404).end();
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), prompt = JSON.stringify(input.messages), brief = prompt.includes('brief_generation');
    const sourceEventId = prompt.match(/(?:Current source event ID|Source event): ([^\s"\\]+)/)?.[1]; assert.ok(sourceEventId);
    calls.push({ stage, brief, sourceEventId, tools: (input.tools ?? []).map(tool => tool.function?.name), repair: prompt.includes('Repair feedback') });
    if (stage === 'auth' && brief) return response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"fixture auth failure"}}');
    let output = brief ? { schemaVersion: '1.0', kind: 'task_brief', goal: '登录实现草稿', scope: ['登录'], outOfScope: [], constraints: [],
      acceptanceCriteria: ['核对需求'], risks: [], openQuestions: [], suggestedTasks: [] }
      : { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
        segments: [{ localKey: 'initial', dialogueAct: 'command', goal: message, scopeRelation: 'initial_requirement', suggestedAction: 'create_initial_work_item', contextPolicy: 'clean_task_context',
          target: { workItemId: null, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null }, correction: null,
          requestedEffects: [], prohibitions: [], evidence: [{ refId: 'request', sourceEventId, start: 0, end: message.length, quote: message }], dependencies: [] }],
        missingFields: [], ambiguityReasons: [], modelConfidence: null };
    if (stage === 'repair' && brief && calls.filter(row => row.stage === stage && row.brief).length === 1) output = { kind: 'task_brief' };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
  } catch (error) { console.error(error); response.writeHead(500).end(); }
});
const port = await findFreePort(); await new Promise(done => provider.listen(port, '127.0.0.1', done));
const environment = { GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm', INTENT_UNDERSTANDING_ENABLED: 'true', INTENT_ROUTING_MODE: 'enforce_all_current_epoch',
  AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED: 'false', ENABLE_BULLMQ: 'false', LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'brief-fixture',
  LLM_API_KEY: 'fixture-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false', LLM_REMOTE_STREAMING: 'false' };
const state = () => readFile(server.dataFile, 'utf8').then(JSON.parse);
async function createAndSettle() {
  const created = (await api(server.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({ input: message,
    runtimePreference: { preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] } }) })).data;
  const sessionId = created.session.id, deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = await state(), route = current.intentRoutingRecordsBySession?.[sessionId]?.find(row => row.id === created.routingId);
    const step = (current.intentPlanStepsBySession?.[sessionId] ?? []).find(row => row.step.action === 'prepare_brief');
    if (step && ['completed', 'failed', 'invalidated', 'reconciliation_required'].includes(step.status)) return { sessionId, current, route, step };
    if (route && ['BLOCKED', 'REJECTED', 'CLARIFICATION_REQUIRED'].includes(route.status)) throw new Error(JSON.stringify(route.reasonCodes));
    await new Promise(done => setTimeout(done, 80));
  }
  throw new Error(`Brief did not settle: ${sessionId}`);
}
try {
  server = await startSmokeServer('intent-brief-confirmation', environment);
  for (const role of ['intent_router', 'coordinator']) await api(server.apiBase, `/system-agent-runtime-policies/${role}`,
    { method: 'PATCH', body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const first = await createAndSettle(), briefs = first.current.briefsBySession?.[first.sessionId] ?? [];
  check('BE01', first.step.status === 'completed' && briefs.length === 1 && calls.length === 2 && calls.every(row => !row.tools.length),
    { status: first.step.status, failure: first.step.failureCode, calls, briefs: briefs.length });
  const projected = (await api(server.apiBase, `/sessions/${first.sessionId}`)).data;
  const listed = (await api(server.apiBase, `/sessions/${first.sessionId}/briefs`)).data;
  check('BE02', projected.currentTaskBriefId === briefs[0].id && projected.status === 'WAIT_USER_CONFIRM' && listed.length === 1 && listed[0].intentBinding?.stepId === first.step.id &&
    first.current.workItemsBySession[first.sessionId][0].status === 'WAITING_USER' && !(first.current.tasksBySession?.[first.sessionId]?.length),
    { currentBrief: projected.currentTaskBriefId, status: projected.status, workItemStatus: first.current.workItemsBySession[first.sessionId][0].status, durableRead: listed.length });
  const confirmation = first.current.eventsBySession[first.sessionId].find(row => row.type === 'user_confirmation_requested');
  const rejected = await fetch(`${server.apiBase}/sessions/${first.sessionId}/briefs/${encodeURIComponent(briefs[0].id)}/confirm`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmationId: confirmation.metadata.payload.confirmationId }) });
  check('BE03', rejected.status === 409 && !(await state()).tasksBySession?.[first.sessionId]?.length, { confirmationNotExecutionAuthority: true, status: rejected.status });
  const confirmationRequest = { contractVersion: 'intent-brief-confirm-v1', dataEpoch: projected.dataEpoch,
    confirmationId: confirmation.metadata.payload.confirmationId, expectedBriefVersion: briefs[0].version,
    expectedIntentRevision: briefs[0].intentBinding.intentRevision, idempotencyKey: randomUUID() };
  const confirmPath = `/sessions/${first.sessionId}/briefs/${encodeURIComponent(briefs[0].id)}/confirm`;
  const submit = (path, body) => api(server.apiBase, path, { method: 'POST', body: JSON.stringify(body) }).then(row => row.data);
  const rawPost = (path, body) => fetch(`${server.apiBase}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const concurrent = await Promise.all([submit(confirmPath, confirmationRequest), submit(confirmPath, { ...confirmationRequest, idempotencyKey: randomUUID() })]);
  const confirmedState = await state(), after = (await api(server.apiBase, `/sessions/${first.sessionId}`)).data;
  check('BC01', concurrent[0].receipt.id === concurrent[1].receipt.id && concurrent.filter(row => row.idempotentReplay).length === 1 &&
    after.status === 'WAIT_WORKFLOW_SELECT' && confirmedState.briefsBySession[first.sessionId][0].confirmedByUser &&
    confirmedState.eventsBySession[first.sessionId].filter(row => row.type === 'brief_confirmed').length === 1 &&
    !(confirmedState.tasksBySession?.[first.sessionId]?.length), { status: after.status, sameReceipt: true, noBusinessDispatch: true });
  const stale = await rawPost(confirmPath, { ...confirmationRequest, expectedBriefVersion: 99 });
  const foreign = await rawPost(confirmPath, { ...confirmationRequest, dataEpoch: 'foreign' });
  const extra = await rawPost(confirmPath, { ...confirmationRequest, allowOpenQuestions: true });
  const workflow = await rawPost(`/sessions/${first.sessionId}/workflow/select`, { workflowId: 'unbound', confirmationId: 'unbound' });
  check('BC02', stale.status === 409 && foreign.status === 409 && extra.status === 400 && workflow.status === 409,
    { stale: stale.status, foreign: foreign.status, extra: extra.status, unboundWorkflow: workflow.status });
  stage = 'paused'; const paused = await createAndSettle();
  const pausedBrief = paused.current.briefsBySession[paused.sessionId][0];
  const pausedCard = paused.current.eventsBySession[paused.sessionId].find(row => row.type === 'user_confirmation_requested');
  await submit(`/sessions/${paused.sessionId}/pause`, { reason: 'confirmation fixture pause' });
  const pausedResult = await submit(`/sessions/${paused.sessionId}/briefs/${encodeURIComponent(pausedBrief.id)}/confirm`, {
    ...confirmationRequest, confirmationId: pausedCard.metadata.payload.confirmationId, expectedBriefVersion: pausedBrief.version,
    expectedIntentRevision: pausedBrief.intentBinding.intentRevision, idempotencyKey: randomUUID() });
  const pausedState = await state(), pausedSession = (await api(server.apiBase, `/sessions/${paused.sessionId}`)).data;
  check('BC03', pausedResult.status === 'PAUSED' && pausedSession.status === 'PAUSED' &&
    pausedState.sessionLifecyclesBySession[paused.sessionId].admission === 'closed' &&
    pausedSession.pauseState.previousStatus === 'WAIT_WORKFLOW_SELECT', { status: pausedSession.status, pauseState: pausedSession.pauseState });
  stage = 'repair'; const repaired = await createAndSettle(), repairCalls = calls.filter(row => row.stage === stage && row.brief);
  check('BE04', repaired.step.status === 'completed' && repairCalls.length === 2 && repairCalls[1].repair && repaired.step.processing.attemptsUsed === 2,
    { status: repaired.step.status, calls: repairCalls, attempts: repaired.step.processing.attemptsUsed });
  stage = 'auth'; const failed = await createAndSettle();
  check('BE05', failed.step.status === 'failed' && calls.filter(row => row.stage === stage && row.brief).length === 1 && !failed.current.briefsBySession?.[failed.sessionId]?.length,
    { status: failed.step.status, code: failed.step.failureCode, calls: calls.filter(row => row.stage === stage) });
  const saved = await state(), dataFile = server.dataFile, count = calls.length;
  await stopSmokeServer(server); server = undefined; await writeFile(dataFile, JSON.stringify(saved));
  server = await startSmokeServer('intent-brief-executor-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: dataFile });
  const unused = server.dataFile; server.dataFile = dataFile; await rm(unused, { force: true });
  const restored = (await api(server.apiBase, `/sessions/${first.sessionId}/briefs`)).data;
  const replay = await submit(confirmPath, confirmationRequest);
  check('BC04', replay.idempotentReplay && replay.receipt.id === concurrent[0].receipt.id, { realRestart: true, sameReceipt: true });
  check('BE06', calls.length === count && restored.length === 1 && restored[0].id === briefs[0].id, { realRestart: true, noRepeatedModelCall: true });
} finally {
  if (server) await stopSmokeServer(server); provider.closeAllConnections(); await new Promise(done => provider.close(done));
  await writeFile(resolve(directory, 'brief-confirmation-http-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'Actual Sessions HTTP/Nest/Generic LLM/File with deterministic provider and process restart; not model accuracy', results }, null, 2));
}
assert.equal(results.length, 10); assert.ok(results.every(row => row.passed));
