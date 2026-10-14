import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PersistenceService } from '../persistence/persistence.service.js';
import { RuntimeHealthStore, RUNTIME_HEALTH_COLLECTION } from './runtime-health-store.js';
import { makeInvocationPlan } from './invocation-plan.fixture.js';

function memoryPersistence() {
  let state: Record<string, unknown> = {};
  return {
    getCollection<T>(key: string, fallback: T): T { return (state[key] as T) ?? fallback; },
    async mutateCollections(_keys: string[], mutate: (draft: Record<string, unknown>) => unknown) {
      const draft = structuredClone(state); const result = mutate(draft); state = draft; return result;
    }
  } as unknown as PersistenceService;
}

test('wait is versioned, session-scoped, idempotent, and does not renew the call or its deadline', async () => {
  const persistence = memoryPersistence();
  let now = 0;
  const store = new RuntimeHealthStore(persistence, undefined, () => now);
  const plan = makeInvocationPlan();
  const initial = store.begin(plan, 3, 50);
  await store.flush();
  now = 51; store.tick(plan.invocationId, 50); await store.flush();
  const snapshot = store.snapshot(plan.invocationId)!;
  const body = { sessionGeneration: 3, expectedVersion: snapshot.version, idempotencyKey: 'wait-1' };
  await assert.rejects(store.wait('foreign', plan.invocationId, body));
  await assert.rejects(store.wait(plan.sessionId, plan.invocationId, { ...body, sessionGeneration: 2 }));
  const accepted = await store.wait(plan.sessionId, plan.invocationId, body);
  const duplicate = await store.wait(plan.sessionId, plan.invocationId, body);
  assert.deepEqual(accepted, duplicate);
  assert.equal(accepted.invocationId, initial.invocationId);
  assert.equal(accepted.deadlineAt, initial.deadlineAt);
  assert.equal(accepted.stage, 'unknown_wait');
  assert.equal(accepted.lastProgressAt, undefined);
  store.signal(plan.invocationId, 'text_progress', 50, { count: 2, eventId: 'new-token' });
  await assert.rejects(store.wait(plan.sessionId, plan.invocationId, body));
  store.signal(plan.invocationId, 'terminal_received', 50); await store.flush();
  assert.equal(store.list(plan.sessionId)[0].stage, 'terminal');
  const events = persistence.getCollection<Record<string, unknown[]>>('eventsBySession', {})[plan.sessionId];
  assert.equal(new Set(events.map((event: any) => event.id)).size, events.length);
  store.dispose();
});

test('restart projects non-terminal history as unknown with no mutation authority', async () => {
  const persistence = memoryPersistence();
  const first = new RuntimeHealthStore(persistence);
  const plan = makeInvocationPlan();
  first.begin(plan, 1, 50); await first.flush();
  const restarted = new RuntimeHealthStore(persistence);
  const item = restarted.list(plan.sessionId)[0];
  assert.equal(item.historical, true);
  assert.equal(item.canWait, false);
  assert.equal(item.canStop, false);
  await assert.rejects(restarted.wait(plan.sessionId, plan.invocationId,
    { sessionGeneration: 1, expectedVersion: item.version, idempotencyKey: 'restart' }));
  first.dispose(); restarted.dispose();
});

test('deleted or replaced sessions reject wait and late observations cannot recreate deleted health data', async () => {
  const persistence = memoryPersistence();
  let now = 0;
  const store = new RuntimeHealthStore(persistence, undefined, () => now);
  const plan = makeInvocationPlan();
  store.begin(plan, 1, 50); await store.flush();
  now = 51; store.tick(plan.invocationId, 50); await store.flush();
  const input = { sessionGeneration: 1, expectedVersion: store.snapshot(plan.invocationId)!.version, idempotencyKey: 'late-wait' };
  await persistence.mutateCollections(['sessionLifecyclesBySession', RUNTIME_HEALTH_COLLECTION], draft => {
    draft.sessionLifecyclesBySession = { [plan.sessionId]: { generation: 2, state: 'deleting', admission: 'closed' } };
    draft[RUNTIME_HEALTH_COLLECTION] = {};
  });
  await assert.rejects(store.wait(plan.sessionId, plan.invocationId, input));
  store.signal(plan.invocationId, 'terminal_received', 50); await store.flush();
  assert.equal(persistence.getCollection<Record<string, unknown>>(RUNTIME_HEALTH_COLLECTION, {})[plan.sessionId], undefined);
  store.dispose();
});

