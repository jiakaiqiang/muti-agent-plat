import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const prefix = process.env.INTENT_CLARIFICATION_EVIDENCE_PREFIX ?? 'semantic-clarification';
const workspace = await mkdtemp(join(tmpdir(), 'semantic-clarification-http-'));
let server, sessionId, workItemId, mode = 'ambiguous', message = '处理天气查询需求', calls = 0;
const results = [];
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw), prompt = JSON.stringify(input.messages); calls++;
    if (mode === 'auth') { response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'fixture auth failed' } })); return; }
    const sourceEventId = prompt.match(/Current source event ID: ([^\s"\\]+)/)?.[1]; assert.ok(sourceEventId);
    const clarifying = mode !== 'ambiguous'; if (clarifying) assert.ok(prompt.includes('Server-bound clarification:'));
    const related = mode === 'related', continuation = mode === 'expanded';
    const content = { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
      segments: [{ localKey: 'goal', dialogueAct: 'command', goal: message,
        scopeRelation: !clarifying ? 'ambiguous' : related ? 'related_new_requirement' : continuation ? 'same_requirement' : workItemId ? 'independent_new_requirement' : 'initial_requirement',
        suggestedAction: !clarifying ? 'clarify' : related ? 'create_related_work_item' : continuation ? 'enqueue_follow_up' : workItemId ? 'create_independent_work_item' : 'create_initial_work_item',
        contextPolicy: !clarifying ? 'ask_user' : related ? 'inherit_selected' : continuation ? 'inherit_confirmed' : 'clean_task_context',
        target: { workItemId: related || continuation ? workItemId : null, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
        correction: null, requestedEffects: continuation ? [{ kind: 'run_tests', target: { kind: 'test_runner', refId: 'forged-runner' }, evidenceRefs: ['request'] }] : [],
        prohibitions: [], dependencies: [], evidence: [{ refId: 'request', sourceEventId, start: 0, end: message.length, quote: message }] }],
      missingFields: [], ambiguityReasons: [], modelConfidence: null };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
});
const port = await findFreePort(); await new Promise(done => provider.listen(port, '127.0.0.1', done));
const environment = { GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm', INTENT_UNDERSTANDING_ENABLED: 'true',
  INTENT_ROUTING_MODE: 'enforce_all_current_epoch', AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED: 'false', ENABLE_BULLMQ: 'false', LLM_PROVIDER: 'openai-compatible',
  LLM_MODEL: 'clarification-fixture', LLM_API_KEY: 'fixture-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false', LLM_REMOTE_STREAMING: 'false' };
const state = () => readFile(server.dataFile, 'utf8').then(JSON.parse);
async function until(predicate) { const deadline = Date.now() + 20000; let value;
  do { value = await state(); if (predicate(value)) return value; await new Promise(done => setTimeout(done, 50)); } while (Date.now() < deadline);
  throw new Error(JSON.stringify({ routes: value.intentRoutingRecordsBySession, calls })); }
const route = (value, id) => value.intentRoutingRecordsBySession[sessionId].find(row => row.id === id);
const card = (value, id) => value.eventsBySession[sessionId].find(row => row.type === 'intent_clarification_required' && row.metadata.payload.routingId === id);
const requestFor = (entry, choice) => ({ contractVersion: 'intent-clarify-v1', confirmationId: entry.metadata.payload.confirmationId,
  expectedRoutingRevision: entry.metadata.payload.routingRevision, choice, idempotencyKey: `choice:${entry.id}:${choice}` });
const post = async (id, body) => { const result = await fetch(`${server.apiBase}/sessions/${sessionId}/message-routings/${id}/clarify`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: result.status, body: await result.json() }; };
function record(id, condition, actual) { results.push({ id, passed: Boolean(condition), actual }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); }
async function ambiguous(text) { message = text; mode = 'ambiguous';
  const sent = (await api(server.apiBase, `/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content: message }) })).data;
  const current = await until(value => card(value, sent.routingId)); return { id: sent.routingId, card: card(current, sent.routingId) }; }
try {
  server = await startSmokeServer('semantic-clarification', environment);
  for (const role of ['intent_router', 'coordinator']) await api(server.apiBase, `/system-agent-runtime-policies/${role}`, { method: 'PATCH',
    body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const created = (await api(server.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({ input: message,
    workingDirectory: { kind: 'server_local', id: 'fixture', name: 'fixture', path: workspace, selectedAt: new Date().toISOString() } }) })).data;
  sessionId = created.session.id;
  const initial = await until(value => value.eventsBySession?.[sessionId]?.some(row => row.type === 'intent_clarification_required'));
  const firstCard = initial.eventsBySession[sessionId].find(row => row.type === 'intent_clarification_required'), firstId = firstCard.metadata.payload.routingId;
  record('SC01', (initial.workItemsBySession?.[sessionId]?.length ?? 0) === 0 && firstCard.metadata.payload.reason === 'intent_relation_clarification' &&
    firstCard.metadata.payload.options.length === 1, { noFakeTask: true, card: firstCard });
  const request = requestFor(firstCard, 'independent_new'), beforeInvalid = calls;
  const invalid = await post(firstId, { ...request, confirmationId: 'foreign' });
  record('SC02', invalid.status === 409 && calls === beforeInvalid, invalid);
  mode = 'independent'; const resolved = await post(firstId, request), after = await state();
  workItemId = after.workItemsBySession?.[sessionId]?.[0]?.id;
  record('SC03', resolved.status === 200 && workItemId && route(after, firstId).currentIntentRevision === 2 &&
    after.intentRouteRevisionsBySession[sessionId].length === 2 && after.intentResolutionReceiptsBySession[sessionId].length === 1,
    { resolved, preservedHistory: true, noFollowUp: !(after.followUpMessagesBySession?.[sessionId]?.length) });
  const beforeReplay = calls, replay = await post(firstId, request);
  record('SC04', replay.status === 200 && replay.body.data.idempotentReplay && calls === beforeReplay, replay);
  const second = await ambiguous('处理与天气相关的另一项需求'); mode = 'related';
  const related = await post(second.id, requestFor(second.card, 'related_new'));
  const opposite = await post(second.id, requestFor(second.card, 'independent_new'));
  const relatedState = await state(), child = relatedState.workItemsBySession[sessionId].find(row => row.parentWorkItemId === workItemId);
  record('SC05', related.status === 200 && opposite.status === 409 && child?.inheritedDecisionIds.length === 0,
    { related, opposite, child, displayedInheritance: second.card.metadata.payload.description });
  workItemId = relatedState.sessions.find(row => row.id === sessionId).activeWorkItemId;
  const third = await ambiguous('处理当前需求的下一项说明'); mode = 'expanded';
  const expanded = await post(third.id, requestFor(third.card, 'continue_current')), expandedState = await state();
  record('SC06', expanded.status === 409 && route(expandedState, third.id).blockedReason === 'CLARIFICATION_EFFECT_SCOPE_EXPANDED' &&
    !route(expandedState, third.id).resolution && !(expandedState.logicalOperationsBySession[sessionId] ?? []).some(row => row.admissionClass === 'business'),
    { expanded, noExecutionAuthorityFromChoice: true });
  const fourth = await ambiguous('处理另一项待确认需求'); mode = 'auth'; const beforeAuth = calls;
  const denied = await post(fourth.id, requestFor(fourth.card, 'independent_new')), deniedState = await state();
  record('SC07', denied.status === 409 && calls === beforeAuth + 1 && route(deniedState, fourth.id).status === 'BLOCKED' &&
    route(deniedState, fourth.id).semanticClarification.attemptsUsed === 1 && !route(deniedState, fourth.id).resolution,
    { denied, noAuthenticationRetry: true, routing: route(deniedState, fourth.id) });
  const restartFile = join(workspace, 'restart.json'), beforeRestart = calls;
  await writeFile(restartFile, JSON.stringify(await state())); await stopSmokeServer(server); server = undefined;
  server = await startSmokeServer('semantic-clarification-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: restartFile }); server.dataFile = restartFile;
  const restartedReplay = await post(firstId, request), blockedReplay = await post(fourth.id, requestFor(fourth.card, 'independent_new'));
  const restartedState = await state();
  record('SC08', restartedReplay.status === 200 && restartedReplay.body.data.idempotentReplay && blockedReplay.status === 409 && calls === beforeRestart &&
    restartedState.workItemsBySession[sessionId].length === 2 && restartedState.intentResolutionReceiptsBySession[sessionId].length === 2,
    { actualServerRestart: true, noRepeatedClassification: true, noRepeatedWorkItem: true, blockedBudgetPreserved: route(restartedState, fourth.id).semanticClarification.attemptsUsed === 1 });
} finally {
  await writeFile(resolve(directory, `${prefix}-http-results.json`), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'real localhost Nest HTTP and File persistence with deterministic classifier; no model accuracy claim', results }, null, 2));
  if (server) await stopSmokeServer(server); provider.closeAllConnections(); await new Promise(done => provider.close(done));
  const child = relative(resolve(tmpdir()), resolve(workspace)); assert.ok(child.startsWith('semantic-clarification-http-') && !child.includes('..') && !isAbsolute(child));
  await rm(workspace, { recursive: true, force: true });
}
if (results.length !== 8 || results.some(row => !row.passed)) process.exitCode = 1;
