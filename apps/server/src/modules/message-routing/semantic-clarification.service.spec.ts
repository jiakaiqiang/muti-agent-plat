import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { intentUnderstandingExample, type ClarifyIntentRoutingInput, type CollaborationEvent, type IntentRoutingRecord, type SessionDetail } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import { IntentUnderstandingRoutingService } from '../intent-recognition/intent-understanding-routing.service.js';
import { IntentPlanCommitService } from './intent-plan-commit.service.js';
import { SemanticClarificationService } from './semantic-clarification.service.js';
import { bindIntentClarification } from './intent-clarification.js';

async function fixture(t: TestContext, existing = false, selectedInheritance = false) {
  const root = await mkdtemp(join(tmpdir(), 'semantic-clarification-'));
  const persistence = new PersistenceService({ backend: 'file', filePath: join(root, 'state.json') }); await persistence.initialize();
  const services: SemanticClarificationService[] = [];
  t.after(async () => { services.forEach(service => service.onModuleDestroy()); await persistence.onModuleDestroy();
    const child = relative(resolve(tmpdir()), resolve(root)); assert.ok(child.startsWith('semantic-clarification-') && !child.includes('..') && !isAbsolute(child));
    await rm(root, { recursive: true, force: true }); });
  let session: SessionDetail = { id: 'session', dataEpoch: 'epoch', ownerId: 'user', workspaceId: 'workspace', title: '澄清',
    originalInput: '处理新的天气查询需求', status: 'PAUSED', tokenUsed: 0, participatingAgentIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await persistence.setCollection('sessions', [session]); await new SessionLifecycleStore(persistence).initialize('session', 'epoch');
  const context = new ContextManagementService(persistence);
  if (existing) { const work = await context.ensureInitialWorkItem(session, 'initial');
    await context.recordDecision({ session, workItemId: work.id, sourceEventId: 'constraint', kind: 'constraint', content: '旧任务必须使用 MySQL' }); }
  session = persistence.getCollection<SessionDetail[]>('sessions', [])[0]; session.intentContractVersion = 'intent-understanding-v1';
  await persistence.setCollection('sessions', [session]);
  const event: CollaborationEvent = { id: 'message', sessionId: 'session', type: 'user_message', content: session.originalInput,
    toAgentIds: [], createdAt: session.createdAt, metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: {} } };
  await persistence.setCollection('eventsBySession', { session: [event] });
  const route = await context.createRoutingRecord({ session, sourceEventId: event.id, idempotencyKey: 'route', rolloutMode: 'enforce_all_current_epoch' });
  await persistence.mutateCollections(['intentRoutingRecordsBySession'], draft => {
    (draft.intentRoutingRecordsBySession as Record<string, IntentRoutingRecord[]>).session[0].semanticContractVersion = 'intent-understanding-v1';
  });
  const snapshot = await context.buildIntentSnapshot({ session, sourceEventId: event.id, currentMessage: event.content, latestEventSeq: 1 });
  const ambiguous = structuredClone(intentUnderstandingExample);
  Object.assign(ambiguous.segments[0], { dialogueAct: 'command', scopeRelation: 'ambiguous', suggestedAction: 'clarify', contextPolicy: 'ask_user',
    goal: event.content, target: { workItemId: null, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: null }, requestedEffects: [],
    prohibitions: [], dependencies: [], evidence: [{ refId: 'request', sourceEventId: event.id, start: 0, end: event.content.length, quote: event.content }] });
  if (selectedInheritance) Object.assign(ambiguous.segments[0].target, { decisionIds: snapshot.validDecisionIds.slice(0, 1) });
  const proposal = await new IntentUnderstandingRoutingService(persistence, context, { understand: async () => ({ status: 'valid', understanding: ambiguous }) } as never)
    .classify({ sessionId: 'session', routingId: route.id, snapshotId: snapshot.id });
  const plans = new IntentPlanCommitService(persistence, { listAll: () => [{ type: 'generic_llm' }] } as never);
  await plans.commit({ sessionId: 'session', routingId: route.id, actorId: 'user', expectedRoutingRevision: proposal.routingRevision! });
  const card = persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {}).session.find(row => row.type === 'intent_clarification_required')!;
  assert.ok(card, 'a new-contract clarification must have an actionable card');
  const request: ClarifyIntentRoutingInput = { contractVersion: 'intent-clarify-v1', confirmationId: String(card.metadata.payload!.confirmationId),
    expectedRoutingRevision: Number(card.metadata.payload!.routingRevision), idempotencyKey: 'choice', choice: 'independent_new' };
  const calls: any[] = []; let hook: (input: any, output: any) => Promise<any> = async (_input, output) => ({ status: 'valid', understanding: output });
  const make = () => { const service = new SemanticClarificationService(persistence, context, { understand: async (input: any) => {
    calls.push(input); const output = structuredClone(ambiguous), segment = output.segments[0];
    const choice = input.clarification.choice;
    Object.assign(segment, { scopeRelation: choice === 'continue_current' ? 'same_requirement' : choice === 'related_new' ? 'related_new_requirement' : existing ? 'independent_new_requirement' : 'initial_requirement',
      suggestedAction: choice === 'continue_current' ? 'record_information' : choice === 'related_new' ? 'create_related_work_item' : existing ? 'create_independent_work_item' : 'create_initial_work_item',
      contextPolicy: choice === 'continue_current' ? 'inherit_confirmed' : choice === 'related_new' ? 'inherit_selected' : 'clean_task_context',
      target: { ...segment.target, workItemId: choice === 'independent_new' ? null : input.clarification.activeWorkItemId,
        decisionIds: choice === 'related_new' ? input.clarification.inheritedDecisionIds : [], artifactIds: choice === 'related_new' ? input.clarification.inheritedArtifactIds : [] } });
    return hook(input, output);
  } } as never, plans); services.push(service); return service; };
  return { persistence, context, session, route, plans, card, request, calls, make, ambiguous, setHook: (value: typeof hook) => { hook = value; },
    reference: { sessionId: 'session', routingId: route.id }, current: () => context.listRoutingRecords('session').find(row => row.id === route.id)! };
}

