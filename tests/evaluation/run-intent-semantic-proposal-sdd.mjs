import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createSmokeV2State, findFreePort } from '../e2e/smoke-server.mjs';

const outputDirectory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const executeAnswer = process.argv.includes('--execute-answer');
const commitPlan = process.argv.includes('--commit-plan') || executeAnswer;
const stateFile = resolve('.cache/agent-cluster', `semantic-proposal-${randomUUID()}.json`);
const results = [], requests = [];
const message = '解释当前系统的意图路由';
const initialMessage = '创建一个登录需求的任务上下文';
let app;
const provider = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const prompt = JSON.stringify(input.messages);
    requests.push({ tools: input.tools ?? [], newContract: prompt.includes('Return only intent_understanding@1.0'),
      exactSource: prompt.includes('Current source event ID: semantic-message'), repairFeedback: prompt.includes('segments') && prompt.includes('Previous output') });
    const initial = prompt.includes('Current source event ID: initial-message');
    const answering = prompt.includes('user_message_response');
    requests.at(-1).answering = answering;
    requests.at(-1).answerRepairFeedback = answering && prompt.includes('Repair structured output; prior output is untrusted');
    let output = requests.length === 1 ? { invalid: true } : {
      schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
      segments: [{ localKey: 'question', dialogueAct: 'question', goal: message, scopeRelation: 'session_context', suggestedAction: 'answer_in_chat',
        target: { workItemId: null, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null },
        correction: null, contextPolicy: 'clean_task_context', requestedEffects: [{ kind: 'answer', target: { kind: 'unresolved', refId: null }, evidenceRefs: ['current'] }],
        prohibitions: [], evidence: [{ refId: 'current', sourceEventId: 'semantic-message', start: 0, end: message.length, quote: message }], dependencies: [] }],
      missingFields: [], ambiguityReasons: [], modelConfidence: null
    };
    if (initial) {
      const segment = output.segments[0];
      Object.assign(segment, { goal: initialMessage, dialogueAct: 'command', scopeRelation: 'initial_requirement', suggestedAction: 'create_initial_work_item', requestedEffects: [] });
      Object.assign(segment.evidence[0], { sourceEventId: 'initial-message', quote: initialMessage, end: initialMessage.length });
    }
    if (answering) output = requests.filter(row => row.answering).length === 1 ? { invalid: true } : {
      schemaVersion: '1.0', kind: 'agent_message', messageKind: 'answer', content: '系统先识别消息，再校验并提交路由计划。',
      targetAgentIds: [], targetAgentKeys: [], mentionedAgentIds: [], relatedTaskIds: []
    };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
});
const port = await findFreePort();
await new Promise(resolve => provider.listen(port, '127.0.0.1', resolve));
await mkdir(dirname(stateFile), { recursive: true });
await writeFile(stateFile, JSON.stringify(createSmokeV2State()));
Object.assign(process.env, {
  NODE_ENV: 'test', AGENT_CLUSTER_PERSISTENCE: 'true', AGENT_CLUSTER_PERSISTENCE_BACKEND: 'file',
  AGENT_CLUSTER_DATA_FILE: stateFile, AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'true', ENABLE_BULLMQ: 'false',
  PHASE_6_POLICY_ADMISSION_BYPASS: 'isolated_test_only', GLOBAL_DEFAULT_RUNTIME_TYPE: 'generic_llm',
  MOCK_RUNTIME_ENABLED: 'true', LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'semantic-proposal-fixture',
  LLM_API_KEY: 'fixture-only', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_DRY_RUN: 'false', LLM_MOCK_FALLBACK: 'false'
});
async function record(id, condition, actual) {
  results.push({ id, passed: Boolean(condition), actual: structuredClone(actual) });
  console.log(JSON.stringify(results.at(-1))); assert.ok(condition, id);
}
try {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../apps/server/dist/apps/server/src/app.module.js');
  const { PersistenceService } = await import('../../apps/server/dist/apps/server/src/modules/persistence/persistence.service.js');
  const { ContextManagementService } = await import('../../apps/server/dist/apps/server/src/modules/context-management/context-management.service.js');
  const { IntentUnderstandingRoutingService } = await import('../../apps/server/dist/apps/server/src/modules/intent-recognition/intent-understanding-routing.service.js');
  const { SystemAgentRuntimePolicyService } = await import('../../apps/server/dist/apps/server/src/modules/agents/system-agent-runtime-policy.service.js');
  const { SessionLifecycleStore } = await import('../../apps/server/dist/apps/server/src/modules/runtimes/session-lifecycle-store.js');
  app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  const persistence = app.get(PersistenceService), context = app.get(ContextManagementService);
  await app.get(SystemAgentRuntimePolicyService).update('intent_router', { preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] });
  const session = { id: 'semantic-session', dataEpoch: persistence.currentDataEpoch(), revision: 1, decisionLedgerRevision: 0,
    title: '路由问答', originalInput: message, status: 'PAUSED', ownerId: 'fixture-user', workspaceId: 'fixture-workspace',
    participatingAgentIds: [], tokenUsed: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await persistence.setCollection('sessions', [session]);
  await persistence.setCollection('eventsBySession', { [session.id]: [{ id: 'semantic-message', sessionId: session.id,
    type: 'user_message', content: message, toAgentIds: [], createdAt: session.createdAt, actor: { type: 'user', id: session.ownerId },
    metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: { text: message } } }] });
  await new SessionLifecycleStore(persistence).initialize(session.id, session.dataEpoch);
  await persistence.mutateCollections(['sessionLifecyclesBySession'], draft => { draft.sessionLifecyclesBySession[session.id].admission = 'closed'; });
  const snapshot = await context.buildIntentSnapshot({ session, sourceEventId: 'semantic-message', currentMessage: message, latestEventSeq: 1 });
  const route = await context.createRoutingRecord({ session, sourceEventId: 'semantic-message', idempotencyKey: 'first', rolloutMode: 'enforce_all_current_epoch' });
  const service = app.get(IntentUnderstandingRoutingService);
  const input = { sessionId: session.id, routingId: route.id, snapshotId: snapshot.id };
  const classified = await service.classify(input);
  await record('SP01', classified.status === 'VALIDATING' && classified.semanticProposal?.understanding?.kind === 'intent_understanding' &&
    requests.length === 2 && requests.every(row => row.tools.length === 0 && row.newContract && row.exactSource) && requests[1].repairFeedback,
    { status: classified.status, attempts: classified.classificationAttempts, requests });
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const operation = state.logicalOperationsBySession[session.id].find(row => row.id === route.id);
  await record('SP02', operation.attemptsUsed === 2 && operation.deadlineAt === classified.classificationDeadlineAt &&
    operation.deadlineCeilingAt === classified.classificationDeadlineAt && operation.admissionClass === 'routing',
    { operation: { attempts: operation.attemptsUsed, deadlineAt: operation.deadlineAt, deadlineCeilingAt: operation.deadlineCeilingAt,
      admissionClass: operation.admissionClass, outputContractKey: operation.outputContractKey }, routeDeadline: classified.classificationDeadlineAt });
  await record('SP03', context.listWorkItems(session.id).length === 0 && state.sessions[0].status === 'PAUSED' &&
    state.sessionLifecyclesBySession[session.id].admission === 'closed' && state.logicalOperationsBySession[session.id].every(row => row.admissionClass === 'routing'),
    { workItems: context.listWorkItems(session.id).length, sessionStatus: state.sessions[0].status, admission: state.sessionLifecyclesBySession[session.id].admission });
  const replay = await service.classify(input);
  await record('SP04', replay.routingRevision === classified.routingRevision && requests.length === 2,
    { routingRevision: replay.routingRevision, modelRequests: requests.length });
  if (commitPlan) {
    const { IntentPlanCommitService } = await import('../../apps/server/dist/apps/server/src/modules/message-routing/intent-plan-commit.service.js');
    const { IntentAnswerExecutorService } = await import('../../apps/server/dist/apps/server/src/modules/message-routing/intent-answer-executor.service.js');
    const answers = app.get(IntentAnswerExecutorService);
    // Drive dispatch explicitly so plan-only assertions remain deterministic and independently reproducible.
    answers.schedule = () => {};
    const committer = app.get(IntentPlanCommitService);
    const commitInput = { sessionId: session.id, routingId: route.id, actorId: session.ownerId, expectedRoutingRevision: classified.routingRevision };
    const committed = await committer.commit(commitInput);
    const answerState = JSON.parse(await readFile(stateFile, 'utf8'));
    const step = answerState.intentPlanStepsBySession[session.id][0];
    await record('PC01', committed.plan.outcome === 'applicable' && committed.routing.actionStatus === 'pending' && step.status === 'queued' &&
      !step.step.target.workItemId && context.listWorkItems(session.id).length === 0 && answerState.sessions[0].status === 'PAUSED' &&
      answerState.sessionLifecyclesBySession[session.id].admission === 'closed' && requests.length === 2,
      { outcome: committed.plan.outcome, stepStatus: step.status, actionStatus: committed.routing.actionStatus, workItems: context.listWorkItems(session.id).length });
    const replayCommit = await committer.commit(commitInput);
    await record('PC02', replayCommit.idempotentReplay && replayCommit.plan.planId === committed.plan.planId && requests.length === 2 &&
      persistence.getCollection('intentRouteRevisionsBySession', {})[session.id].length === 1,
      { replay: replayCommit.idempotentReplay, modelRequests: requests.length, planId: replayCommit.plan.planId });
    await persistence.mutateCollections(['eventsBySession'], draft => {
      draft.eventsBySession[session.id].push({ ...draft.eventsBySession[session.id][0], id: 'initial-message', content: initialMessage,
        metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: { text: initialMessage } } });
    });
    const initialSnapshot = await context.buildIntentSnapshot({ session, sourceEventId: 'initial-message', currentMessage: initialMessage, latestEventSeq: 2 });
    const initialRoute = await context.createRoutingRecord({ session, sourceEventId: 'initial-message', idempotencyKey: 'initial', rolloutMode: 'enforce_all_current_epoch' });
    const initialProposal = await service.classify({ sessionId: session.id, routingId: initialRoute.id, snapshotId: initialSnapshot.id });
    const initialInput = { ...commitInput, routingId: initialRoute.id, expectedRoutingRevision: initialProposal.routingRevision };
    const initialResults = await Promise.all([committer.commit(initialInput), committer.commit(initialInput)]);
    const finalState = JSON.parse(await readFile(stateFile, 'utf8'));
    const works = context.listWorkItems(session.id);
    await record('PC03', works.length === 1 && initialResults.every(row => row.plan.outcome === 'applicable') &&
      initialResults.filter(row => row.idempotentReplay).length === 1 && finalState.intentPlanStepsBySession[session.id].length === 2 &&
      finalState.intentPlanStepsBySession[session.id][1].status === 'completed' && finalState.sessions[0].status === 'PAUSED' &&
      !finalState.briefsBySession?.[session.id] && finalState.logicalOperationsBySession[session.id].every(row => row.admissionClass === 'routing'),
      { workItems: works.length, replays: initialResults.map(row => row.idempotentReplay), modelRequests: requests.length,
        steps: finalState.intentPlanStepsBySession[session.id].map(row => ({ action: row.step.action, status: row.status })) });
    if (executeAnswer) {
      await app.get(SystemAgentRuntimePolicyService).update('coordinator', { preferredRuntimeType: 'generic_llm', allowedRuntimeTypes: ['generic_llm'] });
      await answers.process({ sessionId: session.id, stepId: step.id });
      const answered = JSON.parse(await readFile(stateFile, 'utf8'));
      const saved = answered.intentPlanStepsBySession[session.id].find(row => row.id === step.id);
      const answerEvents = answered.eventsBySession[session.id].filter(row => row.id === `intent-answer:${step.id}`);
      const answerRequests = requests.filter(row => row.answering);
      await record('AP01', saved.status === 'completed' && answerEvents.length === 1 &&
        answerEvents[0].content === '系统先识别消息，再校验并提交路由计划。' && answerRequests.length === 2 && answerRequests.every(row => row.tools.length === 0 && row.exactSource) && answerRequests[1].answerRepairFeedback,
        { stepStatus: saved.status, events: answerEvents.length, attempts: saved.processing?.attemptsUsed, requests: answerRequests });
      const operation = answered.logicalOperationsBySession[session.id].find(row => row.id === `answer:${step.id}`);
      await record('AP02', operation.attemptsUsed === 2 && operation.admissionClass === 'response' && operation.intentStepId === step.id &&
        operation.deadlineAt === saved.processing.deadlineAt && answered.sessions[0].status === 'PAUSED' &&
        answered.sessionLifecyclesBySession[session.id].admission === 'closed' && !operation.taskId && !operation.workItemId,
        { attempts: operation.attemptsUsed, admissionClass: operation.admissionClass, sessionStatus: answered.sessions[0].status,
          deadlineAt: operation.deadlineAt, stepDeadline: saved.processing.deadlineAt });
      const count = requests.length;
      await answers.process({ sessionId: session.id, stepId: step.id });
      await record('AP03', requests.length === count && persistence.getCollection('eventsBySession', {})[session.id].filter(row => row.id === `intent-answer:${step.id}`).length === 1,
        { requestsBefore: count, requestsAfter: requests.length });
    }
  }
} finally {
  if (app) await app.close();
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  await writeFile(resolve(outputDirectory, executeAnswer ? 'answer-executor-runtime-results.json' : commitPlan ? 'plan-commit-runtime-results.json' : 'semantic-proposal-runtime-results.json'), JSON.stringify({ executedAt: new Date().toISOString(),
    method: 'actual Nest module graph and Generic LLM HTTP to deterministic localhost provider; direct classifier/optional plan commit service ingress, not Sessions API or semantic accuracy', results }, null, 2));
  await rm(stateFile, { force: true });
}
if (results.length !== (executeAnswer ? 10 : commitPlan ? 7 : 4) || results.some(row => !row.passed)) process.exitCode = 1;
