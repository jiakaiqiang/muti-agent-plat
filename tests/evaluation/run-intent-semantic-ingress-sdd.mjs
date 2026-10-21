import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const persisted = resolve('.cache/agent-cluster', `semantic-ingress-${randomUUID()}.json`);
const results = [], requests = [];
const withCorrections = process.argv.includes('--corrections');
let correctionTarget, decisionTarget, workTarget;
let mode = 'answer', message = '解释当前系统的意图路由', server, stateFile, release;
const gate = new Promise(resolve => { release = resolve; });
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), prompt = JSON.stringify(input.messages);
    const semantic = prompt.includes('Return only intent_understanding@1.0');
    const answering = prompt.includes('user_message_response');
    const sourceEventId = prompt.match(/Current source event ID: ([^\s"\\]+)/)?.[1];
    requests.push({ semantic, answering, sourceEventId, tools: input.tools ?? [], mode });
    if (requests.length === 1) await gate;
    if (mode === 'auth') { response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'fixture authentication failure' } })); return; }
    let output;
    if (semantic) output = { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
      segments: [{ localKey: 'message', dialogueAct: mode === 'task' ? 'command' : 'question', goal: message,
        scopeRelation: mode === 'task' ? 'initial_requirement' : 'session_context', suggestedAction: mode === 'task' ? 'create_initial_work_item' : 'answer_in_chat',
        target: { workItemId: null, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
        correction: null, contextPolicy: 'clean_task_context', requestedEffects: mode === 'task' ? [] : [{ kind: 'answer', target: { kind: 'unresolved', refId: null }, evidenceRefs: ['request'] }],
        prohibitions: [], evidence: [{ refId: 'request', sourceEventId, start: 0, end: message.length, quote: message }], dependencies: [] }],
      missingFields: [], ambiguityReasons: [], modelConfidence: null };
    else if (answering) output = { schemaVersion: '1.0', kind: 'agent_message', messageKind: 'answer', content: `回答：${message}`,
      targetAgentIds: [], targetAgentKeys: [], mentionedAgentIds: [], relatedTaskIds: [] };
    else throw new Error('Unexpected legacy business invocation');
    if (semantic && ['constraint', 'correction', 'foreign-correction'].includes(mode)) {
      const segment = output.segments[0];
      Object.assign(segment, { dialogueAct: mode === 'constraint' ? 'constraint' : 'correction', scopeRelation: 'same_requirement',
        suggestedAction: mode === 'constraint' ? 'record_constraint' : 'correct_route', contextPolicy: 'inherit_confirmed', requestedEffects: [] });
      segment.target.workItemId = workTarget;
      if (mode !== 'constraint') {
        segment.target.correctionOfRoutingId = mode === 'foreign-correction' ? 'foreign-routing' : correctionTarget;
        segment.correction = { supersedesDecisionId: decisionTarget.id, expectedDecisionRevision: decisionTarget.revision, replacementText: message };
      }
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
});
const port = await findFreePort(); await new Promise(resolve => provider.listen(port, '127.0.0.1', resolve));
const env = { GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm', INTENT_UNDERSTANDING_ENABLED: 'true', INTENT_ROUTING_MODE: 'enforce_all_current_epoch', ENABLE_BULLMQ: 'false',
  LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'semantic-ingress-fixture', LLM_API_KEY: 'fixture-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false' };