test('first-turn clarification needs no fake WorkItem or follow-up; commits both history versions and one receipt', async t => {
  const f = await fixture(t), service = f.make(); assert.equal(f.context.listWorkItems('session').length, 0);
  const result = await service.resolve(f.reference, 'user', f.request);
  assert.equal(result.routing.status, 'ROUTED'); assert.equal(result.routing.currentIntentRevision, 2);
  assert.equal(f.context.listWorkItems('session').length, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].snapshot.currentMessage, f.session.originalInput);
  assert.equal(f.current().semanticClarification?.attemptsUsed, 1);
  const versions = f.persistence.getCollection<Record<string, any[]>>('intentRouteRevisionsBySession', {}).session;
  assert.equal(versions.length, 2); assert.equal(versions[0].validatedPlan.outcome, 'needs_clarification');
  assert.equal(versions[1].validatedPlan.outcome, 'applicable');
  assert.equal(f.persistence.getCollection<Record<string, any[]>>('intentResolutionReceiptsBySession', {}).session.length, 1);
  const replay = await service.resolve(f.reference, 'user', f.request); assert.equal(replay.idempotentReplay, true); assert.equal(f.calls.length, 1);
  assert.equal(f.persistence.getCollection<SessionDetail[]>('sessions', [])[0].status, 'PAUSED');
});

