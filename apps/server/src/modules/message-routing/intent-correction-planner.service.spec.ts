import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CorrectIntentRoutingInput, IntentCorrection, IntentUnderstandingOutput, SessionDetail } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { SemanticIntentRouterService } from '../intent-recognition/semantic-intent-router.service.js';
import { IntentCorrectionService } from './intent-correction.service.js';
import { IntentCorrectionPlannerService } from './intent-correction-planner.service.js';
import { decisionSetHash } from '../context-management/effective-decisions.js';
import { SessionLifecycleStore, type SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { LogicalOperationStore } from '../runtimes/logical-operation-store.js';

type ModelInput = Parameters<SemanticIntentRouterService['understand']>[0];
type Outcome = Awaited<ReturnType<SemanticIntentRouterService['understand']>>;

function understanding(input: ModelInput): IntentUnderstandingOutput {
  const request = input.correction!;
  return { schemaVersion: '1.0', kind: 'intent_understanding', semanticContractVersion: 'intent-understanding-v1',
    segments: [{ localKey: 'constraint-correction', dialogueAct: 'correction', goal: input.snapshot.currentMessage,
      scopeRelation: 'same_requirement', suggestedAction: 'correct_route', contextPolicy: 'inherit_confirmed',
      target: { workItemId: request.targetWorkItemId, decisionIds: [], artifactIds: [], agentIds: [], confirmationId: null, correctionOfRoutingId: request.routingId },
      correction: request.supersedesDecisionId ? { supersedesDecisionId: request.supersedesDecisionId,
        expectedDecisionRevision: request.expectedDecisionRevision!, replacementText: input.snapshot.currentMessage } : null,
      requestedEffects: [], prohibitions: [], dependencies: [], evidence: [{ refId: 'change', sourceEventId: input.snapshot.sourceEventId,
        start: 0, end: input.snapshot.currentMessage.length, quote: input.snapshot.currentMessage }] }],
    missingFields: [], ambiguityReasons: [], modelConfidence: 1 };
}

async function fixture(t: TestContext, model: (input: ModelInput, call: number) => Promise<Outcome> | Outcome = input => ({ status: 'valid', understanding: understanding(input) }), inherited = false) {
  const directory = mkdtempSync(join(tmpdir(), 'intent-correction-plan-'));
  const persistence = new PersistenceService({ backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  t.after(async () => { await persistence.onModuleDestroy(); rmSync(directory, { force: true, recursive: true }); });
  const now = new Date().toISOString();
  const session: SessionDetail = { id: 'session', dataEpoch: 'epoch', ownerId: 'user', workspaceId: 'workspace', title: '登录',
    originalInput: '实现登录', status: 'PAUSED', tokenUsed: 0, participatingAgentIds: [], createdAt: now, updatedAt: now };
  await persistence.setCollection('sessions', [session]);
  const context = new ContextManagementService(persistence);
  const parent = await context.ensureInitialWorkItem(session, 'initial');
  const old = await context.recordDecision({ session, workItemId: parent.id, sourceEventId: 'timeout-old', kind: 'constraint', content: '超时为 10 分钟' });
  const work = inherited ? await context.createWorkItem({ session, sourceEventId: 'child', title: '子任务', goal: '子任务',
    parentWorkItemId: parent.id, inheritedDecisionIds: [old.id] }) : parent;
  const route = await context.createRoutingRecord({ session, sourceEventId: 'original-route', idempotencyKey: 'original-route', rolloutMode: 'enforce_all_current_epoch' });
  await persistence.setCollection('followUpMessagesBySession', { session: [{ id: 'old-follow-up', routingId: route.id, workItemId: work.id, status: 'queued' }] });
  const input: CorrectIntentRoutingInput = { contractVersion: 'intent-correction-v1', expectedRoutingRevision: route.routingRevision ?? 1,
    idempotencyKey: 'correction', instruction: '超时改为 30 分钟', targetWorkItemId: work.id,
    supersedesDecisionId: old.id, expectedDecisionRevision: old.revision };
  const calls: ModelInput[] = [];
  const semantic = { async understand(input: ModelInput) { calls.push(input); return model(input, calls.length); } };
  const planner = new IntentCorrectionPlannerService(persistence, context, semantic as never);
  t.after(() => planner.onModuleDestroy());
  const acceptance = new IntentCorrectionService(persistence);
  const accepted = await acceptance.accept('session', route.id, 'user', input);
  await acceptance.reconcileStop(accepted.correction);
  return { directory, persistence, context, session, parent, work, old, route, input, calls, planner, acceptance, correction: accepted.correction,
    current: () => acceptance.list('session', route.id).at(-1)! };
}

test('constraint correction atomically replaces the Decision, persists version 2 and releases only its hold without resuming', async t => {
  const f = await fixture(t);
  await f.planner.process(f.correction);
  assert.equal(f.current().status, 'applied');
  assert.equal(f.calls.length, 1);
  assert.equal(f.context.listDecisions('session').find(item => item.id === f.old.id)?.status, 'superseded');
  const valid = f.context.validDecisions('session', f.work.id);
  assert.deepEqual(valid.map(item => item.content), ['超时改为 30 分钟']);
  assert.equal(valid[0].supersedesDecisionId, f.old.id);
  const work = f.context.getWorkItem('session', f.work.id);
  assert.equal(work.requirementRevision, 2);
  assert.equal(work.executionEpoch, 2);
  assert.equal(work.dispatchHold, undefined);
  const route = f.context.listRoutingRecords('session')[0];
  assert.equal(route.currentIntentRevision, 2);
  assert.equal(route.effectiveIntentRevision, 2);
  assert.equal(route.status, 'ROUTED');
  const versions = f.acceptance.history('session', f.route.id);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].authorizationState, 'unknown');
  assert.equal(versions[1].validatedPlan?.steps[0].executionBinding.requirementRevision, 2);
  assert.deepEqual(versions[1].validatedPlan?.steps[0].effectScope.effects, []);
  assert.equal(f.persistence.getCollection<SessionDetail[]>('sessions', [])[0].status, 'PAUSED');
  const snapshot = await f.context.buildIntentSnapshot({ session: f.persistence.getCollection<SessionDetail[]>('sessions', [])[0],
    sourceEventId: 'next', currentMessage: '当前超时是什么', latestEventSeq: 0 });
  assert.deepEqual(snapshot.validDecisions.map(item => item.content), ['超时改为 30 分钟']);
  const events = f.persistence.getCollection<Record<string, Array<{ id: string; type: string }>>>('eventsBySession', {}).session;
  const applied = events.filter(event => event.type === 'intent_correction_applied');
  assert.equal(applied.length, 1);
  assert.ok(f.persistence.getCollection<Array<{ id: string }>>('eventOutbox', []).some(item => item.id === `outbox:${applied[0].id}`));
  await f.planner.process(f.correction);
  assert.equal(f.calls.length, 1);
  assert.equal(f.acceptance.history('session', f.route.id).length, 2);
});

test('two planners on the same durable correction produce one classification and one activated version', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async input => { await gate; return { status: 'valid', understanding: understanding(input) }; });
  const other = new IntentCorrectionPlannerService(f.persistence, new ContextManagementService(f.persistence),
    { understand: () => assert.fail('the second lease owner must not classify') } as never);
  t.after(() => other.onModuleDestroy());
  const first = f.planner.process(f.correction);
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await other.process(f.correction);
  release(); await first;
  assert.equal(f.calls.length, 1);
  assert.equal(f.current().status, 'applied');
  assert.equal(f.acceptance.history('session', f.route.id).length, 2);
});

