import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CollaborationEvent, CorrectIntentRoutingInput, IntentCorrection, IntentRouteRevision, IntentRoutingRecord, IntentRoutingDecisionV2, SessionDetail, SessionFollowUpMessage, WorkItem } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { LogicalOperationStore } from '../runtimes/logical-operation-store.js';
import { IntentCorrectionService, parseIntentCorrection } from './intent-correction.service.js';
import { IntentCorrectionPlannerService } from './intent-correction-planner.service.js';
import type { SemanticIntentRouterService } from '../intent-recognition/semantic-intent-router.service.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'intent-correction-'));
  const filePath = join(directory, 'state.json');
  const persistence = new PersistenceService({ backend: 'file', filePath });
  t.after(async () => { await persistence.onModuleDestroy(); rmSync(directory, { force: true, recursive: true }); });
  await persistence.initialize();
  const session: SessionDetail = { id: 'session', dataEpoch: 'epoch', revision: 1, decisionLedgerRevision: 0,
    title: '登录', originalInput: '实现登录', status: 'EXECUTING', ownerId: 'user', workspaceId: 'workspace',
    tokenUsed: 0, participatingAgentIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await persistence.setCollection('sessions', [session]);
  const context = new ContextManagementService(persistence);
  const work = await context.ensureInitialWorkItem(session, 'first');
  const route = await context.createRoutingRecord({ session, sourceEventId: 'message', idempotencyKey: 'message', rolloutMode: 'enforce_all_current_epoch' });
  await persistence.setCollection('followUpMessagesBySession', { session: [{ id: 'follow', routingId: route.id, sourceEventId: 'message', workItemId: work.id }] });
  const input: CorrectIntentRoutingInput = { contractVersion: 'intent-correction-v1', expectedRoutingRevision: route.routingRevision ?? 1,
    idempotencyKey: 'correct-1', instruction: '不是新需求，是当前登录任务的补充。', targetWorkItemId: work.id,
    supersedesDecisionId: null, expectedDecisionRevision: null };
  const service = new IntentCorrectionService(persistence);
  return { persistence, filePath, session, context, work, route, input, service,
    accept: (patch: Partial<CorrectIntentRoutingInput> = {}) => service.accept(session.id, route.id, session.ownerId, { ...input, ...patch }) };
}

test('same-key concurrent correction creates one hold, immutable baseline and atomic event/outbox pair', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.accept(), f.accept()]);
  assert.equal(results[0].correction.id, results[1].correction.id);
  assert.deepEqual(results.map(result => result.idempotentReplay).sort(), [false, true]);
  const work = f.context.getWorkItem('session', f.work.id);
  assert.equal(work.executionEpoch, 2);
  assert.equal(work.requirementRevision, 1);
  assert.equal(work.dispatchHold?.correctionId, results[0].correction.id);
  assert.equal(f.service.list('session', f.route.id).length, 1);
  assert.equal(f.service.history('session', f.route.id)[0].authorizationState, 'unknown');
  assert.equal(f.service.history('session', f.route.id)[0].validatedPlan, null);
  assert.deepEqual(f.persistence.getCollection('intentResolutionReceiptsBySession', {}), {});
  const events = f.persistence.getCollection<Record<string, Array<{ id: string }>>>('eventsBySession', {}).session;
  const added = events.filter(event => event.id.startsWith('intent-correction:'));
  assert.equal(added.length, 2);
  const outbox = f.persistence.getCollection<Array<{ id: string }>>('eventOutbox', []);
  assert.equal(added.filter(event => outbox.some(record => record.id === `outbox:${event.id}`)).length, 2);
});