test('concurrent matching choices share classification; opposite choices and foreign actors fail', async t => {
  const f = await fixture(t, true); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.setHook(async (_input, output) => { await gate; return { status: 'valid', understanding: output }; });
  const service = f.make(), first = service.resolve(f.reference, 'user', f.request);
  const waiting = first.catch(error => { release(); throw error; });
  const deadline = Date.now() + 3000;
  while (!f.calls.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(f.calls.length, 'classification started');
  await assert.rejects(f.make().resolve(f.reference, 'user', { ...f.request, choice: 'related_new', idempotencyKey: 'opposite' }), /CLARIFICATION_CHOICE_CONFLICT/);
  await assert.rejects(service.resolve(f.reference, 'foreign', f.request), /INTENT_SESSION_UNAVAILABLE/);
  const second = service.resolve(f.reference, 'user', f.request); release(); await Promise.all([waiting, second]);
  assert.equal(f.calls.length, 1); assert.equal(f.context.listWorkItems('session').length, 2);
  await assert.rejects(service.resolve(f.reference, 'user', { ...f.request, choice: 'related_new', idempotencyKey: 'opposite' }), /CLARIFICATION_CHOICE_CONFLICT/);
});

test('related clarification shows and binds an empty inheritance set instead of inheriting all old constraints', async t => {
  const f = await fixture(t, true);
  assert.deepEqual(f.card.metadata.payload!.inheritedDecisionIds, []);
  const result = await f.make().resolve(f.reference, 'user', { ...f.request, choice: 'related_new' });
  assert.deepEqual(result.workItem?.inheritedDecisionIds, []); assert.ok(result.workItem?.parentWorkItemId);
  assert.equal(f.context.validDecisions('session', result.workItem!.id).length, 0);
});

test('related clarification preserves exactly the displayed selected constraint', async t => {
  const f = await fixture(t, true, true);
  assert.equal((f.card.metadata.payload!.inheritedDecisionIds as string[]).length, 1);
  assert.match(String(f.card.metadata.payload!.description), /MySQL/);
  const result = await f.make().resolve(f.reference, 'user', { ...f.request, choice: 'related_new' });
  assert.deepEqual(result.workItem!.inheritedDecisionIds, f.card.metadata.payload!.inheritedDecisionIds);
  assert.deepEqual(f.context.validDecisions('session', result.workItem!.id).map(row => row.content), ['旧任务必须使用 MySQL']);
});

test('model disagreement with the structured choice never commits a plan or resolves the card', async t => {
  const f = await fixture(t); f.setHook(async (_input, output) => {
    output.segments[0].scopeRelation = 'same_requirement'; return { status: 'valid', understanding: output };
  });
  await assert.rejects(f.make().resolve(f.reference, 'user', f.request), /CLARIFICATION_CHOICE_PLAN_MISMATCH/);
  assert.equal(f.current().resolution, undefined); assert.equal(f.context.listWorkItems('session').length, 0);
});

test('stale and expired cards never invoke the model', async t => {
  for (const expired of [false, true]) {
    const f = await fixture(t);
    if (expired) await f.persistence.mutateCollections(['eventsBySession'], draft => {
      ((draft.eventsBySession as Record<string, CollaborationEvent[]>).session.find(row => row.id === f.card.id)!.metadata.payload!).expiresAt = new Date(0).toISOString();
    });
    else await f.persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].revision = 99; });
    await assert.rejects(f.make().resolve(f.reference, 'user', f.request), expired ? /CLARIFICATION_EXPIRED/ : /CLARIFICATION_SNAPSHOT_STALE/);
    assert.equal(f.calls.length, 0);
  }
});

test('one schema repair shares the clarification operation and finite durable budget', async t => {
  const f = await fixture(t); f.setHook(async (_input, output) => f.calls.length === 1 ? { status: 'invalid', previousOutput: '{}', validationErrors: ['segments missing'] } : { status: 'valid', understanding: output });
  await f.make().resolve(f.reference, 'user', f.request);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].operationId, f.calls[1].operationId);
  assert.equal(f.calls[1].repairFeedback.previousOutput, '{}'); assert.equal(f.current().semanticClarification?.attemptsUsed, 2);
});

test('clarification retries transient failures once but never retries authentication or resets its budget', async t => {
  for (const transient of [false, true]) {
    const f = await fixture(t); f.setHook(async () => ({ status: 'failed', code: transient ? 'UPSTREAM_UNAVAILABLE' : 'MODEL_AUTH_FAILED',
      failureClass: transient ? 'transient' : 'auth', retryable: transient, retryAfterMs: 100 }));
    const service = f.make();
    await assert.rejects(service.resolve(f.reference, 'user', f.request), transient ? /UPSTREAM_UNAVAILABLE/ : /MODEL_AUTH_FAILED/);
    assert.equal(f.calls.length, transient ? 2 : 1); const used = f.current().semanticClarification!.attemptsUsed;
    await assert.rejects(service.resolve(f.reference, 'user', f.request));
    assert.equal(f.current().semanticClarification!.attemptsUsed, used); assert.equal(f.current().status, 'BLOCKED');
    assert.equal(f.current().resolution, undefined);
  }
});

test('a relation selection cannot add an execution effect absent from the original proposal', async t => {
  const f = await fixture(t, true); f.setHook(async (_input, output) => {
    output.segments[0].suggestedAction = 'enqueue_follow_up';
    output.segments[0].requestedEffects = [{ kind: 'run_tests', target: { kind: 'test_runner', refId: 'forged' }, evidenceRefs: ['request'] }];
    return { status: 'valid', understanding: output };
  });
  await assert.rejects(f.make().resolve(f.reference, 'user', { ...f.request, choice: 'continue_current' }), /CLARIFICATION_EFFECT_SCOPE_EXPANDED/);
  assert.equal(f.current().resolution, undefined);
  assert.equal(f.persistence.getCollection<Record<string, any[]>>('intentPlanStepsBySession', {}).session?.length ?? 0, 0);
});

