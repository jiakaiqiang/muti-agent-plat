import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PersistenceService } from '../persistence/persistence.service.js';
import { RuntimeSwitchStore } from './runtime-switch-store.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-switch-store-'));
  const persistence = new PersistenceService({
    enabled: true,
    backend: 'file',
    filePath: join(directory, 'state.json')
  });
  await persistence.initialize();
  await persistence.setCollection('sessionLifecyclesBySession', {
    'session-1': {
      contractVersion: 'main-agent-collaboration/v1',
      sessionId: 'session-1',
      dataEpoch: 'epoch',
      generation: 2,
      revision: 1,
      state: 'active',
      admission: 'open',
      stopStatus: 'idle'
    }
  });
  return {
    persistence,
    store: new RuntimeSwitchStore(persistence, () => '2026-09-26T00:00:00.000Z'),
    /** A second instance over the same file, standing in for another process. */
    reopen: () => new RuntimeSwitchStore(persistence, () => '2026-09-26T00:00:00.000Z'),
    async cleanup() {
      await persistence.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    source: 'chat_command' as const,
    fromRuntimeType: 'codex' as const,
    targetRuntimeType: 'claude_code' as const,
    resumeAfterSwitch: true,
    fallbackMode: 'exclude_previous_once' as const,
    idempotencyKey: 'client-key-1',
    generation: 2,
    ...overrides
  };
}

test('one Idempotency-Key is one switch request even when two clients race it', async () => {
  const context = await fixture();
  try {
    // Web and desktop forward the same click. Two requests would mean two stop
    // barriers and two target invocations for one user intent (AC8).
    const [a, b] = await Promise.all([
      context.store.open(request()),
      context.reopen().open(request())
    ]);

    assert.deepEqual([a.status, b.status].sort(), ['duplicate', 'opened']);
    const stored = context.store.list('session-1');
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.status, 'requested');
    assert.equal(stored[0]?.version, 1, 'a fresh request starts at version 1');
    assert.equal(stored[0]?.targetRuntimeType, 'claude_code');
    // A duplicate returns the same request, not a copy with a new id.
    const [first, second] = [a, b].map((outcome) => (outcome as { request?: { id: string } }).request?.id);
    assert.equal(first, second);
  } finally {
    await context.cleanup();
  }
});

test('a different target under the same key is refused rather than silently retargeted', async () => {
  const context = await fixture();
  try {
    await context.store.open(request());
    const conflicting = await context.store.open(request({ targetRuntimeType: 'codex' }));

    assert.equal(conflicting.status, 'rejected');
    assert.equal((conflicting as { code?: string }).code, 'RUNTIME_SWITCH_IDEMPOTENCY_CONFLICT');
    assert.equal(
      context.store.list('session-1')[0]?.targetRuntimeType,
      'claude_code',
      'the stored intent is the one the user actually submitted first'
    );
  } finally {
    await context.cleanup();
  }
});

test('only one switch request may be in flight for a Session', async () => {
  const context = await fixture();
  try {
    await context.store.open(request());
    const second = await context.store.open(request({ idempotencyKey: 'client-key-2' }));

    assert.equal(second.status, 'rejected');
    assert.equal((second as { code?: string }).code, 'RUNTIME_SWITCH_ALREADY_IN_PROGRESS');
  } finally {
    await context.cleanup();
  }
});

test('a completed switch frees the Session for the next one', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(request());
    const id = (opened as { request: { id: string } }).request.id;
    for (const status of ['preflighted', 'stop_confirmed', 'applying', 'completed'] as const) {
      const moved = await context.store.transition(id, status, { generation: 2 });
      assert.equal(moved.status, 'applied', `${status} is a legal step`);
    }

    const next = await context.store.open(request({ idempotencyKey: 'client-key-2' }));
    assert.equal(next.status, 'opened');
    assert.equal(context.store.list('session-1').length, 2);
  } finally {
    await context.cleanup();
  }
});

test('each accepted transition advances the version exactly once', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(request());
    const id = (opened as { request: { id: string } }).request.id;

    const preflighted = await context.store.transition(id, 'preflighted', { generation: 2 });
    assert.equal((preflighted as { request: { version: number } }).request.version, 2);

    // A replayed transition is the same fact, so it must not mint a new version:
    // the version is what the client and the outbox dedupe on (AC8/AC10).
    const replay = await context.store.transition(id, 'preflighted', { generation: 2 });
    assert.equal(replay.status, 'idempotent');
    assert.equal((replay as { request: { version: number } }).request.version, 2);

    const stopping = await context.store.transition(id, 'stopping', { generation: 2 });
    assert.equal((stopping as { request: { version: number } }).request.version, 3);
  } finally {
    await context.cleanup();
  }
});