test('different corrections racing on the same route revision have one winner', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.accept(), f.accept({ idempotencyKey: 'second', instruction: '另一个纠正' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(String(rejection.reason), /ROUTING_REVISION_CONFLICT/);
  assert.equal(f.context.getWorkItem('session', f.work.id).executionEpoch, 2);
});

test('payload reuse, stale revision, invalid owner and cross-session targets never create holds', async t => {
  const f = await fixture(t);
  await assert.rejects(f.accept({ expectedRoutingRevision: 999 }), /ROUTING_REVISION_CONFLICT/);
  await assert.rejects(f.service.accept('session', f.route.id, 'another-user', f.input), /SESSION_UNAVAILABLE/);
  await assert.rejects(f.accept({ targetWorkItemId: 'foreign-work' }), /WORK_ITEM_NOT_FOUND/);
  await assert.rejects(f.service.accept('session', 'foreign-route', 'user', f.input), /ROUTING_NOT_FOUND/);
  assert.equal(f.context.getWorkItem('session', f.work.id).dispatchHold, undefined);
  await f.accept();
  await assert.rejects(f.accept({ instruction: '不同请求' }), /IDEMPOTENCY_PAYLOAD_CONFLICT/);
  assert.equal(f.service.list('session', f.route.id).length, 1);
});

test('correction cannot accept client model authority or malformed decision version', () => {
  const input = { contractVersion: 'intent-correction-v1', expectedRoutingRevision: 1, idempotencyKey: 'one',
    instruction: '纠正', targetWorkItemId: null, supersedesDecisionId: null, expectedDecisionRevision: null };
  for (const patch of [{ safeToApply: true }, { modelDecision: {} }, { capabilities: ['write_file'] },
    { expectedRoutingRevision: 0 }, { expectedDecisionRevision: 1 }, { instruction: ' ' }, { instruction: 'x'.repeat(8001) }]) {
    assert.throws(() => parseIntentCorrection({ ...input, ...patch }), /INVALID_INTENT_CORRECTION/);
  }
});

test('hold denies queued and ownerless legacy business dispatch but preserves other explicit WorkItems and routing lane', async t => {
  const f = await fixture(t);
  const other = await f.context.createWorkItem({ session: f.session, sourceEventId: 'other', title: '其他任务', goal: '其他任务', activate: false });
  const store = new LogicalOperationStore(f.persistence);
  const input = { id: 'queued', sessionId: 'session', workItemId: f.work.id, phase: 'task_execution' as const };
  await store.begin(input);
  await f.accept();
  await assert.rejects(store.reserve('session', 'queued', 'never-start'), /INTENT_DISPATCH_HELD/);
  await assert.rejects(store.begin({ ...input, id: 'new' }), /INTENT_DISPATCH_HELD/);
  await assert.rejects(store.begin({ ...input, id: 'unknown', workItemId: undefined }), /INTENT_DISPATCH_HELD/);
  const unaffected = await store.begin({ ...input, id: 'other', workItemId: other.id });
  await store.reserve('session', unaffected.id, 'allowed', { executionKind: 'internal' });
  await store.settle('session', unaffected.id, 'allowed');
  await store.begin({ id: 'classify', sessionId: 'session', phase: 'user_message_routing', admissionClass: 'routing', dataEpoch: 'epoch' });
  assert.equal(f.persistence.getCollection<SessionDetail[]>('sessions', [])[0].status, 'EXECUTING');
});

test('hold is re-read after reservation and survives a persistence/service restart', async t => {
  const f = await fixture(t);
  const store = new LogicalOperationStore(f.persistence);
  const input = { id: 'running', sessionId: 'session', workItemId: f.work.id, phase: 'task_execution' as const };
  await store.begin(input);
  await store.reserve('session', input.id, 'reserved', { executionKind: 'internal' });
  const result = await f.accept();
  assert.deepEqual(result.correction.affectedExecutionIds, ['reserved']);
  await assert.rejects(store.assertCurrentIntent(input), /INTENT_DISPATCH_HELD/);
  const restored = new PersistenceService({ backend: 'file', filePath: f.filePath });
  await restored.initialize(); t.after(() => restored.onModuleDestroy());
  const service = new IntentCorrectionService(restored);
  assert.equal((await service.accept('session', f.route.id, 'user', f.input)).idempotentReplay, true);
  await service.reconcileStop(result.correction);
  assert.equal(service.list('session', f.route.id)[0].status, 'reconciliation_required');
  await assert.rejects(new LogicalOperationStore(restored).assertCurrentIntent(input), /INTENT_DISPATCH_HELD/);
});

test('file commit failure leaves neither receipt, epoch change nor correction events', async t => {
  const f = await fixture(t);
  const bytes = readFileSync(f.filePath, 'utf8');
  const write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = () => { throw new Error('injected disk failure'); };
  await assert.rejects(f.accept(), /injected disk failure/);
  (f.persistence as any).writeFileState = write;
  assert.equal(readFileSync(f.filePath, 'utf8'), bytes);
  assert.equal(f.service.list('session', f.route.id).length, 0);
  assert.equal(f.context.getWorkItem('session', f.work.id).executionEpoch, undefined);
  assert.equal((await f.accept()).idempotentReplay, false);
});

test('late classifier update is rejected and held route cannot be reclaimed', async t => {
  const f = await fixture(t);
  await f.accept();
  await assert.rejects(f.context.updateRoutingRecord('session', f.route.id, { reasonCodes: ['old result'] }), /INTENT_DISPATCH_HELD/);
  assert.equal((await f.context.claimIntentRouting('session', f.route.id, 'snapshot', 'worker')).state, 'terminal');
});

test('immutable version payload, duplicate identities and cross-scope correction changes are rejected', async t => {
  const f = await fixture(t);
  await f.accept();
  await assert.rejects(f.persistence.mutateCollections(['intentRouteRevisionsBySession'], draft => {
    (draft.intentRouteRevisionsBySession as Record<string, IntentRouteRevision[]>).session[0].authorizationState = 'validated';
  }), /INTENT_RECORD_IMMUTABLE/);
  const versions = f.persistence.getCollection<Record<string, IntentRouteRevision[]>>('intentRouteRevisionsBySession', {});
  versions.session[0].authorizationState = 'validated';
  assert.throws(() => f.persistence.setCollection('intentRouteRevisionsBySession', versions), /INTENT_RECORD_IMMUTABLE/);
  await assert.rejects(f.persistence.mutateCollections(['intentRouteRevisionsBySession'], draft => {
    const rows = (draft.intentRouteRevisionsBySession as Record<string, IntentRouteRevision[]>).session;
    rows.push({ ...rows[0], id: 'another-id' });
  }), /INTENT_RECORD_UNIQUE_CONFLICT/);
  await assert.rejects(f.persistence.mutateCollections(['intentCorrectionsBySession'], draft => {
    (draft.intentCorrectionsBySession as Record<string, IntentCorrection[]>).session[0].status = 'applied';
  }, { sessionIds: ['other-session'] }), /COLLECTION_SCOPE_VIOLATION/);
  await assert.rejects(f.persistence.mutateCollections(['intentRouteRevisionsBySession'], draft => {
    const rows = (draft.intentRouteRevisionsBySession as Record<string, IntentRouteRevision[]>).session;
    rows.push({ ...rows[0], id: 'foreign-route-version', routingId: 'not-in-session' });
  }), /INTENT_RECORD_BINDING_MISMATCH/);
});

test('correction processing never treats stopped as applied or releases a hold without a validated new plan', async t => {
  const f = await fixture(t);
  const result = await f.accept();
  await f.service.reconcileStop(result.correction);
  assert.equal(f.service.list('session', f.route.id)[0].status, 'validating');
  const work = f.context.getWorkItem('session', f.work.id);
  assert.equal(work.dispatchHold?.correctionId, result.correction.id);
  assert.equal(work.requirementRevision, 1);
  assert.equal(f.service.history('session', f.route.id).length, 1);
});

test('a new execution cannot recover historical write authority after a correction', async t => {
  const f = await fixture(t);
  await f.accept();
  await f.persistence.mutateCollections(['workItemsBySession', 'intentRoutingRecordsBySession'], draft => {
    delete (draft.workItemsBySession as Record<string, WorkItem[]>).session[0].dispatchHold;
    delete (draft.intentRoutingRecordsBySession as Record<string, Array<{ dispatchHold?: unknown }>>).session[0].dispatchHold;
  });
  const store = new LogicalOperationStore(f.persistence);
  await assert.rejects(store.begin({ id: 'legacy-resume', sessionId: 'session', phase: 'task_execution', workItemId: f.work.id }), /INTENT_EXECUTION_BINDING_REQUIRED/);
  await assert.rejects(store.begin({ id: 'forged', sessionId: 'session', phase: 'task_execution', workItemId: f.work.id,
    executionBinding: { routingId: f.route.id, intentRevision: 1, requirementRevision: 1, executionEpoch: 2,
      sessionGeneration: 1, decisionSetHash: 'fake', effectScopeHash: 'fake' } }), /INTENT_EXECUTION_SCOPE_STALE/);
});

test('session deletion removes all new records and a late correction worker cannot recreate them', async t => {
  const f = await fixture(t);
  const result = await f.accept();
  await f.persistence.deleteSessionData('session');
  await f.service.reconcileStop(result.correction);
  assert.equal(f.service.list('session', f.route.id).length, 0);
  assert.equal(f.service.history('session', f.route.id).length, 0);
  await assert.rejects(f.accept(), /SESSION_UNAVAILABLE/);
});

test('queued step invalidation preserves completed effects and immutable plan content', async t => {
  const f = await fixture(t);
  const step = { target: { workItemId: f.work.id } };
  const record = { sessionId: 'session', dataEpoch: 'epoch', routingId: f.route.id, intentRevision: 1,
    step, reusedEffectIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await f.persistence.setCollection('intentPlanStepsBySession', { session: [
    { ...record, id: 'queued-step', localKey: 'queue', status: 'queued' },
    { ...record, id: 'completed-step', localKey: 'done', status: 'completed' }
  ] });
  await f.accept();
  const records = f.persistence.getCollection<Record<string, Array<{ status: string; step: unknown }>>>('intentPlanStepsBySession', {}).session;
  assert.deepEqual(records.map(item => item.status), ['invalidated', 'completed']);
  assert.deepEqual(records.map(item => item.step), [step, step]);
});


async function chatFixture(t: TestContext, options: { reply?: boolean; oldSelection?: boolean; attempts?: number } = {}) {
  const f = await fixture(t);
  const old = await f.context.recordDecision({ session: f.session, workItemId: f.work.id, sourceEventId: f.route.sourceEventId,
    kind: 'constraint', content: '超时为 10 分钟' });
  const source = await f.context.createRoutingRecord({ session: f.session, sourceEventId: 'chat-correction-input',
    idempotencyKey: 'chat-correction-input', rolloutMode: 'enforce_all_current_epoch' });
  const content = '超时改为 30 分钟，原 10 分钟作废。';
  const now = new Date().toISOString();
  const event: CollaborationEvent = { id: source.sourceEventId, sessionId: f.session.id, type: 'user_message',
    actor: { type: 'user', id: f.session.ownerId }, content, toAgentIds: [], createdAt: now,
    metadata: { schemaVersion: '0.1', renderAs: 'chat_message' } };
  await f.persistence.setCollection('eventsBySession', { session: [{ ...event, id: f.route.sourceEventId, content: old.content }, event] });
  const follow: SessionFollowUpMessage = { id: 'chat-follow', routingId: source.id, sourceEventId: event.id, content,
    workItemId: f.work.id, mentionedAgentIds: [], status: 'queued', queuedAt: now,
    ...(options.reply ? { replyToEventId: f.route.sourceEventId } : {}),
    handlingPlan: { intent: 'clarification', priority: 'normal', shouldPause: false, affectedTaskIds: [], affectedAgentIds: [],
      requiresBriefRevision: false, requiresUserConfirmation: true, coordinatorInstruction: 'pending' } };
  await f.persistence.setCollection('followUpMessagesBySession', { session: [
    ...f.context.listFollowUps('session'), follow] });
  f.session.pendingFollowUpMessages = [follow];
  await f.persistence.setCollection('sessions', [f.session]);
  const snapshot = await f.context.buildIntentSnapshot({ session: f.session, sourceEventId: event.id, currentMessage: content,
    latestEventSeq: 2, replyToEventId: follow.replyToEventId });
  const decision: IntentRoutingDecisionV2 = { dialogueAct: 'correction', scopeRelation: 'same_requirement', contextPolicy: 'inherit_confirmed',
    requestedAction: 'continue_active_work_item', selectedWorkItemId: f.work.id,
    selectedDecisionIds: options.oldSelection === false ? [] : [old.id], selectedArtifactIds: [], requestedAgentIds: [],
    goalSegments: [content], missingFields: [], ambiguityReasons: [], reasonCodes: [], riskLevel: 'low', modelConfidence: 0.9 };
  await f.context.updateRoutingRecord('session', source.id, { status: 'SNAPSHOT_READY', snapshotId: snapshot.id });
  await f.context.updateRoutingRecord('session', source.id, { status: 'CLASSIFYING' });
  for (let attempt = 0; attempt < (options.attempts ?? 1); attempt++) {
    await f.context.reserveIntentClassificationAttempt('session', source.id, `chat-classification-${attempt}`, attempt ? 'schema_repair' : 'classification');
  }
  const classified = await f.context.updateRoutingRecord('session', source.id, { status: 'VALIDATING', decision });
  return { ...f, old, source: classified, follow, event, snapshot, decision,
    acceptChat: () => f.service.acceptMessage('session', 'user', source.id) };
}

test('chat correction atomically consumes original input and freezes old route with one receipt across replay/restart', async t => {
  const f = await chatFixture(t);
  const other = await f.context.createWorkItem({ session: f.session, sourceEventId: 'unrelated', title: '其他任务', goal: '其他任务', activate: false });
  // Rebuild after creating an unrelated WorkItem; the persisted snapshot must describe current business facts.
  const snapshot = await f.context.buildIntentSnapshot({ session: f.session, sourceEventId: f.event.id, currentMessage: f.event.content, latestEventSeq: 2 });
  await f.context.updateRoutingRecord('session', f.source.id, { snapshotId: snapshot.id });
  const results = await Promise.all([f.acceptChat(), f.acceptChat()]);
  assert.equal(results[0].correction.id, results[1].correction.id);
  const correction = results[0].correction;
  assert.equal(correction.sourceEventId, f.event.id);
  assert.equal(correction.originRoutingId, f.source.id);
  assert.equal(correction.originFollowUpId, f.follow.id);
  assert.equal(correction.request.instruction, f.event.content);
  assert.equal(correction.request.supersedesDecisionId, f.old.id);
  assert.equal(correction.request.expectedDecisionRevision, f.old.revision);
  assert.equal(correction.processing?.attemptsUsed, 1);
  assert.equal(correction.processing?.deadlineAt, f.source.classificationDeadlineAt);
  assert.equal(f.context.getWorkItem('session', f.work.id).dispatchHold?.correctionId, correction.id);
  assert.equal(f.context.getWorkItem('session', other.id).dispatchHold, undefined);
  assert.equal(f.context.listFollowUps('session').find(row => row.id === f.follow.id)?.status, 'cancelled');
  assert.equal(f.persistence.getCollection<SessionDetail[]>('sessions', [])[0].pendingFollowUpMessages?.length, 0);
  assert.equal(f.context.listRoutingRecords('session').find(row => row.id === f.source.id)?.reasonCodes[0], 'CORRECTION_ACCEPTED');
  const events = f.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {}).session;
  assert.equal(events.filter(row => row.type === 'user_message').length, 2, 'reuse original chat event without duplicating user input');
  assert.equal(events.filter(row => row.type === 'intent_correction_requested').length, 1);
  const restored = new PersistenceService({ backend: 'file', filePath: f.filePath });
  await restored.initialize(); t.after(() => restored.onModuleDestroy());
  const replay = await new IntentCorrectionService(restored).acceptMessage('session', 'user', f.source.id);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.correction.id, correction.id);
});

