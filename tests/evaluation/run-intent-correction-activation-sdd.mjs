import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { api, createSessionAndWaitForBrief, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
import { PersistenceService } from '../../apps/server/dist/apps/server/src/modules/persistence/persistence.service.js';
import { ContextManagementService } from '../../apps/server/dist/apps/server/src/modules/context-management/context-management.service.js';

const out = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const stateFile = resolve('.cache/agent-cluster', `intent-activation-${randomUUID()}.json`);
const results = [];
const uiChecks = process.env.INTENT_CORRECTION_UI_CHECKS === '1';
const requests = [];
let server, sessionId, routingId, workId, oldDecision, initialStatus;
let releaseModel;
const gate = new Promise(resolve => { releaseModel = resolve; });
const instruction = '超时改为 30 分钟';
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const text = JSON.stringify(body.messages);
    const sourceEventId = text.match(/Current source event ID: ([^\s"\\]+)/)?.[1];
    requests.push({ model: body.model, tools: body.tools ?? [], sourceEventId,
      originalInputPresent: text.includes(instruction), contractPresent: text.includes('intent_understanding') });
    assert.ok(sourceEventId, 'the actual provider request must carry the current source event');
    await gate;
    const output = { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
      segments: [{ localKey: 'timeout', dialogueAct: 'correction', goal: instruction, scopeRelation: 'same_requirement',
        suggestedAction: 'correct_route', contextPolicy: 'inherit_confirmed',
        target: { workItemId: workId, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: routingId },
        correction: { supersedesDecisionId: oldDecision.id, expectedDecisionRevision: oldDecision.revision, replacementText: instruction },
        requestedEffects: [], prohibitions: [], dependencies: [],
        evidence: [{ refId: 'current', sourceEventId, start: 0, end: instruction.length, quote: instruction }] }],
      missingFields: [], ambiguityReasons: [], modelConfidence: 0.99 };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'fixture-completion', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
});
const providerPort = await findFreePort();
await new Promise(resolve => provider.listen(providerPort, '127.0.0.1', resolve));
const env = { DISCUSSION_MAX_ROUNDS: '0', GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock', INTENT_ROUTING_MODE: 'enforce_new_sessions',
  ENABLE_BULLMQ: 'false', LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'intent-activation-fixture', LLM_API_KEY: 'fixture-only',
  LLM_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false' };
async function record(id, feature, actual, passed) {
  results.push({ id, feature, actual, passed });
  console.log(JSON.stringify({ id, passed, actual }));
  assert.ok(passed, `${id}: ${feature}`);
}
async function post(path, input) {
  const response = await fetch(`${server.apiBase}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
}
await mkdir(out, { recursive: true });
try {
  server = await startSmokeServer('intent-activation-bootstrap', env);
  ({ sessionId } = await createSessionAndWaitForBrief(server.apiBase, '实现登录并遵循已确认的超时约束。', {
    runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] }
  }));
  const sourceState = server.dataFile;
  await writeFile(stateFile, await readFile(sourceState));
  await stopSmokeServer(server); server = undefined;
  // Build the isolated ledger and route through the same domain services used by the server.
  const persistence = new PersistenceService({ backend: 'file', filePath: stateFile });
  await persistence.initialize();
  try {
    const context = new ContextManagementService(persistence);
    const session = persistence.getCollection('sessions', []).find(item => item.id === sessionId);
    initialStatus = session.status;
    workId = session.activeWorkItemId;
    oldDecision = await context.recordDecision({ session, workItemId: workId, sourceEventId: 'http-fixture-old-timeout',
      kind: 'constraint', content: '超时为 10 分钟' });
    const route = await context.createRoutingRecord({ session, sourceEventId: 'http-fixture-route',
      idempotencyKey: 'http-fixture-route', rolloutMode: 'enforce_all_current_epoch' });
    routingId = route.id;
  } finally { await persistence.onModuleDestroy(); }
  server = await startSmokeServer('intent-activation-http', { ...env, AGENT_CLUSTER_DATA_FILE: stateFile });
  await api(server.apiBase, '/system-agent-runtime-policies/intent_router', { method: 'PATCH',
    body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const routePath = `/sessions/${sessionId}/message-routings/${routingId}`;
  const route = (await api(server.apiBase, routePath)).data;
  if (uiChecks) {
    const lookup = (await api(server.apiBase, `/sessions/${sessionId}/message-routings?sourceEventId=http-fixture-route`)).data;
    const absent = (await api(server.apiBase, `/sessions/${sessionId}/message-routings?sourceEventId=unrelated-source`)).data;
    await record('CU01', '按原消息查询持久化路由，非匹配来源不返回记录', { ids: lookup.items.map(item => item.id), absent: absent.items.length },
      lookup.items.length === 1 && lookup.items[0].id === routingId && absent.items.length === 0);
    const missing = await fetch(`${server.apiBase}/sessions/${sessionId}/message-routings`);
    const wrongSession = await fetch(`${server.apiBase}/sessions/nonexistent-session/message-routings?sourceEventId=http-fixture-route`);
    await record('CU02', '缺少来源拒绝查询，其他会话不能取出原消息路由', { missing: missing.status, wrongSession: wrongSession.status },
      missing.status === 400 && wrongSession.status === 404);
  }
  const input = { contractVersion: 'intent-correction-v1', expectedRoutingRevision: route.routingRevision ?? 1,
    idempotencyKey: randomUUID(), instruction, targetWorkItemId: workId,
    supersedesDecisionId: oldDecision.id, expectedDecisionRevision: oldDecision.revision };
  const accepted = await Promise.all([post(`${routePath}/corrections`, input), post(`${routePath}/corrections`, input)]);
  const correctionId = accepted[0].body.data?.correctionId;
  await record('CA01', '并发 HTTP 接收同一纠错且尚未生效', { statuses: accepted.map(item => item.status),
    errors: accepted.map(item => item.body.error), correctionId },
    accepted.every(item => item.status === 202 && item.body.data.correctionId === correctionId && item.body.data.correctionStatus !== 'applied'));
  const held = (await api(server.apiBase, routePath)).data;
  await record('CA02', '等待模型期间保留持久化屏障', { hold: held.dispatchHold }, held.dispatchHold?.correctionId === correctionId);
  releaseModel();
  let history;
  const deadline = Date.now() + 30_000;
  do {
    history = (await api(server.apiBase, `${routePath}/corrections`)).data;
    if (['applied', 'rejected', 'clarification_required', 'reconciliation_required'].includes(history.corrections[0]?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  await record('CA03', '真实 Generic LLM HTTP 传输激活新版本', { status: history.corrections[0]?.status,
    reasons: history.corrections[0]?.reasonCodes, requests }, history.corrections[0]?.status === 'applied' &&
    requests.length === 1 && requests[0].tools.length === 0 && requests[0].originalInputPresent && requests[0].contractPresent);
  const activated = (await api(server.apiBase, routePath)).data;
  const work = (await api(server.apiBase, `/sessions/${sessionId}/work-items`)).data.items.find(item => item.id === workId);
  await record('CA04', '新版本与需求版本激活，屏障原子释放', { current: activated.currentIntentRevision,
    effective: activated.effectiveIntentRevision, requirement: work.requirementRevision, epoch: work.executionEpoch },
    activated.currentIntentRevision === 2 && activated.effectiveIntentRevision === 2 && work.requirementRevision === 2 &&
    work.executionEpoch === 2 && !activated.dispatchHold && !work.dispatchHold && history.revisions.length === 2);
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  const decisions = saved.decisionRecordsBySession[sessionId];
  await record('CA05', '旧约束失效、新约束持久化且未隐式推进会话', { old: decisions.find(item => item.id === oldDecision.id)?.status,
    replacement: decisions.find(item => item.supersedesDecisionId === oldDecision.id)?.content,
    sessionStatus: saved.sessions.find(item => item.id === sessionId)?.status },
    decisions.find(item => item.id === oldDecision.id)?.status === 'superseded' &&
    decisions.some(item => item.supersedesDecisionId === oldDecision.id && item.content === instruction && item.status === 'confirmed') &&
    saved.sessions.find(item => item.id === sessionId)?.status === initialStatus);
  await stopSmokeServer(server); server = undefined;
  server = await startSmokeServer('intent-activation-restart', { ...env, AGENT_CLUSTER_DATA_FILE: stateFile });
  const replay = await post(`${routePath}/corrections`, input);
  const restored = (await api(server.apiBase, `${routePath}/corrections`)).data;
  if (uiChecks) {
    const lookup = (await api(server.apiBase, `/sessions/${sessionId}/message-routings?sourceEventId=http-fixture-route`)).data;
    await record('CU03', '重启后原消息查询可找回已纠错路由和当前版本', { id: lookup.items[0]?.id,
      effective: lookup.items[0]?.effectiveIntentRevision, revision: lookup.items[0]?.routingRevision },
      lookup.items.length === 1 && lookup.items[0].id === routingId && lookup.items[0].effectiveIntentRevision === 2 &&
      lookup.items[0].routingRevision > input.expectedRoutingRevision);
  }
  await record('CA06', '进程重启后原请求重放不再次分类或追加版本', { status: replay.status,
    correctionId: replay.body.data?.correctionId, revisions: restored.revisions.length, modelRequests: requests.length },
    replay.status === 202 && replay.body.data?.correctionId === correctionId && replay.body.data?.correctionStatus === 'applied' &&
    restored.revisions.length === 2 && requests.length === 1);
} finally {
  releaseModel();
  await writeFile(resolve(out, uiChecks ? 'correction-ui-http-results.json' : 'correction-activation-http-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'real localhost API and Generic LLM HTTP transport; deterministic local provider (not semantic accuracy); isolated File backend; actual process restart', results }, null, 2));
  if (server) await stopSmokeServer(server);
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  await rm(stateFile, { force: true });
}
if (results.length !== (uiChecks ? 9 : 6) || results.some(item => !item.passed)) process.exitCode = 1;