test('an illegal transition is refused and leaves the request untouched', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(request());
    const id = (opened as { request: { id: string } }).request.id;
    await context.store.transition(id, 'preflighted', { generation: 2 });
    await context.store.transition(id, 'stopping', { generation: 2 });

    // I1: applying means the target Runtime takes ownership. Reaching it from
    // stopping would hand ownership over while the old invocation may still run.
    const skipped = await context.store.transition(id, 'applying', { generation: 2 });
    assert.equal(skipped.status, 'rejected');
    assert.equal((skipped as { code?: string }).code, 'RUNTIME_SWITCH_ILLEGAL_TRANSITION');

    const stored = context.store.list('session-1')[0];
    assert.equal(stored?.status, 'stopping');
    assert.equal(stored?.version, 3, 'a refused transition does not burn a version');
  } finally {
    await context.cleanup();
  }
});

test('a failure records the stage it failed in and a safe error only', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(request());
    const id = (opened as { request: { id: string } }).request.id;
    await context.store.transition(id, 'preflighted', { generation: 2 });

    const failed = await context.store.transition(id, 'failed', {
      generation: 2,
      error: { code: 'RUNTIME_SWITCH_TARGET_OFFLINE', message: '目标 Runtime 当前离线。', retryable: true }
    });

    assert.equal(failed.status, 'applied');
    const stored = context.store.list('session-1')[0];
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.failureStage, 'preflighted', 'the stage it was in when it failed');
    assert.equal(stored?.error?.code, 'RUNTIME_SWITCH_TARGET_OFFLINE');

    // Terminal is terminal: a failed request cannot quietly resume.
    const revived = await context.store.transition(id, 'applying', { generation: 2 });
    assert.equal(revived.status, 'rejected');
  } finally {
    await context.cleanup();
  }
});

test('a deleted Session refuses both new requests and late transitions', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(request());
    const id = (opened as { request: { id: string } }).request.id;
    await context.persistence.setCollection('sessionLifecyclesBySession', {
      'session-1': {
        contractVersion: 'main-agent-collaboration/v1',
        sessionId: 'session-1',
        dataEpoch: 'epoch',
        generation: 2,
        revision: 2,
        state: 'deleted',
        admission: 'closed',
        stopStatus: 'idle'
      }
    });

    const late = await context.store.transition(id, 'preflighted', { generation: 2 });
    assert.equal(late.status, 'rejected');
    assert.equal((late as { code?: string }).code, 'SESSION_ADMISSION_CLOSED');

    const fresh = await context.store.open(request({ idempotencyKey: 'client-key-3' }));
    assert.equal(fresh.status, 'rejected');
    assert.equal((fresh as { code?: string }).code, 'SESSION_ADMISSION_CLOSED');

    // The record stays readable for audit rather than being erased.
    assert.equal(context.store.list('session-1').length, 1);
  } finally {
    await context.cleanup();
  }
});

test('a restored Session refuses a transition from the previous generation', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(request());
    const id = (opened as { request: { id: string } }).request.id;
    await context.persistence.setCollection('sessionLifecyclesBySession', {
      'session-1': {
        contractVersion: 'main-agent-collaboration/v1',
        sessionId: 'session-1',
        dataEpoch: 'epoch',
        generation: 3,
        revision: 3,
        state: 'active',
        admission: 'open',
        stopStatus: 'idle'
      }
    });

    // I6: a callback from the generation before the restore may not write.
    const stale = await context.store.transition(id, 'preflighted', { generation: 2 });
    assert.equal(stale.status, 'rejected');
    assert.equal((stale as { code?: string }).code, 'RUNTIME_SWITCH_STALE_GENERATION');
    assert.equal(context.store.list('session-1')[0]?.status, 'requested');
  } finally {
    await context.cleanup();
  }
});

test('a restart keeps the request, its version and its stop binding', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(request());
    const id = (opened as { request: { id: string } }).request.id;
    await context.store.transition(id, 'preflighted', { generation: 2 });
    await context.store.transition(id, 'stopping', {
      generation: 2,
      stopRequestId: 'stop-1',
      stoppedInvocationIds: ['invocation-old']
    });

    const afterRestart = context.reopen();
    const recovered = afterRestart.unresolved('session-1');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, 'stopping');
    assert.equal(recovered[0]?.version, 3, 'the version does not restart with the process');
    assert.equal(recovered[0]?.stopRequestId, 'stop-1');
    assert.deepEqual(recovered[0]?.stoppedInvocationIds, ['invocation-old']);
    assert.equal(recovered[0]?.resumeAfterSwitch, true, 'the resume intent survives the restart');
  } finally {
    await context.cleanup();
  }
});

test('reads are snapshots, so a caller cannot mutate stored state in place', async () => {
  const context = await fixture();
  try {
    await context.store.open(request());
    const stored = context.store.list('session-1');
    stored[0]!.status = 'completed';
    stored[0]!.stoppedInvocationIds.push('smuggled');

    const reread = context.store.list('session-1');
    assert.equal(reread[0]?.status, 'requested');
    assert.deepEqual(reread[0]?.stoppedInvocationIds, []);
  } finally {
    await context.cleanup();
  }
});
