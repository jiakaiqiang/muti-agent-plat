import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { briefRevisionMessage, intentUnderstandingExample, runtimeOutputExamples, type ReviseIntentBriefInput, type IntentUnderstandingOutput, type SessionDetail } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import { IntentUnderstandingRoutingService } from '../intent-recognition/intent-understanding-routing.service.js';
import { IntentPlanCommitService } from './intent-plan-commit.service.js';
import { IntentBriefExecutorService } from './intent-brief-executor.service.js';
import { IntentBriefStoreService } from './intent-brief-store.service.js';
import { makeService } from '../orchestrator/orchestrator.test-fixtures.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { IntentBriefConfirmationService } from './intent-brief-confirmation.service.js';
import { IntentCorrectionService } from './intent-correction.service.js';
import { IntentCorrectionPlannerService } from './intent-correction-planner.service.js';
import { IntentMessagePipelineService } from './intent-message-pipeline.service.js';
import { IntentBriefRetryService } from './intent-brief-retry.service.js';
import { assertIntentExecutionCurrent } from './intent-execution-guard.js';
import { deriveDirectedBriefSteps } from './intent-directed-brief-plan.js';
import { IntentBriefReviewStoreService } from './intent-brief-review-store.service.js';
import { createAgentMessageOutput } from '@agent-cluster/shared';
import { bindIntentWorkflowSelection } from './intent-workflow-selection.js';

const output = { ...runtimeOutputExamples.task_brief, goal: '实现登录', suggestedTasks: [] };

async function failedBriefFixture(t: TestContext) {
  let successful = false;
  const f = await fixture(t, async () => successful ? { status: 'completed', output } : { status: 'completed', output: {} });
  await f.service.process(f.reference);
  const state = f.state(), step = state.intentPlanStepsBySession.session[1], route = state.intentRoutingRecordsBySession.session[0];
  assert.equal(step.status, 'failed'); assert.equal(step.processing.attemptsUsed, 2);
  const request = { contractVersion: 'intent-brief-retry-v1', dataEpoch: 'epoch', expectedRoutingRevision: route.routingRevision,
    expectedIntentRevision: step.intentRevision, expectedOperationId: `brief:${step.id}`, idempotencyKey: 'retry-key' };
  const scheduled: any[] = [], retry = new IntentBriefRetryService(f.persistence, { schedule: (ref: any) => scheduled.push(ref) } as never);
  return { ...f, request, retry, scheduled, successful: () => { successful = true; }, failedStep: step };
}

test('explicit Brief retry preserves spent budget, creates one new operation and survives restart replay', async t => {
  const f = await failedBriefFixture(t), other = new IntentBriefRetryService(f.persistence, { schedule: () => {} } as never);
  const accepted = await Promise.all([f.retry.retry('session', f.reference.stepId, 'user', f.request), other.retry('session', f.reference.stepId, 'user', f.request)]);
  assert.deepEqual(accepted.map(row => row.idempotentReplay).sort(), [false, true]);
  assert.equal(accepted[0].receipt.previous.processing?.attemptsUsed, 2);
  assert.equal(f.state().intentPlanStepsBySession.session[1].processing, undefined);
  assert.equal(f.calls.length, 2); f.successful(); await f.service.process(f.reference);
  assert.equal(f.calls.length, 3); assert.equal(f.calls[2].operationId, accepted[0].receipt.operationId);
  assert.notEqual(f.calls[0].operationId, f.calls[2].operationId);
  assert.equal(f.state().briefsBySession.session.length, 1);
  const restored = new IntentBriefRetryService(await f.restorePersistence(), { schedule: () => assert.fail('completed retry must not be scheduled') } as never);
  const replay = await restored.retry('session', f.reference.stepId, 'user', f.request);
  assert.equal(replay.idempotentReplay, true); assert.deepEqual(replay.receipt, accepted[0].receipt);
  await assert.rejects(restored.retry('session', f.reference.stepId, 'user', { ...f.request, expectedIntentRevision: 99 }), /PAYLOAD_CONFLICT/);
  assert.equal(f.state().eventsBySession.session.filter((row: any) => row.metadata.payload?.code === 'INTENT_BRIEF_RETRY_REQUESTED').length, 1);
});

for (const mode of ['pause', 'hold', 'generation', 'active', 'unknown-stop', 'saved-result'] as const) test(`Brief retry rejects ${mode} without resetting the failed attempt`, async t => {
  const f = await failedBriefFixture(t);
  await f.persistence.mutateCollections(['sessions', 'sessionLifecyclesBySession', 'intentPlanStepsBySession', 'intentRoutingRecordsBySession', 'logicalOperationsBySession'], (draft: any) => {
    if (mode === 'pause') { draft.sessions[0].status = 'PAUSED'; draft.sessionLifecyclesBySession.session.admission = 'closed'; }
    if (mode === 'hold') draft.intentRoutingRecordsBySession.session[0].dispatchHold = { correctionId: 'held', reason: 'intent_correction', createdAt: 'now' };
    if (mode === 'generation') draft.sessionLifecyclesBySession.session.generation++;
    if (mode === 'active' || mode === 'unknown-stop') draft.logicalOperationsBySession = { session: [{ id: f.request.expectedOperationId,
      stopState: mode === 'unknown-stop' ? 'unconfirmed' : 'none', activeInvocationId: mode === 'active' ? 'running' : undefined }] };
    if (mode === 'saved-result') draft.intentPlanStepsBySession.session[1].processing.briefResult = { output, invocationId: 'saved', agentId: 'coordinator' };
  });
  await assert.rejects(f.retry.retry('session', f.reference.stepId, 'user', f.request), /STALE|UNCONFIRMED|UNAVAILABLE/);
  const step = f.state().intentPlanStepsBySession.session[1];
  assert.equal(step.status, 'failed'); assert.equal(step.processing.attemptsUsed, 2); assert.equal(step.briefRetryReceipts, undefined);
  assert.equal(f.calls.length, 2); assert.equal(f.scheduled.length, 0);
});

