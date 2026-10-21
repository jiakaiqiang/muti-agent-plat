import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';

const out = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const fixture = await mkdtemp(join(tmpdir(), 'intent-authorization-http-')), workspace = join(fixture, 'workspace');
await mkdir(workspace);
await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'node --test proof.cjs' } }));
await writeFile(join(workspace, 'source.txt'), 'original');
await writeFile(join(workspace, 'proof.cjs'), 'const {test}=require("node:test"),fs=require("node:fs"),assert=require("node:assert/strict");test("first request",()=>{assert.throws(()=>fs.writeFileSync("/input/source.txt","changed"));fs.writeFileSync("scratch.txt","ok");});');
const message = '运行 test:unit 并保存测试报告，不修改源码';
const results = []; let server, sessionId, modelCalls = 0;
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), prompt = input.messages.map(row => typeof row.content === 'string' ? row.content :
      Array.isArray(row.content) ? row.content.map(part => part.text ?? '').join('\n') : '').join('\n'); modelCalls++;
    assert.ok(prompt.includes('Return only intent_understanding@1.0'));
    const sourceEventId = prompt.match(/Current source event ID: ([^\s"\\]+)/)?.[1]; assert.ok(sourceEventId);
    const serializedAuthority = prompt.match(/Server-bound effect resources and grants: (.+)\. Use only listed resource IDs/)?.[1] ?? 'null';
    // Runtime encodes the context envelope as JSON inside a provider message.
    const authority = JSON.parse(serializedAuthority.startsWith('{\\"') ? JSON.parse(`"${serializedAuthority}"`) : serializedAuthority);
    const binding = authority.testRunnerBindings.find(row => row.script === 'test:unit'); assert.ok(binding);
    const content = { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
      segments: [{ localKey: 'first-test', dialogueAct: 'command', goal: message, scopeRelation: 'initial_requirement',
        suggestedAction: 'create_initial_work_item', target: { workItemId: null, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
        correction: null, contextPolicy: 'clean_task_context', requestedEffects: [
          { kind: 'run_tests', target: { kind: 'test_runner', refId: binding.resourceId }, evidenceRefs: ['request'] },
          { kind: 'write_artifact', target: { kind: 'artifact', refId: `test-report:${binding.bindingHash}` }, evidenceRefs: ['request'] }],
        prohibitions: [{ effectKind: 'modify_source', object: { kind: 'workspace', refId: binding.workspaceId }, scope: 'message', evidenceRefs: ['request'] }],
        evidence: [{ refId: 'request', sourceEventId, start: 0, end: message.length, quote: message }], dependencies: [] }],
      missingFields: [], ambiguityReasons: [], modelConfidence: null };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
  } catch (error) { console.error('Fixture provider failed:', error); response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
});
const port = await findFreePort(); await new Promise(done => provider.listen(port, '127.0.0.1', done));
const environment = { GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm', INTENT_UNDERSTANDING_ENABLED: 'true', INTENT_ROUTING_MODE: 'enforce_all_current_epoch',
  AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED: 'false', ENABLE_BULLMQ: 'false', LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'first-test-fixture',
  LLM_API_KEY: 'fixture-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false', LLM_REMOTE_STREAMING: 'false',
  INTENT_ISOLATED_TEST_IMAGE: process.env.INTENT_TEST_DOCKER_IMAGE };
const state = () => readFile(server.dataFile, 'utf8').then(JSON.parse);
async function until(predicate) { const deadline = Date.now() + 45_000; let value;
  do { value = await state(); if (predicate(value)) return value; await new Promise(done => setTimeout(done, 100)); } while (Date.now() < deadline);
  throw new Error(JSON.stringify({ routes: value.intentRoutingRecordsBySession, steps: value.intentPlanStepsBySession, modelCalls })); }
async function post(path, body) { const response = await fetch(`${server.apiBase}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() }; }
async function check(id, condition, actual) { results.push({ id, passed: Boolean(condition), actual }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); }
try {
  assert.match(environment.INTENT_ISOLATED_TEST_IMAGE ?? '', /^sha256:[a-f0-9]{64}$/);
  server = await startSmokeServer('intent-authorization-retry', environment);
  for (const role of ['intent_router', 'coordinator']) await api(server.apiBase, `/system-agent-runtime-policies/${role}`,
    { method: 'PATCH', body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const created = (await api(server.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({ input: message,
    workingDirectory: { kind: 'server_local', id: 'fixture', name: 'fixture', path: workspace, selectedAt: new Date().toISOString() } }) })).data;
  sessionId = created.session.id;
  const initial = await until(value => value.intentRoutingRecordsBySession?.[sessionId]?.some(row => row.semanticPlan));
  const route = initial.intentRoutingRecordsBySession[sessionId][0], path = `/sessions/${sessionId}/message-routings/${route.id}/retry-authorization`;
  const request = { contractVersion: 'intent-authorization-retry-v1', dataEpoch: created.session.dataEpoch, expectedRoutingRevision: route.routingRevision, idempotencyKey: 'explicit-retry' };
  const testOperations = value => (value.logicalOperationsBySession?.[sessionId] ?? []).filter(row => row.id.startsWith('intent-test:'));
  await check('AR01', route.semanticPlan.validation.errorCodes.join(',') === 'EFFECT_NOT_AUTHORIZED' &&
    !initial.workItemsBySession?.[sessionId]?.length && !initial.briefsBySession?.[sessionId] && !testOperations(initial).length,
    { noGrantNoTaskOrBriefOrExecution: true, routeStatus: route.status, modelCalls });
  await check('AR02', (await post(path, { ...request, plan: {} })).status === 400 &&
    (await post(path, { ...request, expectedRoutingRevision: 999 })).status === 409 && (await post(path, request)).status === 409,
    { clientPlanRejected: true, staleVersionRejected: true, missingGrantRejected: true });
  const authorityPath = `/sessions/${sessionId}/intent-test-authority`;
  const view = async () => (await api(server.apiBase, authorityPath)).data;
  const grant = async (writeReport, key) => { const current = await view(); const binding = current.availableBindings.find(row => row.script === 'test:unit');
    return post(authorityPath, { action: 'grant', script: 'test:unit', writeReport, dataEpoch: current.dataEpoch,
      expectedBindingHash: binding.bindingHash, expectedGrantRevision: current.authority?.grant.revision ?? 0, idempotencyKey: key }); };
  assert.equal((await grant(false, 'test-only')).status, 201);
  await check('AR03', (await post(path, request)).status === 409 && !testOperations(await state()).length,
    { reportRequiresSeparateGrant: true });
  assert.equal((await grant(true, 'test-and-report')).status, 201);
  await check('AR04', !testOperations(await state()).length && modelCalls === 1, { grantAloneDoesNotExecute: true, modelCalls });
  const replies = await Promise.all([post(path, request), post(path, request)]);
  await check('AR05', replies.every(row => row.status === 200) && replies.filter(row => row.body.data.idempotentReplay).length === 1,
    { concurrentReplies: replies.map(row => ({ status: row.status, replay: row.body.data?.idempotentReplay })) });
  const finished = await until(value => value.intentPlanStepsBySession?.[sessionId]?.some(row => row.status === 'completed'));
  const step = finished.intentPlanStepsBySession[sessionId][0], operation = testOperations(finished)[0], attempt = operation?.isolatedTestAttempts?.[0];
  const reports = finished.artifacts?.artifactIdsBySession?.[sessionId] ?? [];
  await check('AR06', step.step.action === 'create_initial_work_item' && step.intentRevision === 2 && finished.workItemsBySession[sessionId].length === 1 &&
    !finished.briefsBySession?.[sessionId] && reports.length === 1 && attempt?.result.exitCode === 0 && attempt.stopConfirmed && !attempt.cleanupRequired &&
    operation.attemptsUsed === 1 && modelCalls === 1 && await readFile(join(workspace, 'source.txt'), 'utf8') === 'original',
    { workItems: 1, reports: 1, modelCalls, step, attempt, sourceUnchanged: true });
  const versions = finished.intentRouteRevisionsBySession[sessionId];
  await check('AR07', versions.length === 2 && versions[0].authorizationState === 'unknown' && versions[1].authorizationState === 'validated' &&
    JSON.stringify(versions[0].understanding) === JSON.stringify(versions[1].understanding) &&
    finished.intentRoutingRecordsBySession[sessionId][0].authorizationRetryReceipts.length === 1,
    { immutableOriginalPlanPreserved: true, exactUnderstandingReused: true, oneReceipt: true });
  const restartFile = join(fixture, 'restart.json'); await writeFile(restartFile, JSON.stringify(finished));
  await stopSmokeServer(server); server = undefined;
  server = await startSmokeServer('intent-authorization-retry-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: restartFile }); server.dataFile = restartFile;
  const replay = await post(path, request), recovered = await state();
  await check('AR08', replay.status === 200 && replay.body.data.idempotentReplay && modelCalls === 1 && testOperations(recovered).length === 1 &&
    testOperations(recovered)[0].isolatedTestAttempts.length === 1 && recovered.artifacts.artifactIdsBySession[sessionId].length === 1 &&
    recovered.intentPlanStepsBySession[sessionId].length === 1 && (await post(path, { ...request, idempotencyKey: 'new' })).status === 409,
    { actualServerRestart: true, receiptReplay: true, noRepeatedModelTestTaskReport: true });
} finally {
  await writeFile(resolve(out, 'authorization-retry-http-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'real Nest HTTP, File backend, deterministic semantic provider, actual Docker test and process restart; not an accuracy evaluation', results }, null, 2));
  if (server) await stopSmokeServer(server); provider.closeAllConnections(); await new Promise(done => provider.close(done));
  const child = relative(resolve(tmpdir()), resolve(fixture)); assert.ok(child.startsWith('intent-authorization-http-') && !child.includes('..') && !isAbsolute(child));
  await rm(fixture, { recursive: true, force: true });
}
assert.equal(results.length, 8); assert.ok(results.every(row => row.passed));