test('chat correction without a unique old target clarifies without any hold or ledger mutation', async t => {
  const f = await chatFixture(t, { oldSelection: false });
  await assert.rejects(f.acceptChat(), /CORRECTION_TARGET_REQUIRED/);
  await f.service.clarifyMessage('session', f.source.id, f.source.routingRevision!, 'CORRECTION_TARGET_REQUIRED');
  assert.equal(f.context.getWorkItem('session', f.work.id).dispatchHold, undefined);
  assert.equal(f.context.listDecisions('session').find(row => row.id === f.old.id)?.status, 'confirmed');
  assert.equal(f.service.list('session', f.route.id).length, 0);
  assert.equal(f.context.listFollowUps('session').find(row => row.id === f.follow.id)?.status, 'cancelled');
  const events = f.persistence.getCollection<Record<string, CollaborationEvent[]>>('eventsBySession', {}).session;
  assert.equal(events.at(-1)?.metadata.renderAs, 'chat_message');
  assert.match(events.at(-1)!.content, /未修改任务/);
  assert.ok(f.persistence.getCollection<Array<{ id: string }>>('eventOutbox', []).some(row => row.id === `outbox:${events.at(-1)!.id}`));
});

test('a reply identifies a route but does not fabricate a Decision replacement', async t => {
  const f = await chatFixture(t, { oldSelection: false, reply: true });
  const { correction } = await f.acceptChat();
  assert.equal(correction.routingId, f.route.id);
  assert.equal(correction.request.supersedesDecisionId, null);
  assert.equal(correction.request.expectedDecisionRevision, null);
});