test('failed final transaction leaves no receipt, WorkItem, version or resolved event', async t => {
  const f = await fixture(t), write = (f.persistence as any).writeFileState;
  f.setHook(async (_input, output) => { (f.persistence as any).writeFileState = (state: any) => {
    if (state.intentResolutionReceiptsBySession?.session?.length) throw new Error('injected clarification commit failure'); return write.call(f.persistence, state);
  }; return { status: 'valid', understanding: output }; });
  await assert.rejects(f.make().resolve(f.reference, 'user', f.request), /CLARIFICATION_PROCESSING_FAILED/); (f.persistence as any).writeFileState = write;
  assert.equal(f.context.listWorkItems('session').length, 0); assert.equal(f.current().resolution, undefined);
  assert.equal(f.persistence.getCollection<Record<string, any[]>>('intentRouteRevisionsBySession', {}).session?.length ?? 0, 0);
  assert.equal(f.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {}).session.some(row => row.type === 'user_confirmation_resolved'), false);
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'background clarification should settle within the test deadline');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('startup recovery commits a durable ready proposal without another model call', async t => {
  const f = await fixture(t);
  const snapshot = await f.context.buildIntentSnapshot({ session: f.session, sourceEventId: 'message', currentMessage: f.session.originalInput, latestEventSeq: 0 });
  const output = structuredClone(f.ambiguous);
  Object.assign(output.segments[0], { scopeRelation: 'initial_requirement', suggestedAction: 'create_initial_work_item', contextPolicy: 'clean_task_context' });
  const binding = bindIntentClarification(f.current(), [f.card], f.request);
  await f.persistence.mutateCollections(['intentRoutingRecordsBySession'], draft => {
    (draft.intentRoutingRecordsBySession as Record<string, IntentRoutingRecord[]>).session[0].semanticClarification = {
      request: f.request, canonicalChoiceHash: binding.canonicalChoiceHash, actorId: 'user', dataEpoch: 'epoch',
      sessionGeneration: f.current().semanticProposal!.sessionGeneration!, status: 'ready', ownerId: 'dead-process', leaseExpiresAt: new Date(0).toISOString(),
      deadlineAt: new Date(Date.now() + 60000).toISOString(), attemptsUsed: 1, invocationIds: ['previous-invocation'], snapshotId: snapshot.id, understanding: output
    };
  });
  f.make().onApplicationBootstrap();
  await waitFor(() => Boolean(f.current().resolution));
  assert.equal(f.calls.length, 0);
  assert.equal(f.current().semanticClarification!.attemptsUsed, 1);
  assert.equal(f.context.listWorkItems('session').length, 1);
  assert.equal((await f.make().resolve(f.reference, 'user', f.request)).idempotentReplay, true);
});

test('startup recovery never resets the persisted classification budget', async t => {
  const f = await fixture(t), binding = bindIntentClarification(f.current(), [f.card], f.request);
  await f.persistence.mutateCollections(['intentRoutingRecordsBySession'], draft => {
    (draft.intentRoutingRecordsBySession as Record<string, IntentRoutingRecord[]>).session[0].semanticClarification = {
      request: f.request, canonicalChoiceHash: binding.canonicalChoiceHash, actorId: 'user', dataEpoch: 'epoch',
      sessionGeneration: f.current().semanticProposal!.sessionGeneration!, status: 'pending', ownerId: 'dead-process', leaseExpiresAt: new Date(0).toISOString(),
      deadlineAt: new Date(Date.now() + 60000).toISOString(), attemptsUsed: 2, invocationIds: ['attempt-1', 'attempt-2']
    };
  });
  f.make().onApplicationBootstrap();
  await waitFor(() => f.current().semanticClarification?.status === 'blocked');
  assert.equal(f.calls.length, 0); assert.equal(f.current().semanticClarification!.attemptsUsed, 2);
  assert.equal(f.current().blockedReason, 'CLARIFICATION_BUDGET_EXHAUSTED');
  assert.equal(f.current().resolution, undefined); assert.equal(f.context.listWorkItems('session').length, 0);
});

test('a late model result after session generation changes cannot resolve or create a task', async t => {
  const f = await fixture(t); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setHook(async (_input, output) => { await gate; return { status: 'valid', understanding: output }; });
  const pending = f.make().resolve(f.reference, 'user', f.request);
  const rejected = assert.rejects(pending, /CLARIFICATION_IN_PROGRESS/);
  await waitFor(() => f.calls.length === 1);
  await f.persistence.mutateCollections(['sessionLifecyclesBySession'], draft => {
    (draft.sessionLifecyclesBySession as Record<string, any>).session.generation++;
  });
  release(); await rejected;
  assert.equal(f.current().resolution, undefined); assert.equal(f.context.listWorkItems('session').length, 0);
  assert.equal(f.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {}).session.some(row => row.type === 'user_confirmation_resolved'), false);
});
