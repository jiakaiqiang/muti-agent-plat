import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const message = '请分别解释当前系统的意图路由。';
let server, stage = 'setup', targets = [];
const results = [], calls = [];
const check = (id, condition, actual) => { results.push({ id, passed: Boolean(condition), actual }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); };
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return response.writeHead(404).end();
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), prompt = JSON.stringify(input.messages), answering = prompt.includes('user_message_response');
    const sourceEventId = prompt.match(/Current source event ID: ([^\s"\\]+)/)?.[1]; assert.ok(sourceEventId);
    const agent = answering ? targets.find(id => prompt.includes(id)) : undefined;
    calls.push({ stage, answering, agent, sourceEventId, tools: (input.tools ?? []).map(tool => tool.function?.name) });
    if (stage === 'partial' && answering && agent === targets[0]) {
      // Let the other independent target complete before observing this auth error.
      await new Promise(done => setTimeout(done, 400));
      return response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"fixture authentication failure"}}');
    }
    const output = answering ? { schemaVersion: '1.0', kind: 'agent_message', messageKind: 'answer', content: `回答来自 ${agent ?? 'coordinator'}`,
      targetAgentIds: [], targetAgentKeys: [], mentionedAgentIds: [], relatedTaskIds: [] }
      : { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
        segments: [{ localKey: 'question', dialogueAct: 'question', goal: message, scopeRelation: 'session_context', suggestedAction: 'answer_in_chat', contextPolicy: 'clean_task_context',
          target: { workItemId: null, decisionIds: [], artifactIds: [], agentIds: stage === 'setup' ? [] : targets, confirmationId: null, correctionOfRoutingId: null },
          correction: null, requestedEffects: [{ kind: 'answer', target: { kind: 'unresolved', refId: null }, evidenceRefs: ['request'] }],
          prohibitions: [], evidence: [{ refId: 'request', sourceEventId, start: 0, end: message.length, quote: message }], dependencies: [] }],
        missingFields: [], ambiguityReasons: [], modelConfidence: null };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
  } catch (error) { console.error(error); response.writeHead(500).end(); }
});
const port = await findFreePort(); await new Promise(done => provider.listen(port, '127.0.0.1', done));
const environment = { GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm', INTENT_UNDERSTANDING_ENABLED: 'true', INTENT_ROUTING_MODE: 'enforce_all_current_epoch',
  AGENT_CLUSTER_GITHUB_SESSION_CREATE_ENABLED: 'false', ENABLE_BULLMQ: 'false', LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'targeted-answer-fixture',
  LLM_API_KEY: 'fixture-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false', LLM_REMOTE_STREAMING: 'false' };
const state = () => readFile(server.dataFile, 'utf8').then(JSON.parse);
async function settled(sessionId, routingId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = await state(), route = current.intentRoutingRecordsBySession?.[sessionId]?.find(row => row.id === routingId);
    const steps = (current.intentPlanStepsBySession?.[sessionId] ?? []).filter(row => row.routingId === routingId);
    if (steps.length && steps.every(row => ['completed', 'failed', 'invalidated', 'reconciliation_required'].includes(row.status))) return { current, route, steps };
    if (route && ['BLOCKED', 'REJECTED', 'CLARIFICATION_REQUIRED'].includes(route.status)) throw new Error(JSON.stringify(route.reasonCodes));
    await new Promise(done => setTimeout(done, 80));
  }
  throw new Error('Targeted answers did not settle');
}
try {
  server = await startSmokeServer('intent-targeted-answer', environment);
  for (const role of ['intent_router', 'coordinator']) await api(server.apiBase, `/system-agent-runtime-policies/${role}`,
    { method: 'PATCH', body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const agents = (await api(server.apiBase, '/agents?surface=chat')).data.filter(row => row.key !== 'coordinator');
  targets = agents.slice(0, 2).map(row => row.id); assert.equal(targets.length, 2);
  const created = (await api(server.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({ input: message, agentIds: targets,
    runtimePreference: { preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] } }) })).data;
  const sessionId = created.session.id; await settled(sessionId, created.routingId);
  stage = 'success'; const key = randomUUID(), path = `/sessions/${sessionId}/messages`;
  const body = JSON.stringify({ content: message, mentionedAgentIds: targets });
  const sent = (await api(server.apiBase, path, { method: 'POST', headers: { 'Idempotency-Key': key }, body })).data;
  const completed = await settled(sessionId, sent.routingId);
  check('TA01', completed.steps.length === 2 && completed.steps.every(row => row.status === 'completed') && completed.route.actionStatus === 'applied',
    { agents: targets, steps: completed.steps.map(row => ({ target: row.step.target.agentIds, status: row.status, failure: row.failureCode, detail: row.failureDetail })) });
  const responses = completed.current.eventsBySession[sessionId].filter(row => row.metadata?.payload?.routingId === sent.routingId && row.type === 'agent_message');
  check('TA02', responses.length === 2 && targets.every(id => responses.some(row => row.fromAgentId === id)) && calls.filter(row => row.stage === 'success').length === 3 &&
    calls.every(row => row.tools.length === 0) && !completed.current.workItemsBySession?.[sessionId]?.length && !completed.current.briefsBySession?.[sessionId],
    { responders: responses.map(row => row.fromAgentId), sourceBound: responses.every(row => row.metadata.payload.replyToEventId === completed.route.sourceEventId), calls: calls.filter(row => row.stage === 'success') });
  const count = calls.length;
  const replay = (await api(server.apiBase, path, { method: 'POST', headers: { 'Idempotency-Key': key }, body })).data;
  check('TA03', replay.idempotentReplay && replay.routingId === sent.routingId && calls.length === count, { replay: true, modelCalls: count });
  stage = 'partial';
  const partial = (await api(server.apiBase, path, { method: 'POST', body })).data;
  const failed = await settled(sessionId, partial.routingId);
  check('TA04', failed.route.actionStatus === 'failed' && failed.steps.filter(row => row.status === 'completed').length === 1 && failed.steps.filter(row => row.status === 'failed').length === 1,
    { statuses: failed.steps.map(row => row.status), route: failed.route.actionStatus });
  const saved = await state(), dataFile = server.dataFile, beforeRestart = calls.length;
  await stopSmokeServer(server); server = undefined; await writeFile(dataFile, JSON.stringify(saved));
  server = await startSmokeServer('intent-targeted-answer-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: dataFile });
  const unusedSeed = server.dataFile; server.dataFile = dataFile; await rm(unusedSeed, { force: true });
  const restored = await state();
  check('TA05', calls.length === beforeRestart && restored.intentPlanStepsBySession[sessionId].length === saved.intentPlanStepsBySession[sessionId].length &&
    restored.intentRoutingRecordsBySession[sessionId].find(row => row.id === partial.routingId).actionStatus === 'failed', { realRestart: true, noDuplicateModelCall: true });
} finally {
  if (server) await stopSmokeServer(server);
  provider.closeAllConnections(); await new Promise(done => provider.close(done));
  await writeFile(resolve(directory, 'targeted-answer-http-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'Actual Sessions HTTP + Generic LLM + deterministic localhost provider + File persistence/restart, not model accuracy', results }, null, 2));
}
assert.equal(results.length, 5); assert.ok(results.every(row => row.passed));
