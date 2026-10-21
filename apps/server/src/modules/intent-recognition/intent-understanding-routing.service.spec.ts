import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { intentUnderstandingExample, type CollaborationEvent, type IntentRoutingRecord, type SessionDetail } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ContextManagementService } from '../context-management/context-management.service.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import { SemanticIntentRouterService } from './semantic-intent-router.service.js';
import { IntentUnderstandingRoutingService } from './intent-understanding-routing.service.js';

type Understand = SemanticIntentRouterService['understand'];
const valid = () => ({ status: 'valid' as const, understanding: structuredClone(intentUnderstandingExample) });
const invalid = () => ({ status: 'invalid' as const, previousOutput: '{bad json}', validationErrors: ['segments: required'] });

async function fixture(t: TestContext, understand: Understand = async () => valid()) {
  const directory = mkdtempSync(join(tmpdir(), 'semantic-proposal-'));
  const filePath = join(directory, 'state.json');
  const persistence = new PersistenceService({ backend: 'file', filePath });
  await persistence.initialize();
  t.after(async () => { await persistence.onModuleDestroy(); rmSync(directory, { force: true, recursive: true }); });
  const session: SessionDetail = { id: 'session', dataEpoch: 'epoch', revision: 1, decisionLedgerRevision: 0,
    title: '问答', originalInput: intentUnderstandingExample.segments[0].goal, status: 'PAUSED',
    ownerId: 'user', workspaceId: 'workspace', participatingAgentIds: [], tokenUsed: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await persistence.setCollection('sessions', [session]);
  const event: CollaborationEvent = { id: 'message-1', sessionId: session.id, type: 'user_message', content: session.originalInput,
    toAgentIds: [], createdAt: session.createdAt, actor: { type: 'user', id: session.ownerId },
    metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload: { text: session.originalInput } } };
  await persistence.setCollection('eventsBySession', { session: [event] });
  await new SessionLifecycleStore(persistence).initialize(session.id, session.dataEpoch!);
  const context = new ContextManagementService(persistence);
  const snapshot = await context.buildIntentSnapshot({ session, sourceEventId: event.id, currentMessage: event.content, latestEventSeq: 1 });
  const route = await context.createRoutingRecord({ session, sourceEventId: event.id, idempotencyKey: 'initial', rolloutMode: 'enforce_all_current_epoch' });
  const inputs: Parameters<Understand>[0][] = [];
  const semantic = { understand: async (input: Parameters<Understand>[0]) => { inputs.push(input); return understand(input); } } as SemanticIntentRouterService;
  const service = new IntentUnderstandingRoutingService(persistence, context, semantic);
  const input = { sessionId: session.id, routingId: route.id, snapshotId: snapshot.id };
  const current = () => context.listRoutingRecords(session.id).find(row => row.id === route.id)!;
  const mutateRoute = (mutate: (row: IntentRoutingRecord) => void) => persistence.mutateCollections(['intentRoutingRecordsBySession'], draft => {
    mutate((draft.intentRoutingRecordsBySession as Record<string, IntentRoutingRecord[]>).session.find(row => row.id === route.id)!);
  });
  return { persistence, filePath, context, session, snapshot, route, semantic, service, input, inputs, current, mutateRoute };
}

test('new semantic proposal retains complete contract without creating WorkItem, executing or entering legacy routes', async t => {
  const f = await fixture(t);
  const result = await f.service.classify(f.input);
  assert.equal(result.status, 'VALIDATING');
  assert.deepEqual(result.semanticProposal?.understanding, intentUnderstandingExample);
  assert.equal(result.classificationAttempts, 1);
  assert.equal(result.decision, undefined);
  assert.equal(result.finalAction, undefined);
  assert.equal(f.inputs[0].operationId, f.route.id);
  assert.equal(f.inputs[0].operationDeadlineAt, result.classificationDeadlineAt);
  assert.equal(f.inputs[0].snapshot.currentMessage, f.session.originalInput);
  assert.equal(f.context.listWorkItems('session').length, 0);
  assert.equal(f.persistence.getCollection<SessionDetail[]>('sessions', [])[0].status, 'PAUSED');
  assert.deepEqual(await f.service.classify(f.input), result, 'proposal replay never calls the model again');
  assert.equal(f.inputs.length, 1);
  await assert.rejects(f.context.claimIntentRouting('session', f.route.id, f.snapshot.id, 'legacy'), /INTENT_CONTRACT_WORKER_UNSUPPORTED/);
  await assert.rejects(f.context.reserveIntentClassificationAttempt('session', f.route.id, 'legacy', 'classification'), /INTENT_CONTRACT_WORKER_UNSUPPORTED/);
  await assert.rejects(f.context.updateRoutingRecord('session', f.route.id, { decision: {} as never }), /INTENT_PLAN_COMPILER_REQUIRED/);
  await assert.rejects(f.context.applyIntentRoute({ session: f.session, routingId: f.route.id, snapshotId: f.snapshot.id,
    followUpId: 'not-created', decision: {} as never, validation: {} as never }), /INTENT_PLAN_COMPILER_REQUIRED/);
});