test('chat target revisions, source text, leases and policy are checked in the acceptance transaction', async t => {
  for (const kind of ['target-version', 'decision-version', 'source-text', 'lease', 'resume', 'foreign-work', 'multiple-goals', 'snapshot'] as const) {
    const f = await chatFixture(t);
    if (kind === 'target-version') await f.context.updateRoutingRecord('session', f.route.id, { reasonCodes: ['changed'] });
    if (kind === 'decision-version') await f.persistence.mutateCollections(['decisionRecordsBySession'], draft => {
      (draft.decisionRecordsBySession as Record<string, Array<{ revision: number }>>).session[0].revision++;
    });
    if (kind === 'source-text') await f.persistence.mutateCollections(['eventsBySession'], draft => {
      (draft.eventsBySession as Record<string, CollaborationEvent[]>).session.find(row => row.id === f.event.id)!.content = 'different instruction';
    });
    if (kind === 'lease') await f.context.updateRoutingRecord('session', f.source.id, { leaseOwner: 'other', leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() });
    if (kind === 'resume') await f.context.updateRoutingRecord('session', f.source.id, { decision: { ...f.decision, requestedAction: 'resume' } });
    if (kind === 'foreign-work') await f.context.updateRoutingRecord('session', f.source.id, { decision: { ...f.decision, selectedWorkItemId: 'foreign-work' } });
    if (kind === 'multiple-goals') await f.context.updateRoutingRecord('session', f.source.id, { decision: { ...f.decision, goalSegments: ['first', 'second'] } });
    if (kind === 'snapshot') await f.persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].revision!++; });
    await assert.rejects(f.acceptChat(), /CORRECTION_|ROUTING_LEASE_LOST/, kind);
    assert.equal(f.context.getWorkItem('session', f.work.id).dispatchHold, undefined, kind);
    assert.equal(f.service.list('session', f.route.id).length, 0, kind);
  }
});