test('one bounded schema repair uses the same logical operation, exact original input and persisted attempts', async t => {
  const f = await fixture(t, (input, call) => call === 1 ? { status: 'invalid', previousOutput: '{broken', validationErrors: ['/segments must be an array'] } :
    { status: 'valid', understanding: understanding(input) });
  await f.planner.process(f.correction);
  assert.equal(f.current().status, 'applied');
  assert.equal(f.current().processing?.attemptsUsed, 2);
  assert.equal(f.current().processing?.repairsUsed, 1);
  assert.equal(f.calls[0].operationId, f.calls[1].operationId);
  assert.equal(f.calls[1].snapshot.currentMessage, '超时改为 30 分钟');
  assert.deepEqual(f.calls[1].repairFeedback, { previousOutput: '{broken', validationErrors: ['/segments must be an array'] });
  assert.equal(f.calls[1].operationDeadlineAt, f.current().processing?.deadlineAt);
});

test('correction repair feedback survives worker interruption without restoring the used attempt', async t => {
  const f = await fixture(t, () => ({ status: 'invalid', previousOutput: '{broken', validationErrors: ['segments missing'] }));
  const mutate = f.persistence.mutateCollections.bind(f.persistence);
  (f.persistence as any).mutateCollections = async (...args: Parameters<typeof mutate>) => {
    const result = await mutate(...args);
    if (f.current().processing?.repairFeedback) f.planner.onModuleDestroy();
    return result;
  };
  await f.planner.process(f.correction);
  (f.persistence as any).mutateCollections = mutate;
  assert.equal(f.current().status, 'validating');
  assert.equal(f.current().processing?.attemptsUsed, 1);
  const deadline = f.current().processing?.deadlineAt;
  await f.persistence.mutateCollections(['intentCorrectionsBySession'], draft => {
    const correction = (draft.intentCorrectionsBySession as Record<string, IntentCorrection[]>).session.find(row => row.id === f.correction.id)!;
    correction.processing!.leaseExpiresAt = new Date(0).toISOString();
  });
  let calls = 0;
  const resumed = new IntentCorrectionPlannerService(f.persistence, f.context, { understand: async (input: Parameters<SemanticIntentRouterService['understand']>[0]) => {
    calls++; assert.deepEqual(input.repairFeedback, { previousOutput: '{broken', validationErrors: ['segments missing'] });
    return { status: 'valid', understanding: understanding(input) };
  } } as SemanticIntentRouterService);
  t.after(() => resumed.onModuleDestroy());
  await resumed.process(f.correction);
  assert.equal(calls, 1);
  assert.equal(f.current().status, 'applied');
  assert.equal(f.current().processing?.attemptsUsed, 2);
  assert.equal(f.current().processing?.repairsUsed, 1);
  assert.equal(f.current().processing?.deadlineAt, deadline);
});