test('schema repair preserves input and concrete persisted feedback within the original two attempts', async t => {
  let calls = 0;
  const f = await fixture(t, async input => {
    if (++calls === 1) return invalid();
    assert.deepEqual(input.repairFeedback, { previousOutput: '{bad json}', validationErrors: ['segments: required'] });
    assert.equal(input.snapshot.currentMessage, f.session.originalInput);
    return valid();
  });
  const result = await f.service.classify(f.input);
  assert.equal(result.status, 'VALIDATING');
  assert.equal(result.classificationAttempts, 2);
  assert.deepEqual(result.attemptLog?.map(row => row.reason), ['classification', 'schema_repair']);
  assert.equal(new Set(f.inputs.map(row => row.operationId)).size, 1);
  assert.equal(result.semanticProposal?.repairFeedback, undefined);
});

test('repair feedback and remaining attempt survive interruption and File persistence restart', async t => {
  const controller = new AbortController();
  const f = await fixture(t, async () => invalid());
  const mutate = f.persistence.mutateCollections.bind(f.persistence);
  (f.persistence as any).mutateCollections = async (...args: Parameters<typeof mutate>) => {
    const result = await mutate(...args);
    if (f.current().semanticProposal?.repairFeedback) controller.abort(new Error('simulated crash'));
    return result;
  };
  await assert.rejects(f.service.classify(f.input, controller.signal), /simulated crash/);
  (f.persistence as any).mutateCollections = mutate;
  const deadline = f.current().classificationDeadlineAt;
  assert.equal(f.current().classificationAttempts, 1);
  await f.mutateRoute(row => { row.leaseExpiresAt = new Date(0).toISOString(); });
  const restored = new PersistenceService({ backend: 'file', filePath: f.filePath });
  await restored.initialize(); t.after(() => restored.onModuleDestroy());
  let calls = 0;
  const resumed = new IntentUnderstandingRoutingService(restored, new ContextManagementService(restored), {
    understand: async (input: Parameters<Understand>[0]) => {
      calls++; assert.equal(input.repairFeedback?.previousOutput, '{bad json}');
      assert.deepEqual(input.repairFeedback?.validationErrors, ['segments: required']); return valid();
    }
  } as unknown as SemanticIntentRouterService);
  const result = await resumed.classify(f.input);
  assert.equal(calls, 1);
  assert.equal(result.classificationAttempts, 2);
  assert.equal(result.classificationDeadlineAt, deadline);
  assert.equal(result.status, 'VALIDATING');
});

test('repeated malformed output terminates with blocked schema failure, never semantic clarification', async t => {
  const f = await fixture(t, async () => invalid());
  const result = await f.service.classify(f.input);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.failureClass, 'schema');
  assert.equal(result.classificationAttempts, 2);
  assert.equal(result.semanticProposal?.understanding, undefined);
  await f.service.classify(f.input);
  assert.equal(f.inputs.length, 2);
});

test('auth/config/unknown-effect failures never retry even if the transport says retryable', async t => {
  for (const failureClass of ['auth', 'config', 'unknown_effect'] as const) {
    const f = await fixture(t, async () => ({ status: 'failed', code: 'FIXTURE_FAILURE', failureClass, retryable: true, retryAfterMs: 0 }));
    const result = await f.service.classify(f.input);
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.failureClass, failureClass);
    assert.equal(f.inputs.length, 1);
  }
});