async function state() { return JSON.parse(await readFile(stateFile, 'utf8')); }
async function until(read, predicate) { const deadline = Date.now() + 30_000; let value;
  do { value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${JSON.stringify(value?.intentRoutingRecordsBySession ? { routes: Object.values(value.intentRoutingRecordsBySession).flat().map(row => ({ id: row.id, status: row.status, reasons: row.reasonCodes })), corrections: value.intentCorrectionsBySession } : value)}`); }
async function record(id, condition, actual) { results.push({ id, passed: Boolean(condition), actual: structuredClone(actual) }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); }
try {
  server = await startSmokeServer('semantic-ingress', env); stateFile = server.dataFile;
  for (const role of ['intent_router', 'coordinator']) await api(server.apiBase, `/system-agent-runtime-policies/${role}`, { method: 'PATCH', body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const created = (await api(server.apiBase, '/sessions', { method: 'POST', body: JSON.stringify({ input: message }) })).data;
  const sessionId = created.session.id;
  await until(async () => requests, rows => rows.length === 1);
  const pending = await state();
  await record('IN01', created.routingId && created.session.intentContractVersion === 'intent-understanding-v1' &&
    !(pending.workItemsBySession?.[sessionId]?.length) && !pending.briefsBySession?.[sessionId] &&
    pending.logicalOperationsBySession[sessionId].every(row => row.admissionClass === 'routing'),
    { routingId: created.routingId, workItems: pending.workItemsBySession?.[sessionId]?.length ?? 0, briefs: pending.briefsBySession?.[sessionId]?.length ?? 0, requests });
  release();
  const answered = await until(state, value => value.intentPlanStepsBySession?.[sessionId]?.[0]?.status === 'completed');
  await record('IN02', !(answered.workItemsBySession?.[sessionId]?.length) && !answered.briefsBySession?.[sessionId] &&
    answered.eventsBySession[sessionId].filter(row => row.id.startsWith('intent-answer:')).length === 1 && requests.length === 2 && requests.every(row => row.tools.length === 0),
    { step: answered.intentPlanStepsBySession[sessionId][0].status, requests });
  const key = randomUUID(), messagesPath = `/sessions/${sessionId}/messages`;
  message = '解释意图纠错的重试规则';
  const sent = (await api(server.apiBase, messagesPath, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ content: message }) })).data;
  const second = await until(state, value => value.intentPlanStepsBySession?.[sessionId]?.filter(row => row.status === 'completed').length === 2);
  await record('IN03', sent.routingId && second.intentRoutingRecordsBySession[sessionId].length === 2 && !(second.followUpMessagesBySession?.[sessionId]?.length) &&
    !second.workItemsBySession?.[sessionId]?.length, { routingId: sent.routingId, routeCount: second.intentRoutingRecordsBySession[sessionId].length, requests: requests.length });
  await writeFile(persisted, await readFile(stateFile)); await stopSmokeServer(server); server = undefined;
  server = await startSmokeServer('semantic-ingress-restart', { ...env, INTENT_UNDERSTANDING_ENABLED: 'false', INTENT_ROUTING_MODE: 'disabled',
    AGENT_CLUSTER_WORKITEM_MIGRATION_MODE: 'apply', AGENT_CLUSTER_DATA_FILE: persisted }); stateFile = persisted;
  const count = requests.length;
  const replay = (await api(server.apiBase, messagesPath, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ content: message }) })).data;
  await record('IN04', replay.idempotentReplay && replay.routingId === sent.routingId && requests.length === count && !(await state()).workItemsBySession?.[sessionId]?.length,
    { replay: replay.idempotentReplay, sameRouting: replay.routingId === sent.routingId, requests: requests.length });
  const conflict = await fetch(`${server.apiBase}${messagesPath}`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ content: '同一个键改变内容' }) });
  await record('IN05', conflict.status === 409, { status: conflict.status });
  mode = 'task'; message = '创建一个登录需求的任务上下文';
  const task = (await api(server.apiBase, messagesPath, { method: 'POST', body: JSON.stringify({ content: message }) })).data;
  const taskState = await until(state, value => value.workItemsBySession?.[sessionId]?.length === 1);
  const projected = (await api(server.apiBase, `/sessions/${sessionId}`)).data;
  await record('IN06', projected.activeWorkItemId === taskState.workItemsBySession[sessionId][0].id && !taskState.briefsBySession?.[sessionId] &&
    taskState.intentRouteRevisionsBySession[sessionId].some(row => row.routingId === task.routingId),
    { activeWorkItemId: projected.activeWorkItemId, works: taskState.workItemsBySession[sessionId].length, briefs: Boolean(taskState.briefsBySession?.[sessionId]) });
  if (withCorrections) {
    workTarget = taskState.workItemsBySession[sessionId][0].id;
    mode = 'constraint'; message = '超时为 10 分钟';
    const constraint = (await api(server.apiBase, messagesPath, { method: 'POST', body: JSON.stringify({ content: message }) })).data;
    const constrained = await until(state, value => value.decisionRecordsBySession?.[sessionId]?.some(row => row.content === message));
    decisionTarget = constrained.decisionRecordsBySession[sessionId].find(row => row.content === message);
    correctionTarget = constraint.routingId;
    const postCorrection = async (key, replyToEventId) => (await api(server.apiBase, messagesPath, { method: 'POST',
      headers: { 'Idempotency-Key': key }, body: JSON.stringify({ content: message, replyToEventId }) })).data;
    const correctionKey = randomUUID(); mode = 'correction'; message = '超时改为 30 分钟'; const beforeCorrection = requests.length;
    const corrected = await postCorrection(correctionKey, constraint.event.id);
    const applied = await until(state, value => value.intentCorrectionsBySession?.[sessionId]?.some(row => row.originRoutingId === corrected.routingId && row.status === 'applied'));
    const correction = applied.intentCorrectionsBySession[sessionId].find(row => row.originRoutingId === corrected.routingId);
    await record('SC01', requests.length === beforeCorrection + 2 && correction.processing.attemptsUsed === 2 &&
      correction.sourceEventId === corrected.event.id && !correction.originFollowUpId &&
      applied.decisionRecordsBySession[sessionId].find(row => row.id === decisionTarget.id).status === 'superseded' &&
      !applied.workItemsBySession[sessionId][0].dispatchHold && !applied.briefsBySession?.[sessionId],
      { requests: requests.length - beforeCorrection, status: correction.status, version: correction.pendingIntentRevision, attempts: correction.processing.attemptsUsed });
    const beforeReplay = requests.length;
    const repeated = await postCorrection(correctionKey, constraint.event.id);
    await record('SC02', repeated.idempotentReplay && repeated.routingId === corrected.routingId && requests.length === beforeReplay &&
      (await state()).intentCorrectionsBySession[sessionId].length === 1, { replay: repeated.idempotentReplay, requestDelta: requests.length - beforeReplay });
    decisionTarget = applied.decisionRecordsBySession[sessionId].find(row => row.status === 'confirmed' && row.sourceEventId === corrected.event.id);
    message = '超时改为 45 分钟'; const next = await postCorrection(randomUUID(), corrected.event.id);
    const nextState = await until(state, value => value.intentCorrectionsBySession?.[sessionId]?.some(row => row.originRoutingId === next.routingId && row.status === 'applied'));
    const nextCorrection = nextState.intentCorrectionsBySession[sessionId].find(row => row.originRoutingId === next.routingId);
    await record('SC03', nextCorrection.routingId === correctionTarget && nextCorrection.pendingIntentRevision === 3 &&
      nextState.decisionRecordsBySession[sessionId].filter(row => row.status === 'confirmed').length === 1 &&
      !(nextState.followUpMessagesBySession?.[sessionId]?.length), { routingId: nextCorrection.routingId, version: nextCorrection.pendingIntentRevision });
    decisionTarget = nextState.decisionRecordsBySession[sessionId].find(row => row.status === 'confirmed');
    mode = 'foreign-correction'; message = '超时改为 60 分钟'; const beforeForeign = requests.length;
    const foreign = await postCorrection(randomUUID(), next.event.id);
    const clarified = await until(state, value => value.intentRoutingRecordsBySession[sessionId].find(row => row.id === foreign.routingId)?.status === 'CLARIFICATION_REQUIRED');
    await record('SC04', requests.length === beforeForeign + 1 && clarified.intentCorrectionsBySession[sessionId].length === 2 &&
      !clarified.workItemsBySession[sessionId][0].dispatchHold && clarified.decisionRecordsBySession[sessionId].find(row => row.id === decisionTarget.id).status === 'confirmed',
      { requestDelta: requests.length - beforeForeign, corrections: clarified.intentCorrectionsBySession[sessionId].length, status: 'CLARIFICATION_REQUIRED' });
  }
  mode = 'auth'; message = '请说明新的问题'; const beforeAuth = requests.length;
  const failed = (await api(server.apiBase, messagesPath, { method: 'POST', body: JSON.stringify({ content: message }) })).data;
  const blocked = await until(state, value => value.intentRoutingRecordsBySession?.[sessionId]?.find(row => row.id === failed.routingId)?.status === 'BLOCKED');
  await record('IN07', requests.length === beforeAuth + 1 && blocked.workItemsBySession[sessionId].length === 1 && !blocked.briefsBySession?.[sessionId] &&
    blocked.logicalOperationsBySession[sessionId].every(row => ['routing', 'response'].includes(row.admissionClass)),
    { requestDelta: requests.length - beforeAuth, route: blocked.intentRoutingRecordsBySession[sessionId].find(row => row.id === failed.routingId).status });

} finally {
  release(); if (server) await stopSmokeServer(server);
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  await writeFile(resolve(directory, withCorrections ? 'semantic-correction-http-results.json' : 'semantic-ingress-http-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'actual Sessions create/messages API, process restart, isolated File, Generic LLM HTTP with deterministic localhost fixture; explicit new-contract cohort', results }, null, 2));
  await rm(persisted, { force: true });
}
if (results.length !== (withCorrections ? 11 : 7) || results.some(row => !row.passed)) process.exitCode = 1;