test('snapshot/outbox failure preserves live observation and retries only a bounded auxiliary write', async () => {
  const persistence = memoryPersistence();
  const original = persistence.mutateCollections.bind(persistence);
  let writes = 0;
  persistence.mutateCollections = (async () => { writes++; throw new Error('disk unavailable'); }) as typeof persistence.mutateCollections;
  let now = 0;
  const store = new RuntimeHealthStore(persistence, undefined, () => now);
  const plan = makeInvocationPlan();
  store.begin(plan, 1, 50);
  await Promise.all(Array.from({ length: 20 }, () => store.flush()));
  assert.equal(writes, 1);
  assert.equal(store.snapshot(plan.invocationId)?.pendingSync, true);
  now = 51; store.tick(plan.invocationId, 50);
  await store.flush(); assert.equal(writes, 1, 'backoff prevents a write storm');
  persistence.mutateCollections = original;
  await store.flush(true);
  assert.equal(store.snapshot(plan.invocationId)?.pendingSync, false);
  assert.equal(persistence.getCollection<Record<string, any[]>>(RUNTIME_HEALTH_COLLECTION, {})[plan.sessionId][0].stage, 'unknown_wait');
  store.dispose();
});

test('file persistence reload retains terminal health and a single committed transition/outbox identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-health-file-'));
  try {
    const filePath = join(directory, 'state.json');
    const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath });
    await persistence.initialize();
    const store = new RuntimeHealthStore(persistence);
    const plan = makeInvocationPlan();
    store.begin(plan, 1, 50); await store.flush();
    store.signal(plan.invocationId, 'terminal_received', 50); await store.flush();
    const loaded = new PersistenceService({ enabled: true, backend: 'file', filePath });
    await loaded.initialize();
    const restored = new RuntimeHealthStore(loaded);
    assert.equal(restored.list(plan.sessionId)[0].stage, 'terminal');
    const events = loaded.getCollection<Record<string, any[]>>('eventsBySession', {})[plan.sessionId];
    assert.equal(events.length, 2);
    const outbox = loaded.getCollection<any[]>('eventOutbox', []);
    assert.equal(outbox.length, 2);
    assert.equal(new Set(outbox.map(item => item.id)).size, 2);
    store.dispose(); restored.dispose();
  } finally {
    // Only the unique test directory created above, never a workspace or user directory.
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('live and durable health share faults, safe retry facts and fallback cause without replayed recovery', async () => {
  const persistence = memoryPersistence();
  let now = 0;
  const store = new RuntimeHealthStore(persistence, undefined, () => now);
  const plan = makeInvocationPlan();
  store.begin(plan, 1, 50); await store.flush();
  const fault = { invocationId: plan.invocationId, type: 'runtime_progress' as const, visibility: 'debug' as const,
    content: 'api_retry', createdAt: '2026-09-29T00:00:01Z', metadata: { code: 'STREAM_SYSTEM', subtype: 'api_retry',
      eventId: 'retry:1', raw: { status_code: 429, attempt: 7, error: { prompt: 'secret', message: 'Bearer secret' } } } };
  now = 60; store.observe(plan.invocationId, fault, 50); await store.flush();
  const snapshot = store.snapshot(plan.invocationId)!;
  assert.equal(snapshot.health, 'abnormal');
  assert.equal(snapshot.failure?.retryAttempt, 7);
  now = 100; store.tick(plan.invocationId, 50);
  store.signal(plan.invocationId, 'probe_result', 50, { probeStatus: 'unsupported' });
  store.observe(plan.invocationId, { ...fault, invocationId: 'other-call', metadata: { code: 'STREAM_TEXT' } }, 50);
  store.observe(plan.invocationId, { ...fault, metadata: { code: 'STREAM_TEXT', progressReplay: true } }, 50);
  store.observe(plan.invocationId, fault, 50);
  assert.equal(store.snapshot(plan.invocationId)?.health, 'abnormal');
  store.budgetFallback(plan.invocationId, 'provider_or_tool_error');
  store.signal(plan.invocationId, 'stop_requested', 50); await store.flush();
  const persisted = persistence.getCollection<Record<string, any[]>>(RUNTIME_HEALTH_COLLECTION, {})[plan.sessionId][0];
  assert.equal(persisted.budgetFallbackReason, 'provider_or_tool_error');
  assert.equal(persisted.failure.httpStatus, 429);
  assert.equal(JSON.stringify(persisted).includes('secret'), false);
  store.dispose();
});

test('one flush covering several Sessions commits each Session\'s events within its scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-health-scope-'));
  try {
    const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
    await persistence.initialize();
    const store = new RuntimeHealthStore(persistence);
    const first = makeInvocationPlan();
    const second = makeInvocationPlan({
      invocationId: '00000000-0000-4000-8000-000000000911', sessionId: '00000000-0000-4000-8000-000000000912'
    });
    // Both snapshots land in the same coalesced batch, so the scope must name both Sessions.
    store.begin(first, 1, 50);
    store.begin(second, 1, 50);
    await store.flush();
    const events = persistence.getCollection<Record<string, any[]>>('eventsBySession', {});
    assert.equal(events[first.sessionId]?.length, 1);
    assert.equal(events[second.sessionId]?.length, 1);
    assert.equal(store.snapshot(first.invocationId)?.pendingSync, false);
    assert.equal(store.snapshot(second.invocationId)?.pendingSync, false);
    store.dispose();
  } finally {
    // Only the unique test directory created above, never a workspace or user directory.
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\'));
    rmSync(directory, { recursive: true, force: true });
  }
});