test('Retry-After is durable, prevents immediate repeat and consumes the same remaining budget', async t => {
  let calls = 0;
  const f = await fixture(t, async () => ++calls === 1
    ? { status: 'failed', code: 'INTENT_RATE_LIMITED', failureClass: 'transient', retryable: true, retryAfterMs: 1000 } : valid());
  const first = await f.service.classify(f.input);
  assert.equal(first.status, 'PENDING_RETRY');
  assert.ok(Date.parse(first.semanticProposal!.retryAt!) > Date.now());
  await f.service.classify(f.input);
  assert.equal(calls, 1);
  await f.mutateRoute(row => { row.semanticProposal!.retryAt = new Date(0).toISOString(); });
  const second = await f.service.classify(f.input);
  assert.equal(second.classificationAttempts, 2);
  assert.equal(second.classificationDeadlineAt, first.classificationDeadlineAt);
  assert.equal(second.status, 'VALIDATING');
});

test('two service instances cannot classify the same route concurrently', async t => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, async () => { started(); await gate; return valid(); });
  const first = f.service.classify(f.input); await began;
  const second = new IntentUnderstandingRoutingService(f.persistence, new ContextManagementService(f.persistence), f.semantic);
  const busy = await second.classify(f.input);
  assert.equal(busy.status, 'CLASSIFYING'); assert.equal(f.inputs.length, 1);
  release(); await first;
  assert.equal(f.current().classificationAttempts, 1);
});

test('business change discards proposal, one rebuild shares attempts, and stale budget cannot reset', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    if (++calls === 1) await f.persistence.mutateCollections(['sessions'], draft => { (draft.sessions as SessionDetail[])[0].revision!++; });
    return valid();
  });
  const first = await f.service.classify(f.input);
  assert.equal(first.status, 'PENDING_RETRY');
  assert.deepEqual(first.reasonCodes, ['SNAPSHOT_STALE']);
  assert.equal(first.semanticProposal?.understanding, undefined);
  assert.equal(await f.context.reserveRoutingRebuild('session', f.route.id), true);
  const session = f.persistence.getCollection<SessionDetail[]>('sessions', [])[0];
  const rebuilt = await f.context.buildIntentSnapshot({ session, sourceEventId: 'message-1', currentMessage: session.originalInput, latestEventSeq: 2 });
  await f.context.updateRoutingRecord('session', f.route.id, { status: 'SNAPSHOT_READY', snapshotId: rebuilt.id });
  const result = await f.service.classify({ ...f.input, snapshotId: rebuilt.id });
  assert.equal(result.status, 'VALIDATING'); assert.equal(result.classificationAttempts, 2);
  assert.equal(result.classificationDeadlineAt, first.classificationDeadlineAt);
  assert.equal(await f.context.reserveRoutingRebuild('session', f.route.id), false);
});

test('delete, generation change and lost lease prevent late model result publication', async t => {
  for (const change of ['delete', 'generation', 'lease'] as const) {
    const f = await fixture(t, async () => {
      if (change === 'delete') await f.persistence.setCollection('sessions', []);
      else if (change === 'generation') await f.persistence.mutateCollections(['sessionLifecyclesBySession'], draft => {
        (draft.sessionLifecyclesBySession as Record<string, { generation: number }>).session.generation++;
      });
      else await f.mutateRoute(row => { row.leaseOwner = 'new-worker'; });
      return valid();
    });
    await assert.rejects(f.service.classify(f.input), /INTENT_SESSION_UNAVAILABLE|INTENT_GENERATION_STALE|ROUTING_LEASE_LOST/);
    assert.equal(f.current().semanticProposal?.understanding, undefined);
    assert.equal(f.context.listWorkItems('session').length, 0);
  }
});

test('cross-source snapshot and legacy in-flight contract migration are rejected without model calls', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.classify({ ...f.input, snapshotId: 'foreign' }), /INTENT_SOURCE_BINDING_MISMATCH/);
  await f.mutateRoute(row => { row.classificationAttempts = 1; row.status = 'CLASSIFYING'; });
  await assert.rejects(f.service.classify(f.input), /INTENT_CONTRACT_MIGRATION_REQUIRED/);
  assert.equal(f.inputs.length, 0);
});

test('output transaction failure retains consumed budget and cannot partially publish the proposal', async t => {
  const f = await fixture(t, async () => {
    (f.persistence as any).writeFileState = () => { throw new Error('proposal disk failure'); };
    return valid();
  });
  const write = (f.persistence as any).writeFileState.bind(f.persistence);
  try { await assert.rejects(f.service.classify(f.input), /proposal disk failure/); }
  finally { (f.persistence as any).writeFileState = write; }
  assert.equal(f.current().classificationAttempts, 1);
  assert.equal(f.current().status, 'CLASSIFYING');
  assert.equal(f.current().semanticProposal?.understanding, undefined);
});
