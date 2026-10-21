import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const out = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const fixture = await mkdtemp(join(tmpdir(), 'intent-test-grant-http-')), workspace = join(fixture, 'workspace'), restartFile = join(fixture, 'restart.json');
await mkdir(workspace); await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
const results = []; let server, sessionId, workItemId, resourceId, workspaceId;
let message = '为当前目录建立测试任务上下文', mode = 'initial', modelCalls = 0;
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), prompt = JSON.stringify(input.messages); modelCalls++;
    assert.ok(prompt.includes('Return only intent_understanding@1.0'));
    const sourceEventId = prompt.match(/Current source event ID: ([^\s"\\]+)/)?.[1];
    if (mode === 'test') { assert.ok(prompt.includes(resourceId)); assert.ok(prompt.includes('run_tests')); }
    const content = { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
      segments: [{ localKey: 'test-request', dialogueAct: 'command', goal: message,
        scopeRelation: mode === 'initial' ? 'initial_requirement' : 'same_requirement', suggestedAction: mode === 'initial' ? 'create_initial_work_item' : 'enqueue_follow_up',
        target: { workItemId: mode === 'initial' ? null : workItemId, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
        correction: null, contextPolicy: mode === 'initial' ? 'clean_task_context' : 'inherit_confirmed',
        requestedEffects: mode === 'initial' ? [] : [{ kind: 'run_tests', target: { kind: 'test_runner', refId: resourceId }, evidenceRefs: ['request'] }],
        prohibitions: mode === 'initial' ? [] : [{ effectKind: 'modify_source', object: { kind: 'workspace', refId: workspaceId }, scope: 'message', evidenceRefs: ['request'] }],
        evidence: [{ refId: 'request', sourceEventId, start: 0, end: message.length, quote: message }], dependencies: [] }],
      missingFields: [], ambiguityReasons: [], modelConfidence: null };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
});
const port = await findFreePort(); await new Promise(done => provider.listen(port, '127.0.0.1', done));
const environment = { GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm', INTENT_UNDERSTANDING_ENABLED: 'true', INTENT_ROUTING_MODE: 'enforce_all_current_epoch',
  AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED: 'false', ENABLE_BULLMQ: 'false', LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'test-authority-fixture',
  LLM_API_KEY: 'fixture-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false', LLM_REMOTE_STREAMING: 'false',
  INTENT_ISOLATED_TEST_IMAGE: `sha256:${'a'.repeat(64)}` };
const state = () => readFile(server.dataFile, 'utf8').then(JSON.parse);
async function until(predicate) { const deadline = Date.now() + 30_000; let value;
  do { value = await state(); if (predicate(value)) return value; await new Promise(done => setTimeout(done, 100)); } while (Date.now() < deadline);
  throw new Error(JSON.stringify({ routes: value.intentRoutingRecordsBySession, modelCalls })); }
const path = () => `/sessions/${sessionId}/intent-test-authority`;
const view = async () => (await api(server.apiBase, path())).data;
async function post(body) { const response = await fetch(`${server.apiBase}${path()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() }; }
const input = (current, action, key, script = 'test') => ({ action, script, dataEpoch: current.dataEpoch, idempotencyKey: key,
  expectedGrantRevision: current.authority?.grant.revision ?? 0,
  expectedBindingHash: action === 'revoke' ? current.authority.binding.bindingHash : current.availableBindings.find(row => row.script === script).bindingHash });
async function record(id, condition, actual) { results.push({ id, passed: Boolean(condition), actual }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); }
try {
  server = await startSmokeServer('intent-test-authority', environment);
  for (const role of ['intent_router', 'coordinator']) await api(server.apiBase, `/system-agent-runtime-policies/${role}`,
    { method: 'PATCH', body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const created = (await api(server.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({ input: message,
    workingDirectory: { kind: 'server_local', id: 'fixture', name: 'fixture', path: workspace, selectedAt: new Date().toISOString() } }) })).data;
  sessionId = created.session.id; workspaceId = created.session.workspaceId;
  const initial = await until(value => value.workItemsBySession?.[sessionId]?.length === 1); workItemId = initial.workItemsBySession[sessionId][0].id;
  const first = await view(), readAuthority = initial.sessions.find(row => row.id === sessionId).intentWorkspaceReadAuthority;
  await record('TA01', !first.enabled && first.authority === null && first.availableBindings.length === 3 && Boolean(readAuthority),
    { configuredCandidates: first.availableBindings.length, initiallyAuthorized: first.enabled, readIndependent: Boolean(readAuthority) });
  const grantRequest = input(first, 'grant', 'grant');
  const concurrent = await Promise.all([post(grantRequest), post(grantRequest)]);
  const granted = await view(); resourceId = granted.authority.binding.resourceId;
  await record('TA02', concurrent.every(row => row.status === 201) && concurrent.filter(row => row.body.data.idempotentReplay).length === 1 && granted.authority.grant.revision === 1,
    { statuses: concurrent.map(row => row.status), revision: granted.authority.grant.revision });
  const malformed = await post({ ...grantRequest, imageId: 'untrusted-image' });
  const wrongEpoch = await post({ ...grantRequest, idempotencyKey: 'other-epoch', dataEpoch: 'other' });
  await record('TA03', malformed.status === 400 && wrongEpoch.status === 409, { malformed: malformed.status, wrongEpoch: wrongEpoch.status });
  mode = 'test'; message = '只运行 test 测试，不修改源码';
  const sent = (await api(server.apiBase, `/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content: message }) })).data;
  const blocked = await until(value => value.intentRoutingRecordsBySession[sessionId].some(row => row.id === sent.routingId && row.status === 'BLOCKED'));
  const route = blocked.intentRoutingRecordsBySession[sessionId].find(row => row.id === sent.routingId);
  const snapshot = blocked.contextSnapshotsBySession[sessionId].find(row => row.id === route.snapshotId);
  await record('TA04', route.reasonCodes.includes('EFFECT_CAPABILITY_UNAVAILABLE') && !route.reasonCodes.includes('EFFECT_NOT_AUTHORIZED') &&
    snapshot.effectAuthority.grants.some(grant => grant.effect === 'run_tests') &&
    !blocked.logicalOperationsBySession[sessionId].some(row => row.phase === 'task_execution'),
    { status: route.status, reasons: route.reasonCodes, authorizedCandidate: resourceId, noTestDispatch: true });
  const raceView = await view(), race = await Promise.all([post(input(raceView, 'revoke', 'race-revoke')), post(input(raceView, 'grant', 'race-unit', 'test:unit'))]);
  await record('TA05', race.filter(row => row.status === 201).length === 1 && race.filter(row => row.status === 409).length === 1,
    { statuses: race.map(row => row.status) });
  const afterRace = await view();
  if (afterRace.enabled) assert.equal((await post(input(afterRace, 'revoke', 'revoke-current', afterRace.authority.binding.script))).status, 201);
  const revoked = await view(), replay = await post(grantRequest);
  const afterMessage = (await api(server.apiBase, `/sessions/${sessionId}`)).data;
  await record('TA06', !revoked.enabled && replay.body.data.idempotentReplay && !replay.body.data.enabled &&
    afterMessage.intentTestAuthority?.grant.revokedAt && JSON.stringify(afterMessage.intentWorkspaceReadAuthority) === JSON.stringify(readAuthority),
    { revokedRevision: revoked.authority.grant.revision, oldRequestReplayEnabled: replay.body.data.enabled, readGrantUnchanged: true });
  const latestGrant = input(revoked, 'grant', 'regrant'); assert.equal((await post(latestGrant)).status, 201);
  const beforeRestart = await state(), savedGrant = (await view()).authority;
  await record('TA07', beforeRestart.intentRoutingRecordsBySession[sessionId].find(row => row.id === sent.routingId).status === 'BLOCKED' &&
    !beforeRestart.logicalOperationsBySession[sessionId].some(row => row.phase === 'task_execution') && modelCalls === 2,
    { oldPlanRemainsBlocked: true, classificationCalls: modelCalls, grantRevision: savedGrant.grant.revision });
  await writeFile(restartFile, JSON.stringify(beforeRestart)); await stopSmokeServer(server); server = undefined;
  server = await startSmokeServer('intent-test-authority-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: restartFile }); server.dataFile = restartFile;
  const afterRestart = await view(), replayAfterRestart = await post(latestGrant);
  const final = await state();
  const events = final.eventsBySession[sessionId].filter(row => row.type === 'intent_test_authority_changed');
  await record('TA08', afterRestart.enabled && JSON.stringify(afterRestart.authority) === JSON.stringify(savedGrant) && replayAfterRestart.body.data.idempotentReplay &&
    events.every(event => final.eventOutbox.some(row => row.id === `outbox:${event.id}`)) && modelCalls === 2,
    { enabled: afterRestart.enabled, grantRevision: afterRestart.authority.grant.revision, effectiveAuthorityEvents: events.length, noModelReplay: true });
} finally {
  await writeFile(resolve(out, 'test-authority-http-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'real localhost Nest HTTP, isolated File persistence, deterministic local provider, real server restart; no Docker execution or accuracy claim', results }, null, 2));
  if (server) await stopSmokeServer(server); provider.closeAllConnections(); await new Promise(done => provider.close(done));
  const child = relative(resolve(tmpdir()), resolve(fixture)); assert.ok(child.startsWith('intent-test-grant-http-') && !child.includes('..') && !isAbsolute(child));
  await rm(fixture, { recursive: true, force: true });
}
if (results.length !== 8 || results.some(row => !row.passed)) process.exitCode = 1;