test('Brief retry rollback and immutable receipt protect failure history; old runtime preparation is fenced', async t => {
  const f = await failedBriefFixture(t), write = (f.persistence as any).writeFileState.bind(f.persistence);
  await assert.rejects(f.retry.retry('session', f.reference.stepId, 'user', { ...f.request, grant: true }), /INPUT_INVALID/);
  await assert.rejects(f.retry.retry('session', f.reference.stepId, 'user', { ...f.request, expectedRoutingRevision: 999 }), /REVISION_CONFLICT/);
  (f.persistence as any).writeFileState = (state: any) => { if (state.intentPlanStepsBySession.session[1].briefRetryReceipts) throw new Error('retry disk failure'); return write(state); };
  try { await assert.rejects(f.retry.retry('session', f.reference.stepId, 'user', f.request), /retry disk failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.equal(f.state().intentPlanStepsBySession.session[1].status, 'failed'); assert.equal(f.scheduled.length, 0);
  await f.retry.retry('session', f.reference.stepId, 'user', f.request);
  assert.throws(() => assertIntentExecutionCurrent(f.state(), f.calls[0]), /INTENT_BRIEF_OPERATION_SUPERSEDED/);
  for (const change of ['remove', 'edit']) await assert.rejects(f.persistence.mutateCollections(['intentPlanStepsBySession'], (draft: any) => {
    const step = draft.intentPlanStepsBySession.session[1];
    if (change === 'remove') step.briefRetryReceipts = []; else step.briefRetryReceipts[0].previous.processing.attemptsUsed = 0;
  }), /INTENT_BRIEF_RETRY_RECEIPT_CONFLICT/);
});

test('Brief recovery reads do not mutate budgets and reflect pause without reopening admission', async t => {
  const f = await failedBriefFixture(t), before = f.state().intentPlanStepsBySession.session[1];
  const visible = await f.retry.view('session', f.reference.stepId, 'user'); assert.equal(visible.canRetry, true);
  assert.deepEqual(f.state().intentPlanStepsBySession.session[1], before); assert.equal(f.calls.length, 2);
  await assert.rejects(f.retry.view('session', f.reference.stepId, 'another-owner'), /UNAVAILABLE/);
  await f.persistence.mutateCollections(['sessions', 'sessionLifecyclesBySession'], (draft: any) => {
    draft.sessions[0].status = 'PAUSED'; draft.sessionLifecyclesBySession.session.admission = 'closed';
  });
  assert.equal((await f.retry.view('session', f.reference.stepId, 'user')).canRetry, false);
  assert.equal(f.state().sessionLifecyclesBySession.session.admission, 'closed');
});

async function fixture(t: TestContext, invoke: (input: any) => Promise<any> = async () => ({ status: 'completed', output })) {
  const directory = mkdtempSync(join(tmpdir(), 'intent-brief-executor-')), filePath = join(directory, 'state.json');
  const persistence = new PersistenceService({ backend: 'file', filePath }); await persistence.initialize();
  const backends = [persistence], executors: IntentBriefExecutorService[] = [], calls: any[] = [];
  t.after(async () => { executors.forEach(row => row.onModuleDestroy()); for (const backend of backends) await backend.onModuleDestroy(); rmSync(directory, { force: true, recursive: true }); });
  const session: SessionDetail = { id: 'session', dataEpoch: 'epoch', ownerId: 'user', workspaceId: 'workspace', title: '登录', originalInput: '实现登录',
    intentContractVersion: 'intent-understanding-v1', status: 'AGENT_DISCUSSING', tokenUsed: 0, participatingAgentIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await persistence.setCollection('sessions', [session]); await new SessionLifecycleStore(persistence).initialize(session.id, session.dataEpoch);
  await persistence.setCollection('eventsBySession', { session: [{ id: 'source', sessionId: session.id, type: 'user_message', content: session.originalInput,
    toAgentIds: [], createdAt: session.createdAt, metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: {} } }] });
  const context = new ContextManagementService(persistence), understanding = structuredClone(intentUnderstandingExample);
  Object.assign(understanding.segments[0], { goal: session.originalInput, dialogueAct: 'command', scopeRelation: 'initial_requirement', suggestedAction: 'create_initial_work_item', contextPolicy: 'clean_task_context',
    requestedEffects: [], evidence: [{ refId: 'request', sourceEventId: 'source', start: 0, end: session.originalInput.length, quote: session.originalInput }] });
  const route = await context.createRoutingRecord({ session, sourceEventId: 'source', idempotencyKey: 'message', rolloutMode: 'enforce_all_current_epoch' });
  const snapshot = await context.buildIntentSnapshot({ session, sourceEventId: 'source', currentMessage: session.originalInput, latestEventSeq: 1 });
  const proposal = await new IntentUnderstandingRoutingService(persistence, context, { understand: async () => ({ status: 'valid', understanding }) } as never)
    .classify({ sessionId: session.id, routingId: route.id, snapshotId: snapshot.id });
  const scheduled: any[] = [];
  await new IntentPlanCommitService(persistence, { listAll: () => [{ type: 'generic_llm' }] } as never, undefined, undefined, undefined,
    { schedule: (ref: any) => scheduled.push(ref) } as never).commit({ sessionId: session.id, routingId: route.id, actorId: session.ownerId, expectedRoutingRevision: proposal.routingRevision! });
  assert.equal(scheduled.length, 1);
  const make = (backend = persistence) => {
    const service = new IntentBriefExecutorService(backend, { invoke: async (input: any) => { calls.push(input); return invoke(input); } } as never,
      { resolveSystemRole: () => ({ id: 'coordinator', key: 'coordinator', capabilityIds: [], profileMarkdown: 'coordinator' }),
        getForSurface: (id: string) => ({ id, key: id, status: 'active', capabilityIds: [], profileMarkdown: id }) } as never,
      { get: () => ({}) } as never, new IntentBriefStoreService(backend)); executors.push(service); return service;
  };
  const restorePersistence = async () => { const backend = new PersistenceService({ backend: 'file', filePath }); await backend.initialize(); backends.push(backend); return backend; };
  const restore = async () => make(await restorePersistence());
  return { persistence, reference: scheduled[0], service: make(), make, restore, restorePersistence, calls, session,
    state: () => JSON.parse(readFileSync(filePath, 'utf8')) };
}

test('actual plan commit derives a queued brief and concurrent executors publish one draft with no tasks or effects', async t => {
  const f = await fixture(t); assert.deepEqual(f.state().intentPlanStepsBySession.session.map((row: any) => row.status), ['completed', 'queued']);
  await Promise.all([f.service.process(f.reference), f.make().process(f.reference)]);
  assert.equal(f.calls.length, 1); const state = f.state(); assert.equal(state.briefsBySession.session.length, 1);
  assert.equal(state.sessions[0].status, 'WAIT_USER_CONFIRM'); assert.equal(state.intentRoutingRecordsBySession.session[0].actionStatus, 'applied');
  assert.equal(state.workItemsBySession.session[0].status, 'WAITING_USER');
  assert.equal(state.tasksBySession?.session?.length ?? 0, 0); assert.deepEqual(f.calls[0].effectScope.effects, []);
  assert.deepEqual(f.calls[0].workspace.capabilities, { read: false, write: false, command: false, test: false });
  const envelope = f.calls[0].contextEnvelopeFactory({ identity: { agentId: 'coordinator', profileHash: 'profile', profileRevision: 1 }, toolCatalog: { catalogHash: 'empty' } });
  assert.equal(envelope.L1.currentUserMessage, '实现登录'); assert.deepEqual(envelope.L3.files, []);
  await f.service.process(f.reference); assert.equal(f.calls.length, 1);
});

async function correctBrief(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, content: string, supersedesDecisionId?: string) {
  const before = f.state(), route = before.intentRoutingRecordsBySession.session[0], work = before.workItemsBySession.session[0];
  const scheduled: any[] = [], context = new ContextManagementService(f.persistence);
  const planner = new IntentCorrectionPlannerService(f.persistence, context, { understand: async (input: any) => {
    const request = input.correction, text = input.snapshot.currentMessage;
    const understanding: IntentUnderstandingOutput = { ...structuredClone(intentUnderstandingExample),
      segments: [{ localKey: 'correct', dialogueAct: supersedesDecisionId ? 'correction' : 'constraint', goal: text,
      scopeRelation: 'same_requirement', suggestedAction: 'correct_route', contextPolicy: 'inherit_confirmed',
      target: { workItemId: work.id, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: route.id },
      correction: supersedesDecisionId ? { supersedesDecisionId, expectedDecisionRevision: request.expectedDecisionRevision, replacementText: text } : null,
      requestedEffects: [], prohibitions: [], dependencies: [], evidence: [{ refId: 'change', sourceEventId: input.snapshot.sourceEventId, start: 0, end: text.length, quote: text }] }] };
    return { status: 'valid', understanding };
  } } as never, undefined, undefined, undefined, { schedule: (ref: any) => scheduled.push(ref) } as never);
  t.after(() => planner.onModuleDestroy());
  const acceptance = new IntentCorrectionService(f.persistence);
  const request = { contractVersion: 'intent-correction-v1' as const, expectedRoutingRevision: route.routingRevision, idempotencyKey: content,
    instruction: content, targetWorkItemId: work.id, supersedesDecisionId: null as string | null, expectedDecisionRevision: null as number | null, ...(supersedesDecisionId ? { supersedesDecisionId,
      expectedDecisionRevision: before.decisionRecordsBySession.session.find((row: any) => row.id === supersedesDecisionId).revision } : {}) };
  const accepted = await acceptance.accept('session', route.id, 'user', request);
  await acceptance.reconcileStop(accepted.correction); await planner.process(accepted.correction);
  assert.equal(acceptance.list('session', route.id).at(-1)!.status, 'applied'); assert.equal(scheduled.length, 1);
  return { reference: scheduled[0], planner, correction: accepted.correction };
}

async function revisionFixture(t: TestContext, foreignTarget = false) {
  const f = await fixture(t, async input => ({ status: 'completed', output: input.phase === 'brief_revision'
    ? createAgentMessageOutput({ messageKind: 'discussion', content: `${input.agent.id} 的审阅意见` })
    : { ...output, constraints: [], openQuestions: ['部署区域？'] } }));
  await f.service.process(f.reference);
  const state = f.state(), brief = state.briefsBySession.session[0], card = state.eventsBySession.session.find((row: any) => row.type === 'user_confirmation_requested');
  const request: ReviseIntentBriefInput = { contractVersion: 'intent-brief-revise-v1', dataEpoch: 'epoch', confirmationId: card.metadata.payload.confirmationId,
    expectedBriefVersion: brief.version, expectedIntentRevision: brief.intentBinding.intentRevision, idempotencyKey: 'revise-1', userMessage: '补充部署要求',
    questionAnswers: [{ question: '部署区域？', answer: '华东' }] };
  const context = new ContextManagementService(f.persistence), scheduled: any[] = [], classifications: any[] = [];
  const classifier = new IntentUnderstandingRoutingService(f.persistence, context, { understand: async (input: any) => {
    classifications.push(input);
    const understanding = structuredClone(intentUnderstandingExample);
    understanding.segments[0] = { ...understanding.segments[0], dialogueAct: 'knowledge_input', scopeRelation: foreignTarget ? 'independent_new_requirement' : 'same_requirement',
      suggestedAction: foreignTarget ? 'create_independent_work_item' : 'record_information', contextPolicy: foreignTarget ? 'clean_task_context' : 'inherit_confirmed',
      goal: input.snapshot.currentMessage, requestedEffects: [], target: { ...understanding.segments[0].target, workItemId: foreignTarget ? null : brief.workItemId },
      evidence: [{ refId: 'request', sourceEventId: input.snapshot.sourceEventId, start: 0, end: input.snapshot.currentMessage.length, quote: input.snapshot.currentMessage }] };
    return { status: 'valid', understanding };
  } } as never);
  const plans = new IntentPlanCommitService(f.persistence, { listAll: () => [{ type: 'generic_llm' }] } as never, undefined, undefined, undefined,
    { schedule: (ref: any) => scheduled.push(ref) } as never);
  const pipeline = new IntentMessagePipelineService(f.persistence, context, classifier, plans, undefined, undefined,
    { getForSurface: (key: string) => ({ id: key === 'architect-alias' ? 'architect' : key }) } as never); pipeline.schedule = () => {};
  t.after(() => pipeline.onModuleDestroy());
  const input = (req = request) => ({ session: f.session, content: briefRevisionMessage(req), idempotencyKey: req.idempotencyKey,
    replyToEventId: 'source', rolloutMode: 'enforce_all_current_epoch' as const, briefRevision: { briefId: brief.id, request: req } });
  return { ...f, brief, request, input, pipeline, scheduled, classifications };
}

test('structured revision enters the same pipeline, binds question answers and generates a new confirmable draft', async t => {
  const f = await revisionFixture(t);
  const accepted = await f.pipeline.accept(f.input());
  assert.equal(f.classifications.length, 0); assert.equal(f.calls.length, 1);
  assert.equal(f.state().sessions[0].pendingBriefRevisionRoutingId, accepted.routing.id);
  await assert.rejects(new IntentBriefConfirmationService(f.persistence).confirm('session', f.brief.id, 'user', {
    ...f.request, contractVersion: 'intent-brief-confirm-v1', userMessage: undefined, questionAnswers: undefined }), /INPUT_INVALID/);
  await f.pipeline.process({ sessionId: 'session', routingId: accepted.routing.id });
  assert.equal(f.scheduled.length, 1); assert.equal(f.classifications[0].briefRevision.briefId, f.brief.id);
  assert.deepEqual(f.state().decisionRecordsBySession.session.filter((row: any) => row.question).map((row: any) => [row.question, row.answer]), [['部署区域？', '华东']]);
  await f.service.process(f.scheduled[0]); const state = f.state(), brief = state.briefsBySession.session.at(-1);
  assert.deepEqual(brief.openQuestions, []); assert.equal(brief.supersedesBriefId, f.brief.id);
  assert.equal(state.sessions[0].pendingBriefRevisionRoutingId, undefined); assert.equal(state.tasksBySession?.session?.length ?? 0, 0);
  const replay = await f.pipeline.accept(f.input()); assert.equal(replay.routing.id, accepted.routing.id); assert.equal(replay.idempotentReplay, true);
  await f.pipeline.process({ sessionId: 'session', routingId: accepted.routing.id }); assert.equal(f.classifications.length, 1);
});

test('structured assignment binds exact session agents and queues both reviews before finalization', async t => {
  const f = await revisionFixture(t);
  await f.persistence.mutateCollections(['sessions'], (draft: any) => { draft.sessions[0].participatingAgentIds = ['architect', 'reviewer']; });
  const request = { ...f.request, assignedAgentKeys: ['architect', 'reviewer'] };
  const accepted = await f.pipeline.accept(f.input(request));
  assert.deepEqual(accepted.routing.briefRevision?.reviewerIds, ['architect', 'reviewer']);
  await f.pipeline.process({ sessionId: 'session', routingId: accepted.routing.id });
  const records = f.state().intentPlanStepsBySession.session.filter((row: any) => row.routingId === accepted.routing.id);
  assert.deepEqual(records.map((row: any) => [row.step.action, row.status]),
    [['record_information', 'completed'], ['review_brief', 'queued'], ['review_brief', 'queued'], ['prepare_brief', 'queued']]);
  assert.equal(f.scheduled.length, 3);
  const final = records.at(-1); await f.service.process({ sessionId: 'session', stepId: final.id });
  assert.equal(f.calls.length, 1); assert.equal(f.state().briefsBySession.session.length, 1);
  for (const record of records.filter((row: any) => row.step.action === 'review_brief')) {
    await Promise.all([f.service.process({ sessionId: 'session', stepId: record.id }), f.make().process({ sessionId: 'session', stepId: record.id })]);
  }
  await f.service.process({ sessionId: 'session', stepId: final.id });
  assert.deepEqual(f.calls.filter((call: any) => call.phase === 'brief_revision').map((call: any) => call.agent.id), ['architect', 'reviewer']);
  assert.equal(f.state().briefsBySession.session.length, 2);
  assert.equal(f.state().eventsBySession.session.filter((row: any) => row.type === 'agent_message').length, 2);
  const replay = await f.pipeline.accept(f.input(request)); assert.equal(replay.idempotentReplay, true);
  await assert.rejects(f.pipeline.accept(f.input({ ...request, assignedAgentKeys: ['reviewer'] })), /IDEMPOTENCY_CONFLICT/);
});

test('removing an assigned participant fences review before invocation and prevents final publication', async t => {
  const f = await revisionFixture(t);
  await f.persistence.mutateCollections(['sessions'], (draft: any) => { draft.sessions[0].participatingAgentIds = ['architect']; });
  const accepted = await f.pipeline.accept(f.input({ ...f.request, assignedAgentKeys: ['architect'] }));
  await f.pipeline.process({ sessionId: 'session', routingId: accepted.routing.id });
  await f.persistence.mutateCollections(['sessions'], (draft: any) => { draft.sessions[0].participatingAgentIds = []; });
  for (const ref of f.scheduled) await f.service.process(ref);
  assert.equal(f.calls.length, 1); assert.equal(f.state().briefsBySession.session.length, 1);
  assert.equal(f.state().intentPlanStepsBySession.session.find((row: any) => row.routingId === accepted.routing.id && row.step.action === 'review_brief').status, 'invalidated');
});

test('assignment rejects foreign agents and aliased duplicates atomically before classification', async t => {
  for (const assignedAgentKeys of [['outsider'], ['architect', 'architect-alias']]) {
    const f = await revisionFixture(t);
    await f.persistence.mutateCollections(['sessions'], (draft: any) => { draft.sessions[0].participatingAgentIds = ['architect']; });
    const before = f.state();
    await assert.rejects(f.pipeline.accept(f.input({ ...f.request, assignedAgentKeys })), /REVIEW_TARGET/);
    assert.deepEqual(f.state(), before); assert.equal(f.classifications.length, 0);
  }
});

test('structured revision refuses stale versions, foreign questions and concurrent replacement requests before classification', async t => {
  const f = await revisionFixture(t);
  for (const request of [{ ...f.request, expectedBriefVersion: 99 }, { ...f.request, questionAnswers: [{ question: '其他问题', answer: '伪造' }] }]) {
    await assert.rejects(f.pipeline.accept(f.input(request)), /REVISION_/);
  }
  const accepted = await f.pipeline.accept(f.input());
  await assert.rejects(f.pipeline.accept(f.input({ ...f.request, idempotencyKey: 'other' })), /REVISION_STALE/);
  const { userMessage: _text, questionAnswers: _answers, ...binding } = f.request;
  await assert.rejects(new IntentBriefConfirmationService(f.persistence).confirm('session', f.brief.id, 'user', { ...binding, contractVersion: 'intent-brief-confirm-v1' }), /TARGET_STALE/);
  assert.equal(f.classifications.length, 0); assert.equal(f.state().sessions[0].pendingBriefRevisionRoutingId, accepted.routing.id);
});

test('a model cannot turn a bound draft revision into another task', async t => {
  const f = await revisionFixture(t, true), accepted = await f.pipeline.accept(f.input());
  await f.pipeline.process({ sessionId: 'session', routingId: accepted.routing.id });
  const state = f.state(), route = state.intentRoutingRecordsBySession.session.find((row: any) => row.id === accepted.routing.id);
  assert.equal(route.status, 'BLOCKED'); assert.ok(route.reasonCodes.includes('INTENT_BRIEF_REVISION_PLAN_CONFLICT'));
  assert.equal(state.workItemsBySession.session.length, 1); assert.equal(state.briefsBySession.session.length, 1);
  assert.equal(f.scheduled.length, 0); assert.equal(state.decisionRecordsBySession?.session?.length ?? 0, 0);
});

test('revision acceptance rolls back the event and pending marker on File failure and freezes the saved request', async t => {
  const f = await revisionFixture(t), write = (f.persistence as any).writeFileState.bind(f.persistence), before = f.state();
  (f.persistence as any).writeFileState = (state: any) => { if (state.sessions[0].pendingBriefRevisionRoutingId) throw new Error('revision acceptance failure'); return write(state); };
  try { await assert.rejects(f.pipeline.accept(f.input()), /revision acceptance failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.deepEqual(f.state(), before);
  const accepted = await f.pipeline.accept(f.input());
  await assert.rejects(f.persistence.mutateCollections(['intentRoutingRecordsBySession'], (draft: any) => {
    draft.intentRoutingRecordsBySession.session.find((row: any) => row.id === accepted.routing.id).briefRevision.request.userMessage = 'changed';
  }), /REVISION_IMMUTABLE_CONFLICT/);
  assert.equal(f.classifications.length, 0);
});

test('two successive corrections publish new Brief versions with only the effective constraint and immutable history', async t => {
  const f = await fixture(t, async () => ({ status: 'completed', output: { ...output, constraints: [], openQuestions: [] } }));
  await f.service.process(f.reference);
  const first = await correctBrief(t, f, '超时为 10 分钟');
  await f.service.process(first.reference);
  const previous = f.state().briefsBySession.session.at(-1);
  assert.deepEqual(previous.constraints, ['超时为 10 分钟']);
  const old = f.state().decisionRecordsBySession.session.find((row: any) => row.content === '超时为 10 分钟');
  const second = await correctBrief(t, f, '超时改为 30 分钟', old.id);
  assert.equal(f.state().sessions[0].status, 'REVISING_BRIEF');
  await Promise.all([f.service.process(second.reference), f.make().process(second.reference)]);
  const state = f.state(), updated = state.briefsBySession.session.at(-1);
  assert.equal(updated.version, 3); assert.equal(updated.supersedesBriefId, previous.id);
  assert.deepEqual(updated.constraints, ['超时改为 30 分钟']); assert.deepEqual(state.briefsBySession.session[1], previous);
  assert.equal(state.sessions[0].status, 'WAIT_USER_CONFIRM'); assert.equal(state.tasksBySession?.session?.length ?? 0, 0);
  const envelope = f.calls.at(-1).contextEnvelopeFactory({ identity: { agentId: 'coordinator', profileHash: 'h', profileRevision: 1 }, toolCatalog: { catalogHash: 'h' } });
  assert.equal(envelope.L1.currentUserMessage, '超时改为 30 分钟'); assert.equal(envelope.L1.sessionGoal, '实现登录');
  assert.ok(!JSON.stringify(envelope.L5).includes('超时为 10 分钟'));
  const count = f.calls.length; await second.planner.process(second.correction); await f.service.process(second.reference);
  assert.equal(f.calls.length, count); assert.equal(f.state().briefsBySession.session.length, 3);
});

test('a corrected Brief queued during pause spends no budget and generates only after explicit resume', async t => {
  const f = await fixture(t); await f.service.process(f.reference);
  await f.persistence.mutateCollections(['sessions', 'sessionLifecyclesBySession'], (draft: any) => {
    draft.sessions[0].status = 'PAUSED'; draft.sessions[0].pauseState = { previousStatus: 'WAIT_USER_CONFIRM', pausedAt: new Date().toISOString(), reason: 'pause' };
    draft.sessionLifecyclesBySession.session.admission = 'closed'; draft.sessionLifecyclesBySession.session.stopStatus = 'confirmed';
  });
  const next = await correctBrief(t, f, '超时为 10 分钟'); await f.service.process(next.reference);
  const waiting = f.state().intentPlanStepsBySession.session.find((row: any) => row.id === next.reference.stepId);
  assert.equal(waiting.status, 'queued'); assert.equal(waiting.processing, undefined); assert.equal(f.calls.length, 1);
  assert.equal(f.state().sessions[0].pauseState.previousStatus, 'REVISING_BRIEF');
  await f.persistence.mutateCollections(['sessions', 'sessionLifecyclesBySession'], (draft: any) => {
    draft.sessions[0].status = 'AGENT_DISCUSSING'; delete draft.sessions[0].pauseState; draft.sessionLifecyclesBySession.session.admission = 'open';
  });
  await f.service.process(next.reference); assert.equal(f.calls.length, 2); assert.equal(f.state().briefsBySession.session.length, 2);
});

test('corrected Brief publication failure keeps old current draft and saved result, then recovers without another model call', async t => {
  const f = await fixture(t); await f.service.process(f.reference); const old = f.state().briefsBySession.session[0];
  const next = await correctBrief(t, f, '超时为 10 分钟'), write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = (state: any) => { if (state.briefsBySession?.session?.length > 1) throw new Error('revision disk failure'); return write(state); };
  try { await assert.rejects(f.service.process(next.reference), /revision disk failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.equal(f.state().sessions[0].currentTaskBriefId, old.id); assert.equal(f.state().briefsBySession.session.length, 1);
  await f.persistence.mutateCollections(['intentPlanStepsBySession'], (draft: any) => {
    draft.intentPlanStepsBySession.session.find((row: any) => row.id === next.reference.stepId).processing.leaseExpiresAt = new Date(0).toISOString();
  });
  f.service.onModuleDestroy(); const restored = await f.restore(); await restored.process(next.reference);
  assert.equal(f.calls.length, 2); assert.equal(f.state().briefsBySession.session.length, 2);
});

test('a second correction fences a late model result from the preceding Brief revision', async t => {
  let count = 0, entered!: () => void, release!: (value: any) => void;
  const started = new Promise<void>(done => { entered = done });
  const f = await fixture(t, async () => { if (++count === 2) { entered(); return new Promise(done => { release = done }); }
    return { status: 'completed', output: { ...output, constraints: [], openQuestions: [] } }; });
  await f.service.process(f.reference); const first = await correctBrief(t, f, '超时为 10 分钟');
  const running = f.service.process(first.reference); await started;
  const old = f.state().decisionRecordsBySession.session.find((row: any) => row.content === '超时为 10 分钟');
  const second = await correctBrief(t, f, '超时改为 30 分钟', old.id);
  release({ status: 'completed', output: { ...output, constraints: ['超时为 10 分钟'] } }); await running;
  assert.equal(f.state().briefsBySession.session.length, 1);
  assert.equal(f.state().intentRoutingRecordsBySession.session[0].actionStatus, 'pending');
  await f.service.process(second.reference);
  assert.deepEqual(f.state().briefsBySession.session.at(-1).constraints, ['超时改为 30 分钟']);
  assert.equal(f.state().briefsBySession.session.length, 2);
});

test('one schema repair uses the same durable operation and original text', async t => {
  let count = 0;
  const f = await fixture(t, async () => ++count === 1 ? { status: 'completed', output: { kind: 'task_brief' } } : { status: 'completed', output });
  await f.service.process(f.reference); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].operationId, f.calls[1].operationId); assert.equal(f.calls[0].operationDeadlineAt, f.calls[1].operationDeadlineAt);
  assert.equal(f.state().intentPlanStepsBySession.session[1].processing.attemptsUsed, 2);
  const envelope = f.calls[1].contextEnvelopeFactory({ identity: { agentId: 'coordinator', profileHash: 'h', profileRevision: 1 }, toolCatalog: { catalogHash: 'h' } });
  assert.ok(envelope.L5.bullets.some((row: string) => row.includes('Repair feedback')));
  assert.equal(f.state().briefsBySession.session.length, 1);
});

test('auth failure is single-attempt and does not publish a brief or confirmation', async t => {
  const f = await fixture(t, async () => ({ status: 'failed', error: { code: 'MODEL_ERROR', retryable: true, details: { httpStatus: 401 } } }));
  await f.service.process(f.reference); assert.equal(f.calls.length, 1); assert.equal(f.state().intentPlanStepsBySession.session[1].status, 'failed');
  assert.equal(f.state().briefsBySession?.session?.length ?? 0, 0);
  assert.equal(f.state().eventsBySession.session.some((row: any) => row.type === 'user_confirmation_requested'), false);
});

test('saved candidate recovers after publication failure without another model call', async t => {
  const f = await fixture(t), write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = (state: any) => { if (state.briefsBySession?.session?.length) throw new Error('brief publication disk failure'); return write(state); };
  try { await assert.rejects(f.service.process(f.reference), /brief publication disk failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  await f.persistence.mutateCollections(['intentPlanStepsBySession'], (draft: any) => { draft.intentPlanStepsBySession.session[1].processing.leaseExpiresAt = new Date(0).toISOString(); });
  f.service.onModuleDestroy(); const restored = await f.restore(); await restored.process(f.reference);
  assert.equal(f.calls.length, 1); assert.equal(f.state().briefsBySession.session.length, 1);
});

test('correction hold during model generation rejects the late draft without changing the held route', async t => {
  let release!: (value: any) => void, entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, async () => { entered(); return new Promise(resolve => { release = resolve; }); });
  const running = f.service.process(f.reference); await started;
  await f.persistence.mutateCollections(['intentRoutingRecordsBySession'], (draft: any) => {
    const route = draft.intentRoutingRecordsBySession.session[0]; route.dispatchHold = { correctionId: 'new', executionEpoch: 2, reason: 'correction', createdAt: new Date().toISOString() };
    route.actionStatus = 'pending';
  });
  release({ status: 'completed', output }); await running;
  assert.equal(f.state().intentPlanStepsBySession.session[1].status, 'invalidated'); assert.equal(f.state().intentRoutingRecordsBySession.session[0].actionStatus, 'pending');
  assert.equal(f.state().briefsBySession?.session?.length ?? 0, 0);
});

for (const mode of ['pause', 'expired', 'unknown-stop'] as const) test(`brief ${mode} blocks new invocation without resetting budget`, async t => {
  const f = await fixture(t);
  await f.persistence.mutateCollections(['sessions', 'sessionLifecyclesBySession', 'intentPlanStepsBySession', 'logicalOperationsBySession'], (draft: any) => {
    if (mode === 'pause') { draft.sessions[0].status = 'PAUSED'; draft.sessionLifecyclesBySession.session.admission = 'closed'; }
    if (mode === 'expired') draft.intentPlanStepsBySession.session[1].processing = { ownerId: 'dead', attemptsUsed: 1, leaseExpiresAt: new Date(0).toISOString(), deadlineAt: new Date(0).toISOString() };
    if (mode === 'unknown-stop') draft.logicalOperationsBySession = { session: [{ id: `brief:${f.reference.stepId}`, stopState: 'unconfirmed' }] };
  });
  await f.service.process(f.reference); assert.equal(f.calls.length, 0); assert.equal(f.state().briefsBySession?.session?.length ?? 0, 0);
  if (mode === 'unknown-stop') assert.equal(f.state().intentPlanStepsBySession.session[1].status, 'reconciliation_required');
});

test('legacy cache persistence preserves new-contract drafts and reads their durable projection', async t => {
  const f = await fixture(t); await f.service.process(f.reference);
  const service = makeService([], undefined, undefined, undefined, undefined, { persistence: f.persistence }) as any;
  const before = f.state().briefsBySession.session[0]; service.briefsBySession.set('session', [{ ...before, goal: 'stale cache' }]);
  service.suggestedTasksByBriefId.set(before.id, [{ title: 'stale suggestion' }]);
  await service.persistBriefs(); assert.equal(service.getBrief('session', before.id).goal, '实现登录');
  assert.equal(f.state().briefsBySession.session[0].goal, '实现登录'); assert.deepEqual(f.state().suggestedTasksByBriefId[before.id], []);
  assert.throws(() => service.confirmBrief(f.session, before.id), /INTENT_BRIEF_VERSIONED_CONFIRMATION_REQUIRED/);
  await assert.rejects(service.discussAndCreateBrief(f.session), /INTENT_BRIEF_VERSIONED_EXECUTOR_REQUIRED/);
  const pendingPause = { ...f.session, status: 'PAUSED', updatedAt: new Date().toISOString() };
  (SessionsService.prototype as any).refreshIntentLedgerRevision.call({ persistence: f.persistence }, pendingPause);
  assert.equal(pendingPause.status, 'PAUSED'); assert.equal((pendingPause as SessionDetail).currentTaskBriefId, before.id);
});

test('late completion after the absolute deadline is a budget failure and publishes no draft', async t => {
  const f = await fixture(t, async input => {
    // Advance only after dispatch: loaded CI hosts must not expire before the call starts.
    t.mock.method(Date, 'now', () => Date.parse(input.operationDeadlineAt) + 1);
    return { status: 'completed', output };
  });
  try { await f.service.process(f.reference); } finally { t.mock.restoreAll(); }
  assert.equal(f.calls.length, 1);
  assert.equal(f.state().intentPlanStepsBySession.session[1].failureCode, 'INTENT_BRIEF_BUDGET_EXHAUSTED');
  assert.equal(f.state().briefsBySession?.session?.length ?? 0, 0);
});

async function confirmationFixture(t: TestContext, openQuestions: string[] = []) {
  const f = await fixture(t, async () => ({ status: 'completed', output: { ...output, openQuestions } }));
  await f.service.process(f.reference); const state = f.state(), brief = state.briefsBySession.session[0];
  const card = state.eventsBySession.session.find((row: any) => row.type === 'user_confirmation_requested');
  const request = { contractVersion: 'intent-brief-confirm-v1', dataEpoch: 'epoch', confirmationId: card.metadata.payload.confirmationId,
    expectedBriefVersion: brief.version, expectedIntentRevision: brief.intentBinding.intentRevision, idempotencyKey: 'confirm-key' };
  return { ...f, brief, request, confirmation: new IntentBriefConfirmationService(f.persistence) };
}

test('versioned confirmation atomically records one receipt and decisions across concurrent equivalent choices', async t => {
  const f = await confirmationFixture(t), other = new IntentBriefConfirmationService(f.persistence);
  const results = await Promise.all([f.confirmation.confirm('session', f.brief.id, 'user', f.request),
    other.confirm('session', f.brief.id, 'user', { ...f.request, idempotencyKey: 'second-client' })]);
  assert.deepEqual(results.map(row => row.idempotentReplay).sort(), [false, true]);
  const state = f.state(); assert.equal(state.briefsBySession.session[0].confirmedByUser, true);
  assert.equal(state.sessions[0].status, 'WAIT_WORKFLOW_SELECT'); assert.equal(state.workItemsBySession.session[0].requirementRevision, 2);
  assert.equal(state.decisionRecordsBySession.session.filter((row: any) => row.kind === 'approval').length, 1);
  assert.equal(state.eventsBySession.session.filter((row: any) => row.type === 'user_confirmation_resolved').length, 1);
  assert.equal(state.eventOutbox.filter((row: any) => row.id === `outbox:${results[0].receipt.sourceEventId}`).length, 1);
  assert.equal(state.tasksBySession?.session?.length ?? 0, 0); assert.equal(f.calls.length, 1);
  assert.equal(state.intentRouteRevisionsBySession.session.length, 1); assert.deepEqual(state.intentRouteRevisionsBySession.session[0].authorityGrants, []);
  await assert.rejects(f.confirmation.confirm('session', f.brief.id, 'user', { ...f.request, expectedBriefVersion: 99 }), /ALREADY_RESOLVED/);
  const stale = { ...f.session, status: 'WAIT_USER_CONFIRM', currentTaskBriefId: f.brief.id };
  (SessionsService.prototype as any).refreshIntentLedgerRevision.call({ persistence: f.persistence }, stale);
  assert.equal(stale.status, 'WAIT_WORKFLOW_SELECT');
});

test('workflow selection binds a genuinely confirmed Brief and current versions without granting effects', async t => {
  const f = await confirmationFixture(t);
  await f.confirmation.confirm('session', f.brief.id, 'user', f.request);
  const state = f.state(), work = state.workItemsBySession.session[0];
  const request = { contractVersion: 'intent-workflow-select-v1', dataEpoch: 'epoch', briefId: f.brief.id, expectedBriefVersion: f.brief.version,
    expectedIntentRevision: 1, expectedRequirementRevision: work.requirementRevision, expectedExecutionEpoch: work.executionEpoch ?? 1,
    expectedSessionGeneration: state.sessionLifecyclesBySession.session.generation, workflowId: 'workflow', workflowVersion: 1,
    definitionHash: 'definition-one', confirmationId: 'workflow-card', idempotencyKey: 'select-workflow' };
  state.workflowCatalog = { workflows: [{ id: 'workflow', status: 'published' }], versionsByWorkflowId: { workflow: [{
    workflowId: 'workflow', version: 1, definitionHash: 'definition-one', nodes: [{ id: 'node', type: 'agent', agentId: 'architect', order: 0 }] }] } };
  state.eventsBySession.session.push({ id: 'workflow-card-event', type: 'user_confirmation_requested', metadata: { payload: {
    confirmationId: request.confirmationId, reason: 'select_workflow', relatedBriefId: f.brief.id, briefVersion: f.brief.version,
    intentRevision: 1, requirementRevision: request.expectedRequirementRevision, dataEpoch: request.dataEpoch,
    executionEpoch: request.expectedExecutionEpoch, sessionGeneration: request.expectedSessionGeneration } } });
  const before = structuredClone(state), bound = bindIntentWorkflowSelection(state, 'session', 'user', request);
  assert.equal(bound.executionAuthorized, false); assert.equal(bound.confirmedByReceiptId, state.briefsBySession.session[0].intentConfirmationReceipt.id);
  assert.deepEqual(state, before); assert.equal(f.calls.length, 1);
  for (const field of ['expectedBriefVersion', 'expectedIntentRevision', 'expectedRequirementRevision', 'expectedExecutionEpoch', 'expectedSessionGeneration', 'workflowVersion']) {
    assert.throws(() => bindIntentWorkflowSelection(state, 'session', 'user', { ...request, [field]: 99 }), /STALE/);
  }
  for (const extra of [{ safeToApply: true }, { grantIds: ['forged'] }, { workflowVersion: 0 }, { definitionHash: '' }]) {
    assert.throws(() => bindIntentWorkflowSelection(state, 'session', 'user', { ...request, ...extra }), /INPUT_INVALID/);
  }
  for (const change of ['pause', 'hold', 'stop', 'definition', 'receipt', 'card']) {
    const stale = structuredClone(state);
    if (change === 'pause') stale.sessions[0].status = 'PAUSED';
    if (change === 'hold') stale.workItemsBySession.session[0].dispatchHold = { correctionId: 'new' };
    if (change === 'stop') stale.sessionLifecyclesBySession.session.stopStatus = 'unconfirmed';
    if (change === 'definition') stale.workflowCatalog.versionsByWorkflowId.workflow[0].definitionHash = 'replaced';
    if (change === 'receipt') delete stale.briefsBySession.session[0].intentConfirmationReceipt;
    if (change === 'card') stale.eventsBySession.session.at(-1).metadata.payload.requirementRevision++;
    assert.throws(() => bindIntentWorkflowSelection(stale, 'session', 'user', request), /STALE/);
  }
});

test('brief approval rollback retains unconfirmed draft and File restart replays one accepted receipt', async t => {
  const f = await confirmationFixture(t), write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = (state: any) => { if (state.briefsBySession?.session?.[0]?.confirmedByUser) throw new Error('confirmation disk failure'); return write(state); };
  try { await assert.rejects(f.confirmation.confirm('session', f.brief.id, 'user', f.request), /confirmation disk failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.equal(f.state().briefsBySession.session[0].confirmedByUser, false); assert.equal(f.state().decisionRecordsBySession?.session?.length ?? 0, 0);
  assert.equal(f.state().eventsBySession.session.some((row: any) => row.type === 'user_confirmation_resolved'), false);
  const committed = await f.confirmation.confirm('session', f.brief.id, 'user', f.request);
  const restored = new IntentBriefConfirmationService(await f.restorePersistence());
  const replay = await restored.confirm('session', f.brief.id, 'user', f.request);
  assert.equal(replay.idempotentReplay, true); assert.deepEqual(replay.receipt, committed.receipt);
});

for (const mode of ['hold', 'generation', 'requirements', 'target'] as const) test(`brief confirmation rejects changed ${mode} without decisions or receipt`, async t => {
  const f = await confirmationFixture(t);
  await f.persistence.mutateCollections(['sessions', 'sessionLifecyclesBySession', 'workItemsBySession', 'intentRoutingRecordsBySession'], (draft: any) => {
    if (mode === 'hold') draft.intentRoutingRecordsBySession.session[0].dispatchHold = { correctionId: 'new', executionEpoch: 2, reason: 'intent_correction', createdAt: new Date().toISOString() };
    if (mode === 'generation') draft.sessionLifecyclesBySession.session.generation++;
    if (mode === 'requirements') draft.workItemsBySession.session[0].requirementRevision++;
    if (mode === 'target') draft.sessions[0].currentTaskBriefId = 'another-brief';
  });
  await assert.rejects(f.confirmation.confirm('session', f.brief.id, 'user', f.request), /INTENT_BRIEF_CONFIRM_.*STALE/);
  assert.equal(f.state().briefsBySession.session[0].intentConfirmationReceipt, undefined); assert.equal(f.state().decisionRecordsBySession?.session?.length ?? 0, 0);
});

test('confirmation preserves a stopped pause and cannot accept open questions or model-supplied authorization', async t => {
  const f = await confirmationFixture(t);
  await f.persistence.mutateCollections(['sessions', 'sessionLifecyclesBySession'], (draft: any) => {
    draft.sessions[0].status = 'PAUSED'; draft.sessions[0].pauseState = { previousStatus: 'WAIT_USER_CONFIRM', pausedAt: 'paused', reason: 'user' };
    draft.sessionLifecyclesBySession.session.admission = 'closed'; draft.sessionLifecyclesBySession.session.stopStatus = 'confirmed';
  });
  await assert.rejects(f.confirmation.confirm('session', f.brief.id, 'user', { ...f.request, allowOpenQuestions: true }), /INPUT_INVALID/);
  const result = await f.confirmation.confirm('session', f.brief.id, 'user', f.request);
  assert.equal(result.status, 'PAUSED'); assert.equal(f.state().sessionLifecyclesBySession.session.admission, 'closed');
  assert.equal(f.state().sessions[0].pauseState.previousStatus, 'WAIT_WORKFLOW_SELECT');
  const questions = await confirmationFixture(t, ['仍有待确认问题']);
  await assert.rejects(questions.confirmation.confirm('session', questions.brief.id, 'user', questions.request), /INTENT_BRIEF_OPEN_QUESTIONS/);
});

test('confirmed versioned Brief body and receipt cannot be overwritten through persistence', async t => {
  const f = await confirmationFixture(t); await f.confirmation.confirm('session', f.brief.id, 'user', f.request);
  for (const property of ['goal', 'receipt', 'confirmation']) await assert.rejects(f.persistence.mutateCollections(['briefsBySession'], (draft: any) => {
    const brief = draft.briefsBySession.session[0];
    if (property === 'goal') brief.goal = 'another goal';
    if (property === 'receipt') brief.intentConfirmationReceipt.actorId = 'another user';
    if (property === 'confirmation') brief.confirmedByUser = false;
  }), /INTENT_BRIEF_IMMUTABLE_CONFLICT/);
  const replacement = f.state().briefsBySession; replacement.session[0].goal = 'overwrite';
  assert.throws(() => f.persistence.setCollection('briefsBySession', replacement), /INTENT_BRIEF_IMMUTABLE_CONFLICT/);
});


async function directedFixture(t: TestContext, invoke?: (input: any) => Promise<any>) {
  const f = await fixture(t, invoke); await f.service.process(f.reference);
  const mutate = f.persistence.mutateCollections.bind(f.persistence);
  // Install derived steps inside the real correction commit, before immutable validation.
  f.persistence.mutateCollections = ((keys: any, action: any, options: any) => mutate(keys, (draft: any) => {
    const result = action(draft), version = draft.intentRouteRevisionsBySession?.session?.at(-1);
    if (version?.intentRevision === 2 && version.validatedPlan?.steps.length === 2 && !version.validatedPlan.steps.some((step: any) => step.action === 'review_brief')) {
      const plan = version.validatedPlan, previousFinal = plan.steps[1], work = draft.workItemsBySession.session[0];
      const brief = draft.briefsBySession.session.find((item: any) => item.id === previousFinal.replacesBrief.briefId);
      plan.steps.pop(); const derived = deriveDirectedBriefSteps(plan, brief, work, ['architect', 'reviewer']); plan.steps.push(...derived);
      const records = draft.intentPlanStepsBySession.session;
      const old = records.find((item: any) => item.id === previousFinal.stepId);
      draft.intentPlanStepsBySession.session = [...records.filter((item: any) => item.id !== old.id), ...derived.map(step => ({ ...old,
        id: step.stepId, localKey: step.segmentKey, step, status: 'queued' }))];
      draft.intentRoutingRecordsBySession.session.find((item: any) => item.id === version.routingId).semanticPlan = structuredClone(plan);
    }
    return result;
  }, options)) as typeof f.persistence.mutateCollections;
  // Supply the explicit test assignment; production entrypoint remains closed until admission is wired.
  // See the wrapper's resolved IDs below; no model chooses these reviewers.
  try { await correctBrief(t, f, '补充审阅要求'); } finally { f.persistence.mutateCollections = mutate; }
  return f;
}

test('assigned opinions publish atomically and final generation waits for all exact reviewers', async t => {
  const f = await directedFixture(t), originalDerivation = ['architect', 'reviewer'];
  const state = f.state(), records = state.intentPlanStepsBySession.session;
  const reviews = records.filter((row: any) => row.step.action === 'review_brief');
  const final = records.find((row: any) => row.intentRevision === 2 && row.step.action === 'prepare_brief');
  assert.deepEqual(reviews.map((row: any) => row.step.target.agentIds[0]), originalDerivation);
  const reference = { sessionId: 'session', stepId: final.id };
  await f.service.process(reference); assert.equal(f.calls.length, 1);
  assert.equal(f.state().intentPlanStepsBySession.session.find((row: any) => row.id === final.id).processing, undefined);
  const store = new IntentBriefReviewStoreService(f.persistence);
  for (const [index, review] of reviews.entries()) {
    const ref = { sessionId: 'session', stepId: review.id, ownerId: `owner-${index}`, invocationId: `call-${index}` };
    await f.persistence.mutateCollections(['intentPlanStepsBySession'], (draft: any) => {
      const row = draft.intentPlanStepsBySession.session.find((item: any) => item.id === review.id);
      row.status = 'running'; row.processing = { ownerId: ref.ownerId, invocationId: ref.invocationId, attemptsUsed: 1,
        deadlineAt: new Date(Date.now() + 120000).toISOString(), leaseExpiresAt: new Date(Date.now() + 30000).toISOString() };
    });
    await assert.rejects(store.saveResult(ref, 'foreign-agent', createAgentMessageOutput({ messageKind: 'discussion', content: '错误目标' })), /AGENT_MISMATCH/);
    await store.saveResult(ref, review.step.target.agentIds[0], createAgentMessageOutput({ messageKind: 'discussion', content: `审阅意见 ${index}` }));
    if (index === 0) {
      const write = (f.persistence as any).writeFileState.bind(f.persistence);
      (f.persistence as any).writeFileState = (saved: any) => {
        if (saved.eventsBySession.session.some((row: any) => row.id === `intent-brief-review:${review.id}`)) throw new Error('opinion disk failure');
        return write(saved);
      };
      try { await assert.rejects(store.publish(ref), /opinion disk failure/); } finally { (f.persistence as any).writeFileState = write; }
      assert.equal(f.state().intentPlanStepsBySession.session.find((row: any) => row.id === review.id).status, 'running');
    }
    const outcomes = await Promise.all([store.publish(ref), store.publish(ref)]);
    assert.deepEqual(outcomes.map(row => row.idempotentReplay).sort(), [false, true]);
    if (index === 0) { await f.service.process(reference); assert.equal(f.calls.length, 1); }
  }
  await f.service.process(reference); assert.equal(f.calls.length, 2);
  const envelope = f.calls[1].contextEnvelopeFactory({ identity: { agentId: 'coordinator', profileHash: 'profile', profileRevision: 1 }, toolCatalog: { catalogHash: 'empty' } });
  assert.ok(envelope.L5.bullets.some((text: string) => text.includes('审阅意见 0') && text.includes('审阅意见 1') && text.includes('untrusted suggestions')));
  assert.equal(f.state().briefsBySession.session.length, 2);
  assert.equal(f.state().eventsBySession.session.filter((row: any) => row.metadata.payload?.code === 'INTENT_BRIEF_REVIEW_COMPLETED').length, 2);
  assert.equal(f.state().decisionRecordsBySession.session.some((row: any) => row.content.includes('审阅意见')), false);
  await assert.rejects(f.persistence.mutateCollections(['intentPlanStepsBySession'], (draft: any) => {
    draft.intentPlanStepsBySession.session.find((row: any) => row.id === reviews[0].id).processing.result.content = '篡改意见';
  }), /INTENT_BRIEF_REVIEW_RECEIPT_IMMUTABLE/);
});


test('a later successful reviewer cannot hide a sibling failure in the route status', async t => {
  const f = await directedFixture(t, async input => input.phase !== 'brief_revision' ? { status: 'completed', output } :
    input.agent.id === 'architect' ? { status: 'failed', error: { code: 'MODEL_ERROR', retryable: false } } :
      { status: 'completed', output: createAgentMessageOutput({ messageKind: 'discussion', content: '审阅通过' }) });
  const steps = f.state().intentPlanStepsBySession.session.filter((row: any) => row.step.action === 'review_brief');
  for (const step of steps) await f.service.process({ sessionId: 'session', stepId: step.id });
  assert.equal(f.state().intentRoutingRecordsBySession.session[0].actionStatus, 'failed');
  assert.equal(f.state().briefsBySession.session.length, 1);
});

test('each assigned reviewer gets an isolated operation; retry only the failed reviewer then finalize', async t => {
  let recover = false;
  const f = await directedFixture(t, async input => {
    if (input.phase !== 'brief_revision') return { status: 'completed', output };
    if (input.agent.id === 'reviewer' && !recover) return { status: 'failed', error: { code: 'MODEL_ERROR', retryable: false } };
    return { status: 'completed', output: createAgentMessageOutput({ messageKind: 'discussion', content: `意见来自 ${input.agent.id}` }) };
  });
  const reviews = f.state().intentPlanStepsBySession.session.filter((row: any) => row.step.action === 'review_brief');
  for (const step of reviews) await f.service.process({ sessionId: 'session', stepId: step.id });
  assert.equal(f.state().briefsBySession.session.length, 1);
  assert.equal(f.calls.filter(row => row.phase === 'brief_revision').length, 2);
  assert.deepEqual(f.calls.filter(row => row.phase === 'brief_revision').map(row => row.agent.id), ['architect', 'reviewer']);
  for (const input of f.calls.filter(row => row.phase === 'brief_revision')) {
    assert.equal(input.expectedOutput.kind, 'agent_message'); assert.deepEqual(input.effectScope.effects, []);
    assert.deepEqual(input.workspace.capabilities, { read: false, write: false, command: false, test: false });
    const envelope = input.contextEnvelopeFactory({ identity: { agentId: input.agent.id, profileHash: 'p', profileRevision: 1 }, toolCatalog: { catalogHash: 'empty' } });
    assert.ok(envelope.L5.bullets.some((text: string) => text.includes('Original draft')));
  }
  const failed = f.state().intentPlanStepsBySession.session.find((row: any) => row.id === reviews[1].id);
  const route = f.state().intentRoutingRecordsBySession.session.find((row: any) => row.id === failed.routingId);
  recover = true;
  const service = new IntentBriefRetryService(f.persistence, { schedule: () => {} } as never);
  const recovery = await service.view('session', failed.id, 'user');
  assert.equal(recovery.action, 'review_brief'); assert.equal(recovery.reviewerId, 'reviewer');
  assert.equal(recovery.reviewerName, 'reviewer'); assert.equal(recovery.canRetry, true);
  await service.retry('session', failed.id, 'user', { contractVersion: 'intent-brief-retry-v1', dataEpoch: 'epoch',
    expectedRoutingRevision: route.routingRevision, expectedIntentRevision: failed.intentRevision,
    expectedOperationId: `brief:${failed.id}`, idempotencyKey: 'reviewer-retry' });
  await f.service.process({ sessionId: 'session', stepId: failed.id });
  const final = f.state().intentPlanStepsBySession.session.find((row: any) => row.intentRevision === 2 && row.step.action === 'prepare_brief');
  await f.service.process({ sessionId: 'session', stepId: final.id });
  assert.equal(f.calls.filter(row => row.agent.id === 'architect').length, 1);
  assert.equal(f.calls.filter(row => row.agent.id === 'reviewer').length, 2);
  assert.equal(f.state().briefsBySession.session.length, 2);
  const finalCall = f.calls.filter(row => row.phase === 'brief_generation').at(-1)!;
  const envelope = finalCall.contextEnvelopeFactory({ identity: { agentId: 'coordinator', profileHash: 'p', profileRevision: 1 }, toolCatalog: { catalogHash: 'empty' } });
  assert.ok(envelope.L5.bullets.some((text: string) => text.includes('意见来自 architect') && text.includes('意见来自 reviewer')));
});