test('401 is rejected once with the hold retained; an explicit new correction receives a new revision and operation', async t => {
  const f = await fixture(t, () => ({ status: 'failed', code: 'INTENT_AUTH_FAILED', failureClass: 'auth', retryable: false, retryAfterMs: 0 }));
  await f.planner.process(f.correction);
  assert.equal(f.current().status, 'rejected');
  assert.equal(f.current().failureClass, 'auth');
  assert.equal(f.calls.length, 1);
  assert.ok(f.context.getWorkItem('session', f.work.id).dispatchHold);
  const old = f.current();
  const retry = await f.acceptance.accept('session', f.route.id, 'user', { ...f.input, idempotencyKey: 'explicit-retry',
    expectedRoutingRevision: f.context.listRoutingRecords('session')[0].routingRevision });
  assert.equal(retry.correction.pendingIntentRevision, 3);
  assert.equal(f.acceptance.list('session', f.route.id)[0].supersededByCorrectionId, retry.correction.id);
  assert.equal(f.context.getWorkItem('session', f.work.id).dispatchHold?.correctionId, retry.correction.id);
  await f.planner.process(old);
  assert.equal(f.calls.length, 1);
});

test('model changes without bound Decision authorization or exact replacement evidence never supersede old constraints', async t => {
  for (const mode of ['target', 'replacement', 'source', 'effect'] as const) {
    const f = await fixture(t, input => {
      const output = understanding(input), segment = output.segments[0];
      if (mode === 'target') output.segments[0] = { ...segment, correction: { ...segment.correction!, supersedesDecisionId: 'invented-decision' } };
      if (mode === 'replacement') output.segments[0] = { ...segment, correction: { ...segment.correction!, replacementText: '超时为 300 分钟' } };
      if (mode === 'source') segment.evidence[0] = { ...segment.evidence[0], sourceEventId: 'historical-message' };
      if (mode === 'effect') segment.requestedEffects.push({ kind: 'modify_source', target: { kind: 'workspace', refId: 'workspace' }, evidenceRefs: ['change'] });
      return { status: 'valid', understanding: output };
    });
    await f.planner.process(f.correction);
    assert.notEqual(f.current().status, 'applied');
    assert.deepEqual(f.context.validDecisions('session', f.work.id).map(item => item.content), ['超时为 10 分钟']);
    assert.equal(f.acceptance.history('session', f.route.id).length, 1);
    assert.ok(f.context.getWorkItem('session', f.work.id).dispatchHold);
  }
});