test('chat correction commit failure rolls back input consumption, route status, hold and outbox together', async t => {
  const f = await chatFixture(t);
  const bytes = readFileSync(f.filePath, 'utf8');
  const write = (f.persistence as any).writeFileState.bind(f.persistence);
  (f.persistence as any).writeFileState = () => { throw new Error('chat disk failure'); };
  await assert.rejects(f.acceptChat(), /chat disk failure/);
  (f.persistence as any).writeFileState = write;
  assert.equal(readFileSync(f.filePath, 'utf8'), bytes);
  assert.equal(f.context.listFollowUps('session').find(row => row.id === f.follow.id)?.status, 'queued');
  assert.equal(f.context.listRoutingRecords('session').find(row => row.id === f.source.id)?.status, 'VALIDATING');
  assert.equal(f.context.getWorkItem('session', f.work.id).dispatchHold, undefined);
  assert.equal((await f.acceptChat()).idempotentReplay, false);
});


test('chat correction activation shares the original two-call budget and uses the original input as exact evidence', async t => {
  for (const attempts of [1, 2]) {
    const f = await chatFixture(t, { attempts });
    const { correction } = await f.acceptChat();
    let calls = 0;
    const semantic = { understand: async (input: Parameters<SemanticIntentRouterService['understand']>[0]) => {
      calls++;
      assert.equal(input.parentOperationId, f.source.id);
      assert.equal(input.snapshot.sourceEventId, f.event.id);
      assert.equal(input.snapshot.currentMessage, f.event.content);
      return { status: 'valid', understanding: { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
        segments: [{ localKey: 'correction', dialogueAct: 'correction', goal: f.event.content, scopeRelation: 'same_requirement',
          suggestedAction: 'correct_route', contextPolicy: 'inherit_confirmed',
          target: { workItemId: f.work.id, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: f.route.id },
          correction: { supersedesDecisionId: f.old.id, expectedDecisionRevision: f.old.revision, replacementText: f.event.content },
          requestedEffects: [], prohibitions: [], dependencies: [],
          evidence: [{ refId: 'original', sourceEventId: f.event.id, start: 0, end: f.event.content.length, quote: f.event.content }] }],
        missingFields: [], ambiguityReasons: [], modelConfidence: 0.99 } };
    } } as unknown as SemanticIntentRouterService;
    const planner = new IntentCorrectionPlannerService(f.persistence, f.context, semantic);
    t.after(() => planner.onModuleDestroy());
    const service = new IntentCorrectionService(f.persistence, undefined, undefined, planner);
    await service.reconcileStop(correction);
    const current = service.list('session', f.route.id)[0];
    assert.equal(current.processing?.attemptsUsed, 2);
    assert.equal(current.processing?.deadlineAt, f.source.classificationDeadlineAt);
    if (attempts === 1) {
      assert.equal(calls, 1);
      assert.equal(current.status, 'applied');
      assert.equal(f.context.listDecisions('session').find(row => row.id === f.old.id)?.status, 'superseded');
      const snapshot = await f.context.buildIntentSnapshot({ session: f.persistence.getCollection<SessionDetail[]>('sessions', [])[0],
        sourceEventId: 'next-input', currentMessage: '超时是多少', latestEventSeq: 0 });
      assert.deepEqual(snapshot.validDecisions.map(row => row.content), [f.event.content]);
    } else {
      assert.equal(calls, 0, 'schema repair in initial classification consumed the remaining invocation');
      assert.equal(current.status, 'rejected');
      assert.equal(current.failureClass, 'budget');
      assert.equal(f.context.listDecisions('session').find(row => row.id === f.old.id)?.status, 'confirmed');
      assert.equal(f.context.getWorkItem('session', f.work.id).dispatchHold?.correctionId, correction.id);
    }
  }
});


