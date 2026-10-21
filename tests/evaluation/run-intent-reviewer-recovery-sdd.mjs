import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { api, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const message = '请整理登录实现的任务草稿。';
let server, stage = 'success', revisionWorkId, revisionText, failedProfile, recovered = false; const results = [], calls = [];
const check = (id, condition, actual) => { results.push({ id, passed: Boolean(condition), actual: structuredClone(actual) }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); };
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return response.writeHead(404).end();
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), prompt = JSON.stringify(input.messages), review = prompt.includes('Review the original draft and user modification as the assigned agent.'), brief = prompt.includes('brief_generation');
    const sourceEventId = prompt.match(/(?:Current source event ID|Source event): ([^\s"\\]+)/)?.[1]; assert.ok(sourceEventId);
    const profile = input.messages.find(row => row.role === 'system')?.content;
    if (review && !failedProfile) failedProfile = profile;
    calls.push({ failedTarget: review && profile === failedProfile, stage, brief, review, sourceEventId, tools: (input.tools ?? []).map(tool => tool.function?.name), repair: prompt.includes('Repair feedback') });
    if (stage === 'auth' && brief) return response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"fixture auth failure"}}');
    let output = brief ? { schemaVersion: '1.0', kind: 'task_brief', goal: '登录实现草稿', scope: ['登录'], outOfScope: [], constraints: [],
      acceptanceCriteria: ['核对需求'], risks: [], openQuestions: ['部署区域？'], suggestedTasks: [] }
      : { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
        segments: [{ localKey: 'initial', dialogueAct: 'command', goal: message, scopeRelation: 'initial_requirement', suggestedAction: 'create_initial_work_item', contextPolicy: 'clean_task_context',
          target: { workItemId: null, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null }, correction: null,
          requestedEffects: [], prohibitions: [], evidence: [{ refId: 'request', sourceEventId, start: 0, end: message.length, quote: message }], dependencies: [] }],
        missingFields: [], ambiguityReasons: [], modelConfidence: null };
    if (stage === 'revision' && !brief && !review) Object.assign(output.segments[0], { dialogueAct: 'knowledge_input', goal: revisionText,
      scopeRelation: 'same_requirement', suggestedAction: 'record_information', contextPolicy: 'inherit_confirmed',
      target: { workItemId: revisionWorkId, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
      evidence: [{ refId: 'request', sourceEventId, start: 0, end: revisionText.length, quote: revisionText }] });
    if (review) output = { schemaVersion: '1.0', kind: 'agent_message', messageKind: 'discussion', content: '请核对登录方案的部署边界。', targetAgentIds: [], targetAgentKeys: [], mentionedAgentIds: [], relatedTaskIds: [] };
    if (review && profile === failedProfile && !recovered) output = { kind: 'agent_message' };
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
  server = await startSmokeServer('intent-reviewer-recovery', environment);
  for (const role of ['intent_router', 'coordinator']) await api(server.apiBase, `/system-agent-runtime-policies/${role}`,
    { method: 'PATCH', body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const first = await createAndSettle(), original = first.current.briefsBySession[first.sessionId][0];
  revisionWorkId = original.workItemId;
  const post = async (path, body) => (await api(server.apiBase, path, { method: 'POST', body: JSON.stringify(body) })).data;
  const rawPost = (path, body) => fetch(`${server.apiBase}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const waitFor = async predicate => {
    const end = Date.now() + 30000;
    while (Date.now() < end) { const saved = await state(); if (predicate(saved)) return saved; await new Promise(done => setTimeout(done, 100)); }
    throw new Error('Timed out waiting for revision');
  };
  const session = (await api(server.apiBase, `/sessions/${first.sessionId}`)).data;
  const selected = session.participatingAgentIds.slice(0, 2); assert.equal(selected.length, 2);
  const assignedAgentKeys = selected.map(id => first.current.agents.find(row => row.id === id).key);
  const card = first.current.eventsBySession[first.sessionId].find(row => row.type === 'user_confirmation_requested');
  const request = { contractVersion: 'intent-brief-revise-v1', dataEpoch: session.dataEpoch, confirmationId: card.metadata.payload.confirmationId,
    expectedBriefVersion: original.version, expectedIntentRevision: original.intentBinding.intentRevision, idempotencyKey: randomUUID(),
    userMessage: '补充部署要求', assignedAgentKeys, questionAnswers: [{ question: '部署区域？', answer: '华东' }] };
  const path = `/sessions/${first.sessionId}/briefs/${encodeURIComponent(original.id)}/reject`;
  check('RV01', (await rawPost(path, { ...request, expectedBriefVersion: 99 })).status === 409 &&
    (await rawPost(path, { ...request, unknownField: true })).status === 400 && calls.length === 2,
    { staleAndUnknownInputRejectedBeforeModel: true });
  await post(`/sessions/${first.sessionId}/pause`, { reason: 'pause before structured revision' });
  stage = 'revision'; revisionText = '补充部署要求\n\n逐题回答：\n问题：部署区域？\n回答：华东';
  const accepted = await Promise.all([post(path, request), post(path, request)]);
  check('RV02', accepted[0].routingId === accepted[1].routingId && accepted.filter(row => row.idempotentReplay).length === 1,
    { sameRouting: true, once: true });
  const planned = await waitFor(saved => saved.intentPlanStepsBySession[first.sessionId].some(row => row.routingId === accepted[0].routingId && row.step.action === 'prepare_brief'));
  const queued = planned.intentPlanStepsBySession[first.sessionId].find(row => row.routingId === accepted[0].routingId && row.step.action === 'prepare_brief');
  check('RV03', queued.status === 'queued' && !queued.processing && planned.sessions.find(row => row.id === first.sessionId).status === 'PAUSED' &&
    planned.decisionRecordsBySession[first.sessionId].some(row => row.question === '部署区域？' && row.answer === '华东') &&
    calls.filter(row => row.stage === 'revision' && !row.brief && !row.review).length === 1, { answersBound: true, pausedWithoutGeneration: true });
  await post(`/sessions/${first.sessionId}/resume`, {});
  const partial = await waitFor(saved => {
    const steps = saved.intentPlanStepsBySession[first.sessionId].filter(row => row.routingId === accepted[0].routingId && row.step.action === 'review_brief');
    return steps.some(row => row.status === 'failed') && steps.some(row => row.status === 'completed');
  });
  const reviews = partial.intentPlanStepsBySession[first.sessionId].filter(row => row.routingId === accepted[0].routingId && row.step.action === 'review_brief');
  const failed = reviews.find(row => row.status === 'failed'), done = reviews.find(row => row.status === 'completed');
  check('RR08', partial.briefsBySession[first.sessionId].length === 1 && failed.processing.attemptsUsed === 2 && calls.filter(row => row.review && row.failedTarget).length === 2 && calls.filter(row => row.review && !row.failedTarget).length === 1,
    { failedBudgetBounded: true, successfulOpinionRetained: true, noPartialFinalDraft: true });
  const retryPath = `/sessions/${first.sessionId}/intent-plan-steps/${failed.id}`;
  const recovery = (await api(server.apiBase, `${retryPath}/brief-recovery`)).data;
  check('RR09', recovery.canRetry && recovery.action === 'review_brief' && recovery.reviewerId === failed.step.target.agentIds[0] && Boolean(recovery.reviewerName), { exactReviewerVisible: true });
  recovered = true;
  const retryRequest = { contractVersion: 'intent-brief-retry-v1', dataEpoch: session.dataEpoch, expectedRoutingRevision: recovery.routingRevision,
    expectedIntentRevision: recovery.intentRevision, expectedOperationId: recovery.operationId, idempotencyKey: randomUUID() };
  const retries = await Promise.all([post(`${retryPath}/retry-brief`, retryRequest), post(`${retryPath}/retry-brief`, retryRequest)]);
  check('RR10', retries[0].receipt.id === retries[1].receipt.id && retries.filter(row => row.idempotentReplay).length === 1 && retries[0].receipt.previous.processing.attemptsUsed === 2,
    { concurrentSingleReceipt: true, originalBudgetPreserved: true });
  const updatedState = await waitFor(saved => saved.briefsBySession[first.sessionId].length === 2), updated = updatedState.briefsBySession[first.sessionId][1];
  const unchanged = updatedState.intentPlanStepsBySession[first.sessionId].find(row => row.id === done.id);
  check('RR11', JSON.stringify(unchanged) === JSON.stringify(done) && calls.filter(row => row.review && !row.failedTarget).length === 1 && calls.filter(row => row.review && row.failedTarget).length === 3,
    { completedReviewerNotRepeated: true, failedReviewerOneNewCall: true });
  check('RV04', updated.openQuestions.length === 0 && updated.supersedesBriefId === original.id &&
    JSON.stringify(updatedState.briefsBySession[first.sessionId][0]) === JSON.stringify(original) && !(updatedState.tasksBySession?.[first.sessionId]?.length),
    { answeredQuestionRemoved: true, oldDraftRetained: true, noTasks: true });
  const reviewSteps = updatedState.intentPlanStepsBySession[first.sessionId].filter(row => row.routingId === accepted[0].routingId && row.step.action === 'review_brief');
  check('DR07', reviewSteps.length === 2 && reviewSteps.every(row => row.status === 'completed' && row.responseEventId && selected.includes(row.processing.result.agentId)) && calls.filter(row => row.review).length === 4 && calls.every(row => row.tools.length === 0), { twoBoundOpinions: true, noTools: true, finalAfterReviews: true });
  const currentCard = updatedState.eventsBySession[first.sessionId].find(row => row.type === 'user_confirmation_requested' && row.metadata.payload.relatedBriefId === updated.id);
  const confirmed = await post(`/sessions/${first.sessionId}/briefs/${encodeURIComponent(updated.id)}/confirm`, {
    contractVersion: 'intent-brief-confirm-v1', dataEpoch: session.dataEpoch, confirmationId: currentCard.metadata.payload.confirmationId,
    expectedBriefVersion: updated.version, expectedIntentRevision: updated.intentBinding.intentRevision, idempotencyKey: randomUUID() });
  check('RV05', confirmed.status === 'WAIT_WORKFLOW_SELECT', { newDraftConfirmable: true });
  const count = calls.length, saved = await state(), dataFile = server.dataFile;
  await stopSmokeServer(server); server = undefined; await writeFile(dataFile, JSON.stringify(saved));
  server = await startSmokeServer('intent-reviewer-recovery-restart', { ...environment, AGENT_CLUSTER_DATA_FILE: dataFile });
  const unused = server.dataFile; server.dataFile = dataFile; await rm(unused, { force: true });
  const replay = await post(path, request);
  const retryReplay = await post(`${retryPath}/retry-brief`, retryRequest);
  check('RR12', retryReplay.idempotentReplay && retryReplay.receipt.id === retries[0].receipt.id && calls.length === count, { retryReceiptSurvivesRestart: true, noRepeatedModelCall: true });
  check('RV06', replay.idempotentReplay && replay.routingId === accepted[0].routingId && calls.length === count,
    { realRestart: true, sameReceipt: true, noRepeatedModelCall: true });
} finally {
  if (server) await stopSmokeServer(server); provider.closeAllConnections(); await new Promise(done => provider.close(done));
  await writeFile(resolve(directory, 'reviewer-recovery-http-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'Actual Sessions HTTP/Nest/Generic LLM/File with deterministic provider and process restart; not model accuracy', results }, null, 2));
}
assert.equal(results.length, 12); assert.ok(results.every(row => row.passed));