test('activation disk failure rolls back ledger, requirements, versions, completed steps and hold release', async t => {
  let persistence!: PersistenceService;
  const f = await fixture(t, input => {
    const write = (persistence as any).writeFileState.bind(persistence);
    let failed = false;
    (persistence as any).writeFileState = (state: Record<string, unknown>) => {
      const rows = (state?.intentCorrectionsBySession as Record<string, IntentCorrection[]> | undefined)?.session;
      if (!failed && rows?.some(item => item.status === 'applied')) { failed = true; throw new Error('injected activation commit failure'); }
      return write(state);
    };
    return { status: 'valid', understanding: understanding(input) };
  });
  persistence = f.persistence;
  await f.planner.process(f.correction);
  assert.equal(f.current().status, 'rejected');
  assert.equal(f.context.listDecisions('session').length, 1);
  assert.equal(f.context.listDecisions('session')[0].status, 'confirmed');
  assert.equal(f.context.getWorkItem('session', f.work.id).requirementRevision, 1);
  assert.ok(f.context.getWorkItem('session', f.work.id).dispatchHold);
  assert.equal(f.acceptance.history('session', f.route.id).length, 1);
  assert.deepEqual(f.persistence.getCollection('intentPlanStepsBySession', {}), { session: [] });
});

test('expired recovered classification does not reset its durable budget or invoke a model', async t => {
  const f = await fixture(t);
  await f.persistence.mutateCollections(['intentCorrectionsBySession'], draft => {
    const item = (draft.intentCorrectionsBySession as Record<string, IntentCorrection[]>).session[0];
    item.processing = { ownerId: 'dead-worker', leaseExpiresAt: new Date(0).toISOString(), deadlineAt: new Date(0).toISOString(),
      attemptsUsed: 1, repairsUsed: 0, snapshotRebuildsUsed: 0, invocationIds: ['old-invocation'] };
  });
  await f.planner.process(f.correction);
  assert.equal(f.calls.length, 0);
  assert.equal(f.current().processing?.attemptsUsed, 1);
  assert.equal(f.current().status, 'rejected');
  assert.deepEqual(f.current().reasonCodes, ['INTENT_BUDGET_EXHAUSTED']);
});

test('deletion while classification is outstanding prevents version activation and data resurrection', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async input => { await gate; return { status: 'valid', understanding: understanding(input) }; });
  const running = f.planner.process(f.correction);
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.persistence.deleteSessionData('session');
  release(); await running;
  assert.equal(f.acceptance.list('session', f.route.id).length, 0);
  assert.equal(f.acceptance.history('session', f.route.id).length, 0);
});

test('activating an inherited constraint correction changes only the child context and its execution hash', async t => {
  const f = await fixture(t, undefined, true);
  const sibling = await f.context.createWorkItem({ session: f.session, sourceEventId: 'sibling', title: '同级任务', goal: '同级任务',
    parentWorkItemId: f.parent.id, inheritedDecisionIds: [f.old.id] });
  await f.planner.process(f.correction);
  assert.equal(f.current().status, 'applied');
  assert.deepEqual(f.context.validDecisions('session', f.parent.id).map(item => item.id), [f.old.id]);
  assert.deepEqual(f.context.validDecisions('session', sibling.id).map(item => item.id), [f.old.id]);
  const childDecisions = f.context.validDecisions('session', f.work.id);
  assert.deepEqual(childDecisions.map(item => item.content), ['超时改为 30 分钟']);
  assert.equal(childDecisions[0].overridesDecisionId, f.old.id);
  const currentSession = f.persistence.getCollection<SessionDetail[]>('sessions', [])[0];
  const snapshot = await f.context.buildIntentSnapshot({ session: { ...currentSession, activeWorkItemId: f.work.id },
    sourceEventId: 'next', currentMessage: '当前超时是什么', latestEventSeq: 0 });
  assert.deepEqual(snapshot.validDecisions.map(item => item.content), ['超时改为 30 分钟']);
  assert.equal(f.acceptance.history('session', f.route.id)[1].validatedPlan?.steps[0].executionBinding.decisionSetHash, decisionSetHash(childDecisions));
});

test('a concurrent Decision replacement is re-read once and never overwrites the newer constraint', async t => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, async (input, call) => {
    if (call === 1) await f.context.recordDecision({ session: f.session, workItemId: f.work.id, sourceEventId: 'concurrent-change',
      kind: 'correction', content: '超时改为 60 分钟', supersedesDecisionId: f.old.id, expectedDecisionRevision: 1 });
    return { status: 'valid', understanding: understanding(input) };
  });
  await f.planner.process(f.correction);
  assert.equal(f.calls.length, 2);
  assert.equal(f.current().processing?.snapshotRebuildsUsed, 1);
  assert.equal(f.current().status, 'clarification_required');
  assert.ok(f.current().reasonCodes.includes('CORRECTION_DECISION_STALE'));
  assert.deepEqual(f.context.validDecisions('session', f.work.id).map(item => item.content), ['超时改为 60 分钟']);
  assert.ok(f.context.getWorkItem('session', f.work.id).dispatchHold);
  assert.equal(f.acceptance.history('session', f.route.id).length, 1);
});