test('consumed chat correction cannot be resurrected by a stale follow-up cache or rebound to another source', async t => {
  const f = await chatFixture(t);
  const { correction } = await f.acceptChat();
  await assert.rejects(f.context.saveFollowUp('session', { ...f.follow, status: 'planning' }), /INTENT_FOLLOW_UP_SUPERSEDED/);
  await assert.rejects(f.persistence.mutateCollections(['intentCorrectionsBySession'], draft => {
    (draft.intentCorrectionsBySession as Record<string, IntentCorrection[]>).session[0].originRoutingId = 'another-session-route';
  }), /INTENT_RECORD_CHAT_BINDING_MISMATCH|INTENT_RECORD_IMMUTABLE/);
  assert.equal(f.service.list('session', f.route.id)[0].id, correction.id);
  assert.equal(f.context.listFollowUps('session').find(row => row.id === f.follow.id)?.status, 'cancelled');
  const source = f.context.listRoutingRecords('session').find(row => row.id === f.source.id)!;
  await assert.rejects(f.service.accept('session', source.id, f.session.ownerId, {
    ...f.input, expectedRoutingRevision: source.routingRevision, idempotencyKey: 'correct-alias'
  }), /CORRECTION_USE_ORIGINAL_ROUTING/);
  assert.equal(f.service.list('session', source.id).length, 0);
  assert.equal(f.context.listRoutingRecords('session').find(row => row.id === source.id)?.correctionTargetRoutingId, f.route.id);
});


test('correction snapshot bounds candidates and preserves an explicit reply to an older route', async t => {
  const f = await chatFixture(t);
  for (let index = 0; index < 10; index++) {
    const route = await f.context.createRoutingRecord({ session: f.session, sourceEventId: `later-${index}`,
      idempotencyKey: `later-${index}`, rolloutMode: 'enforce_all_current_epoch' });
    await f.context.saveFollowUp('session', { ...f.follow, id: `later-follow-${index}`, routingId: route.id,
      sourceEventId: route.sourceEventId, status: 'completed' });
  }
  const snapshot = await f.context.buildIntentSnapshot({ session: f.session, sourceEventId: f.event.id,
    currentMessage: f.event.content, replyToEventId: f.route.sourceEventId, latestEventSeq: 2 });
  assert.equal(snapshot.correctionCandidates?.length, 8);
  assert.equal(snapshot.omittedCorrectionCandidates, 3);
  assert.equal(snapshot.correctionCandidates?.[0].routingId, f.route.id);
  assert.ok(snapshot.correctionCandidates?.[0].decisionIds.includes(f.old.id));
  assert.equal(snapshot.correctionCandidates?.some(row => row.routingId === f.source.id), false);
});
