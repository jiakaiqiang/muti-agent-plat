import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { api, createSessionAndWaitForBrief, findFreePort, startSmokeServer, stopSmokeServer } from '../e2e/smoke-server.mjs';
import { PersistenceService } from '../../apps/server/dist/apps/server/src/modules/persistence/persistence.service.js';
import { ContextManagementService } from '../../apps/server/dist/apps/server/src/modules/context-management/context-management.service.js';

const out = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const resultName = process.argv.includes('--semantic-proposal') ? 'semantic-proposal-chat-http-results.json' : 'chat-correction-http-results.json';
const stateFile = resolve('.cache/agent-cluster', `intent-chat-correction-${randomUUID()}.json`);
const results = [], requests = [];
let server, sessionId, routingId, workId, old, originalStatus, release;
let mode = 'correction';
let instruction = '超时改为 30 分钟，原 10 分钟作废。';
const gate = new Promise(resolve => { release = resolve; });
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), text = JSON.stringify(body.messages);
    const semantic = text.includes('Return only intent_understanding@1.0');
    const sourceEventId = text.match(/Current source event ID: ([^\s"\\]+)/)?.[1];
    requests.push({ kind: semantic ? 'correction_validation' : 'message_classification', tools: body.tools ?? [], sourceEventId, mode });
    let output;
    if (semantic) {
      assert.ok(sourceEventId); await gate;
      output = { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
        segments: [{ localKey: 'timeout', dialogueAct: 'correction', goal: instruction, scopeRelation: 'same_requirement',
          suggestedAction: 'correct_route', contextPolicy: 'inherit_confirmed',
          target: { workItemId: workId, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: routingId },
          correction: { supersedesDecisionId: old.id, expectedDecisionRevision: old.revision, replacementText: instruction },
          requestedEffects: [], prohibitions: [], dependencies: [],
          evidence: [{ refId: 'current', sourceEventId, start: 0, end: instruction.length, quote: instruction }] }],
        missingFields: [], ambiguityReasons: [], modelConfidence: 0.99 };
    } else output = { schemaVersion: '1.0', kind: 'intent_routing_decision', dialogueAct: 'correction', scopeRelation: 'same_requirement',
      contextPolicy: 'inherit_confirmed', requestedAction: 'continue_active_work_item', selectedWorkItemId: workId,
      selectedDecisionIds: mode === 'correction' ? [old.id] : [], selectedArtifactIds: [], requestedAgentIds: [],
      goalSegments: [mode === 'correction' ? instruction : '你理解错了'], missingFields: [], ambiguityReasons: [], reasonCodes: [], riskLevel: 'low', modelConfidence: 0.99 };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
});
const port = await findFreePort();
await new Promise(resolve => provider.listen(port, '127.0.0.1', resolve));
const env = { DISCUSSION_MAX_ROUNDS: '0', GLOBAL_DEFAULT_RUNTIME_TYPE: 'mock', INTENT_ROUTING_MODE: 'enforce_all_current_epoch', ENABLE_BULLMQ: 'false',
  LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'chat-correction-fixture', LLM_API_KEY: 'fixture-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
  LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false' };
async function record(id, actual, condition) { results.push({ id, passed: Boolean(condition), actual: structuredClone(actual) }); console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id); }
async function until(read, predicate) {
  const deadline = Date.now() + 30_000;
  let value;
  do { value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${JSON.stringify(value)}`);
}
try {
  server = await startSmokeServer('chat-correction-bootstrap', env);
  ({ sessionId } = await createSessionAndWaitForBrief(server.apiBase, '实现登录功能。', { runtimePreference: { preferredRuntimeType: 'mock', allowedRuntimeTypes: ['mock'] } }));
  await writeFile(stateFile, await readFile(server.dataFile));
  await stopSmokeServer(server); server = undefined;
  const persistence = new PersistenceService({ backend: 'file', filePath: stateFile }); await persistence.initialize();
  try {
    const context = new ContextManagementService(persistence);
    const session = persistence.getCollection('sessions', []).find(row => row.id === sessionId);
    originalStatus = session.status; workId = session.activeWorkItemId;
    const sourceEventId = 'chat-fixture-original';
    old = await context.recordDecision({ session, workItemId: workId, sourceEventId, kind: 'constraint', content: '超时为 10 分钟' });
    const event = { id: sourceEventId, sessionId, type: 'user_message', content: old.content, toAgentIds: [], actor: { type: 'user', id: session.ownerId },
      createdAt: new Date().toISOString(), metadata: { schemaVersion: '0.1', renderAs: 'chat_message' } };
    await persistence.mutateCollections(['eventsBySession'], draft => { (draft.eventsBySession[sessionId] ??= []).push(event); });
    const route = await context.createRoutingRecord({ session, sourceEventId, idempotencyKey: sourceEventId, rolloutMode: 'enforce_all_current_epoch' }); routingId = route.id;
    await context.saveFollowUp(sessionId, { id: 'original-follow', routingId, workItemId: workId, sourceEventId, content: old.content,
      status: 'completed', mentionedAgentIds: [], queuedAt: event.createdAt,
      handlingPlan: { intent: 'constraint', priority: 'normal', shouldPause: false, affectedTaskIds: [], affectedAgentIds: [], requiresBriefRevision: false, requiresUserConfirmation: false, coordinatorInstruction: '' } });
    for (const status of ['SNAPSHOT_READY', 'CLASSIFYING', 'VALIDATING', 'APPLYING', 'ROUTED']) {
      await context.updateRoutingRecord(sessionId, routingId, { status });
    }
  } finally { await persistence.onModuleDestroy(); }
  server = await startSmokeServer('chat-correction-http', { ...env, AGENT_CLUSTER_DATA_FILE: stateFile });
  await api(server.apiBase, '/system-agent-runtime-policies/intent_router', { method: 'PATCH', body: JSON.stringify({ preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] }) });
  const key = randomUUID(), messagesPath = `/sessions/${sessionId}/messages`, routePath = `/sessions/${sessionId}/message-routings/${routingId}`;
  const firstInstruction = instruction;
  const sent = (await api(server.apiBase, messagesPath, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ content: instruction }) })).data;
  const history = await until(async () => (await api(server.apiBase, `${routePath}/corrections`)).data,
    value => value.corrections.length > 0 && requests.some(row => row.kind === 'correction_validation')).catch(async error => {
      console.log(JSON.stringify({ sourceRouting: (await api(server.apiBase, `/sessions/${sessionId}/message-routings/${sent.routingId}`)).data, requests }));
      throw error;
    });
  const accepted = history.corrections[0], held = (await api(server.apiBase, routePath)).data;
  await record('CC01', { sourceRoutingId: sent.routingId, originalRoutingId: routingId, sourceEventId: sent.event.id,
    correctionSourceEventId: accepted.sourceEventId, status: accepted.status, hold: held.dispatchHold },
    accepted.originRoutingId === sent.routingId && accepted.sourceEventId === sent.event.id && accepted.status !== 'applied' && held.dispatchHold?.correctionId === accepted.id);
  release();
  const activated = await until(async () => (await api(server.apiBase, `${routePath}/corrections`)).data,
    value => ['applied', 'rejected', 'clarification_required', 'reconciliation_required'].includes(value.corrections[0]?.status));
  await record('CC02', { status: activated.corrections[0].status, reasons: activated.corrections[0].reasonCodes, requests },
    activated.corrections[0].status === 'applied' && requests.length === 2 && requests.every(row => row.tools.length === 0));
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  const sourceOperation = saved.logicalOperationsBySession[sessionId].find(row => row.id === sent.routingId);
  const correctionOperation = saved.logicalOperationsBySession[sessionId].find(row => row.parentId === sent.routingId);
  await record('CC03', { attempts: activated.corrections[0].processing.attemptsUsed, sourceDeadline: sourceOperation.deadlineAt,
    correctionDeadline: correctionOperation.deadlineAt, ledgerDeadline: activated.corrections[0].processing.deadlineAt, parentId: correctionOperation.parentId },
    activated.corrections[0].processing.attemptsUsed === 2 && correctionOperation.deadlineAt === activated.corrections[0].processing.deadlineAt &&
    Date.parse(correctionOperation.deadlineAt) <= Date.parse(sourceOperation.deadlineAt) &&
    sourceOperation.attemptsUsed + correctionOperation.attemptsUsed === 2);
  const decisions = saved.decisionRecordsBySession[sessionId];
  await record('CC04', { old: decisions.find(row => row.id === old.id)?.status,
    replacement: decisions.find(row => row.supersedesDecisionId === old.id)?.content,
    sourceFollowUp: saved.followUpMessagesBySession[sessionId].find(row => row.routingId === sent.routingId)?.status,
    sessionStatus: saved.sessions.find(row => row.id === sessionId)?.status },
    decisions.find(row => row.id === old.id)?.status === 'superseded' && decisions.some(row => row.supersedesDecisionId === old.id && row.content === instruction) &&
    saved.followUpMessagesBySession[sessionId].find(row => row.routingId === sent.routingId)?.status === 'cancelled' &&
    saved.sessions.find(row => row.id === sessionId)?.status === originalStatus &&
    saved.eventsBySession[sessionId].filter(row => row.type === 'user_message' && row.content === instruction).length === 1);
  old = decisions.find(row => row.supersedesDecisionId === old.id);
  instruction = '超时改为 45 分钟，原 30 分钟作废。';
  const second = (await api(server.apiBase, messagesPath, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ content: instruction }) })).data;
  const revisedAgain = await until(async () => (await api(server.apiBase, `${routePath}/corrections`)).data,
    value => value.corrections.length === 2 && value.corrections.every(row => ['applied', 'rejected', 'clarification_required', 'reconciliation_required'].includes(row.status)));
  const secondRoute = (await api(server.apiBase, `/sessions/${sessionId}/message-routings/${second.routingId}`)).data;
  const twiceSaved = JSON.parse(await readFile(stateFile, 'utf8'));
  const secondDecisions = twiceSaved.decisionRecordsBySession[sessionId];
  const latestConstraint = secondDecisions.find(row => row.supersedesDecisionId === old.id);
  await record('CC07', { statuses: revisedAgain.corrections.map(row => row.status), revisions: revisedAgain.revisions.length,
    canonicalRoutingId: secondRoute.correctionTargetRoutingId, modelRequests: requests.length,
    previousStatus: secondDecisions.find(row => row.id === old.id)?.status, replacement: latestConstraint?.content },
    revisedAgain.corrections.every(row => row.status === 'applied') && revisedAgain.revisions.length === 3 &&
    secondRoute.correctionTargetRoutingId === routingId && requests.length === 4 &&
    secondDecisions.find(row => row.id === old.id)?.status === 'superseded' && latestConstraint?.status === 'confirmed' && latestConstraint?.content === instruction);
  mode = 'ambiguous';
  const unclear = (await api(server.apiBase, messagesPath, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ content: '你理解错了' }) })).data;
  const unclearRoute = await until(async () => (await api(server.apiBase, `/sessions/${sessionId}/message-routings/${unclear.routingId}`)).data,
    value => ['CLARIFICATION_REQUIRED', 'BLOCKED', 'ROUTED'].includes(value.status));
  const afterUnclear = (await api(server.apiBase, `${routePath}/corrections`)).data;
  const afterUnclearSaved = JSON.parse(await readFile(stateFile, 'utf8'));
  const nextContext = afterUnclearSaved.contextSnapshotsBySession[sessionId].find(row => row.id === unclearRoute.snapshotId);
  await record('CC05', { status: unclearRoute.status, reasons: unclearRoute.reasonCodes, correctionCount: afterUnclear.corrections.length,
    modelRequests: requests.length, contextDecisionIds: nextContext.validDecisions.map(row => row.id) },
    unclearRoute.status === 'CLARIFICATION_REQUIRED' && unclearRoute.reasonCodes.includes('CORRECTION_TARGET_REQUIRED') && afterUnclear.corrections.length === 2 && requests.length === 5 &&
    nextContext.validDecisions.some(row => row.id === latestConstraint.id && row.content === instruction) &&
    !nextContext.validDecisions.some(row => row.id === old.id || row.content === '超时为 10 分钟'));
  await stopSmokeServer(server); server = undefined;
  server = await startSmokeServer('chat-correction-restart', { ...env, AGENT_CLUSTER_DATA_FILE: stateFile });
  const replay = (await api(server.apiBase, messagesPath, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ content: firstInstruction }) })).data;
  await record('CC06', { sourceEventId: replay.event.id, routingId: replay.routingId, idempotentReplay: replay.idempotentReplay, modelRequests: requests.length },
    replay.event.id === sent.event.id && replay.routingId === sent.routingId && replay.idempotentReplay && requests.length === 5);
} finally {
  release();
  await writeFile(resolve(out, resultName), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'actual messages API + Generic LLM HTTP to deterministic local fixture, isolated File state, actual process restart; not semantic accuracy', results }, null, 2));
  if (server) await stopSmokeServer(server);
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(stateFile, { force: true });
}
if (results.length !== 7 || results.some(row => !row.passed)) process.exitCode = 1;