test('repeated business snapshot changes share two calls and one rebuild, keeping the hold on exhaustion', async t => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, async (input, call) => {
    await f.context.recordDecision({ session: f.session, workItemId: f.work.id, sourceEventId: `other-${call}`,
      kind: 'constraint', content: `补充约束 ${call}` });
    return { status: 'valid', understanding: understanding(input) };
  });
  await f.planner.process(f.correction);
  assert.equal(f.calls.length, 2);
  assert.equal(f.current().processing?.snapshotRebuildsUsed, 1);
  assert.equal(f.current().status, 'rejected');
  assert.equal(f.current().failureClass, 'budget');
  assert.equal(f.calls[0].operationId, f.calls[1].operationId);
  assert.ok(f.context.getWorkItem('session', f.work.id).dispatchHold);
});

test('a result from an expired lease cannot activate after a replacement worker takes over', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async (input, call) => {
    if (call === 1) await gate;
    return { status: 'valid', understanding: understanding(input) };
  });
  const running = f.planner.process(f.correction);
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.persistence.mutateCollections(['intentCorrectionsBySession'], draft => {
    (draft.intentCorrectionsBySession as Record<string, IntentCorrection[]>).session[0].processing!.leaseExpiresAt = new Date(0).toISOString();
  });
  const other = new IntentCorrectionPlannerService(f.persistence, f.context, { understand: async (input: ModelInput) => {
    f.calls.push(input); return { status: 'valid', understanding: understanding(input) };
  } } as never);
  t.after(() => other.onModuleDestroy());
  await other.process(f.current());
  assert.equal(f.current().status, 'applied');
  release(); await running;
  assert.equal(f.calls.length, 2);
  assert.equal(f.context.listDecisions('session').length, 2);
  assert.equal(f.acceptance.history('session', f.route.id).length, 2);
});

test('a Session generation change discards a late semantic response', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async input => { await gate; return { status: 'valid', understanding: understanding(input) }; });
  await new SessionLifecycleStore(f.persistence).initialize('session', 'epoch');
  const running = f.planner.process(f.correction);
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.persistence.mutateCollections(['sessionLifecyclesBySession'], draft => {
    (draft.sessionLifecyclesBySession as SessionLifecyclesBySession).session.generation += 1;
  });
  release(); await running;
  assert.notEqual(f.current().status, 'applied');
  assert.equal(f.context.listDecisions('session').length, 1);
  assert.ok(f.context.getWorkItem('session', f.work.id).dispatchHold);
});

test('repeated malformed output persists one repair and does not reset on replay', async t => {
  const f = await fixture(t, () => ({ status: 'invalid', previousOutput: '{}', validationErrors: ['segments missing'] }));
  await f.planner.process(f.correction);
  await f.planner.process(f.current());
  assert.equal(f.calls.length, 2);
  assert.equal(f.current().processing?.repairsUsed, 1);
  assert.equal(f.current().failureClass, 'schema');
  assert.equal(f.current().status, 'rejected');
  assert.ok(f.context.getWorkItem('session', f.work.id).dispatchHold);
});

test('execution admission rechecks the live effective Decision hash after version activation', async t => {
  const f = await fixture(t);
  await f.planner.process(f.correction);
  const binding = f.acceptance.history('session', f.route.id)[1].validatedPlan!.steps[0].executionBinding;
  const store = new LogicalOperationStore(f.persistence);
  const identity = { sessionId: 'session', dataEpoch: 'epoch', workItemId: f.work.id, executionBinding: binding };
  await store.assertCurrentIntent(identity);
  await f.context.recordDecision({ session: f.persistence.getCollection<SessionDetail[]>('sessions', [])[0],
    workItemId: f.work.id, sourceEventId: 'new-constraint', kind: 'constraint', content: '额外限制' });
  await assert.rejects(store.assertCurrentIntent(identity), /INTENT_EXECUTION_DECISIONS_STALE/);
});
