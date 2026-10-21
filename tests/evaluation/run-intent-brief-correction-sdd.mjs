import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const message = '请整理登录实现的任务草稿。';
let server, stage = 'success', correctionInput, correctionRouteId; const results = [], calls = [];
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
    if (stage === 'correction' && !brief) {
      const text = correctionInput.instruction;
      Object.assign(output.segments[0], { dialogueAct: correctionInput.supersedesDecisionId ? 'correction' : 'constraint', goal: text,
        scopeRelation: 'same_requirement', suggestedAction: 'correct_route', contextPolicy: 'inherit_confirmed',
        target: { workItemId: correctionInput.targetWorkItemId, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: correctionRouteId },
        correction: correctionInput.supersedesDecisionId ? { supersedesDecisionId: correctionInput.supersedesDecisionId,
          expectedDecisionRevision: correctionInput.expectedDecisionRevision, replacementText: text } : null,
        evidence: [{ refId: 'change', sourceEventId, start: 0, end: text.length, quote: text }] });
    }
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
  server = await startSmokeServer('intent-brief-correction', environment);
  for (const role of ['intent_router', 'coordinator']) await api(server.apiBase, `/system-agent-runtime-policies/${role}`,
    { method: 'PATCH', body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const first = await createAndSettle(), original = first.current.briefsBySession[first.sessionId][0];
  const post = async (path, body) => (await api(server.apiBase, path, { method: 'POST', body: JSON.stringify(body) })).data;
  const waitFor = async predicate => {
    const end = Date.now() + 30000;
    while (Date.now() < end) { const saved = await state(); if (predicate(saved)) return saved; await new Promise(done => setTimeout(done, 100)); }
    throw new Error('Timed out waiting for corrected Brief');
  };
  async function correct(text, oldDecision) {
    const saved = await state(), route = saved.intentRoutingRecordsBySession[first.sessionId].find(row => row.id === first.route.id);
    correctionRouteId = route.id; stage = 'correction';
    correctionInput = { contractVersion: 'intent-correction-v1', expectedRoutingRevision: route.routingRevision, idempotencyKey: randomUUID(),
      instruction: text, targetWorkItemId: saved.sessions.find(row => row.id === first.sessionId).activeWorkItemId,
      supersedesDecisionId: oldDecision?.id ?? null, expectedDecisionRevision: oldDecision?.revision ?? null };
    const path = `/sessions/${first.sessionId}/message-routings/${route.id}/corrections`;
    const accepted = await post(path, correctionInput);
    await waitFor(saved => saved.intentCorrectionsBySession[first.sessionId].find(row => row.id === accepted.correctionId)?.status === 'applied');
    return { path, request: structuredClone(correctionInput), accepted };
  }
  await correct('超时为 10 分钟');
  const ten = await waitFor(saved => saved.briefsBySession[first.sessionId].length === 2), previous = ten.briefsBySession[first.sessionId][1];
  check('BR01', previous.supersedesBriefId === original.id && previous.constraints.join() === '超时为 10 分钟', { version: previous.version, constraints: previous.constraints });
  const old = ten.decisionRecordsBySession[first.sessionId].find(row => row.content === '超时为 10 分钟');
  await post(`/sessions/${first.sessionId}/pause`, { reason: 'pause before correction' });
  const next = await correct('超时改为 30 分钟', old);
  const paused = await state(), pending = paused.intentPlanStepsBySession[first.sessionId].find(row => row.step.replacesBrief?.briefId === previous.id);
  const projected = (await api(server.apiBase, `/sessions/${first.sessionId}`)).data;
  check('BR02', pending.status === 'queued' && !pending.processing && projected.status === 'PAUSED' && projected.pauseState.previousStatus === 'REVISING_BRIEF' &&
    paused.sessionLifecyclesBySession[first.sessionId].admission === 'closed', { queuedWithoutBudget: !pending.processing, status: projected.status, previous: projected.pauseState.previousStatus });
  await post(`/sessions/${first.sessionId}/resume`, {});
  const updatedState = await waitFor(saved => saved.briefsBySession[first.sessionId].length === 3), updated = updatedState.briefsBySession[first.sessionId][2];
  check('BR03', updated.constraints.join() === '超时改为 30 分钟' && updated.supersedesBriefId === previous.id &&
    JSON.stringify(updatedState.briefsBySession[first.sessionId][1]) === JSON.stringify(previous) && !(updatedState.tasksBySession?.[first.sessionId]?.length),
    { version: updated.version, constraints: updated.constraints, historicalConstraints: previous.constraints, noTasks: true });
  const oldCard = updatedState.eventsBySession[first.sessionId].find(row => row.type === 'user_confirmation_requested' && row.metadata.payload.relatedBriefId === previous.id);
  const rejected = await fetch(`${server.apiBase}/sessions/${first.sessionId}/briefs/${encodeURIComponent(previous.id)}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contractVersion: 'intent-brief-confirm-v1', dataEpoch: projected.dataEpoch,
      confirmationId: oldCard.metadata.payload.confirmationId, expectedBriefVersion: previous.version,
      expectedIntentRevision: previous.intentBinding.intentRevision, idempotencyKey: randomUUID() }) });
  check('BR04', rejected.status === 409, { oldConfirmationStatus: rejected.status });
  const count = calls.length, saved = await state(), dataFile = server.dataFile;
  await stopSmokeServer(server); server = undefined; await writeFile(dataFile, JSON.stringify(saved));
  server = await startSmokeServer('intent-brief-correction-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: dataFile });
  const unused = server.dataFile; server.dataFile = dataFile; await rm(unused, { force: true });
  const replay = await post(next.path, next.request), restored = (await api(server.apiBase, `/sessions/${first.sessionId}/briefs`)).data;
  check('BR05', replay.correctionId === next.accepted.correctionId && restored.length === 3 && calls.length === count,
    { realRestart: true, noRepeatedCalls: calls.length === count, briefVersions: restored.length });
  const currentCard = saved.eventsBySession[first.sessionId].find(row => row.type === 'user_confirmation_requested' && row.metadata.payload.relatedBriefId === updated.id);
  const confirmed = await post(`/sessions/${first.sessionId}/briefs/${encodeURIComponent(updated.id)}/confirm`, {
    contractVersion: 'intent-brief-confirm-v1', dataEpoch: projected.dataEpoch, confirmationId: currentCard.metadata.payload.confirmationId,
    expectedBriefVersion: updated.version, expectedIntentRevision: updated.intentBinding.intentRevision, idempotencyKey: randomUUID() });
  check('BR06', confirmed.status === 'WAIT_WORKFLOW_SELECT' && confirmed.receipt.request.expectedBriefVersion === 3 &&
    !(await state()).tasksBySession?.[first.sessionId]?.length, { confirmedVersion: 3, noTasks: true });
} finally {
  if (server) await stopSmokeServer(server); provider.closeAllConnections(); await new Promise(done => provider.close(done));
  await writeFile(resolve(directory, 'brief-correction-http-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'Actual Sessions HTTP/Nest/Generic LLM/File with deterministic provider and process restart; not model accuracy', results }, null, 2));
}
assert.equal(results.length, 6); assert.ok(results.every(row => row.passed));
