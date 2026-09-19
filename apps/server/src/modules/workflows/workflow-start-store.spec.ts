import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkflowStartBinding } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { WorkflowStartStore } from './workflow-start-store.js';

async function fixture(withLifecycle = true) {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-start-store-'));
  const persistence = new PersistenceService({
    enabled: true,
    backend: 'file',
    filePath: join(directory, 'state.json')
  });
  await persistence.initialize();
  if (withLifecycle) {
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
  }
  return {
    persistence,
    store: new WorkflowStartStore(persistence, () => '2026-09-19T00:00:00.000Z'),
    reopen: () => new WorkflowStartStore(persistence, () => '2026-09-19T00:00:00.000Z'),
    async cleanup() {
      await persistence.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function binding(overrides: Partial<WorkflowStartBinding> = {}): WorkflowStartBinding {
  return {
    sessionId: 'session-1',
    workItemId: 'wi-1',
    workItemRevision: 3,
    confirmationId: 'confirm-1',
    documentId: 'doc-1',
    documentRevision: 2,
    contentHash: 'hash-doc-2',
    workflowId: 'wf-1',
    workflowVersion: 4,
    definitionHash: 'hash-wf-4',
    ...overrides
  };
}

test('one submitted decision produces exactly one pending request across concurrent submits', async () => {
  const context = await fixture();
  try {
    // Two clicks, two server instances, same decision: the logical key is what
    // makes this one start request rather than two workflow runs.
    const [a, b] = await Promise.all([
      context.store.submit({ binding: binding(), generation: 2 }),
      context.reopen().submit({ binding: binding(), generation: 2 })
    ]);

    assert.deepEqual([a.status, b.status].sort(), ['duplicate', 'submitted']);
    assert.equal(context.store.list('session-1').length, 1);
  } finally {
    await context.cleanup();
  }
});

test('a revised document is a different start request, not a replay of the approved one', async () => {
  const context = await fixture();
  try {
    const first = await context.store.submit({ binding: binding(), generation: 2 });
    assert.equal(first.status, 'submitted');

    const revised = await context.store.submit({
      binding: binding({ documentRevision: 3, contentHash: 'hash-doc-3' }),
      generation: 2
    });

    assert.equal(revised.status, 'submitted', 'a new document version must not reuse the old approval');
    assert.equal(context.store.list('session-1').length, 2);
    assert.notEqual(
      revised.status === 'submitted' && revised.request.logicalKey,
      first.status === 'submitted' && first.request.logicalKey
    );
  } finally {
    await context.cleanup();
  }
});

test('submit is refused when the binding no longer matches live state', async () => {
  const context = await fixture();
  try {
    const refused = await context.store.submit({
      binding: binding(),
      generation: 2,
      current: { workItemRevision: 3, documentRevision: 3, contentHash: 'hash-doc-3', definitionHash: 'hash-wf-4' }
    });

    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'WORKFLOW_START_STALE_BINDING');
    assert.equal(context.store.list('session-1').length, 0, 'a refused submit leaves no request behind');
  } finally {
    await context.cleanup();
  }
});

test('a closed session cannot submit a start request', async () => {
  const context = await fixture();
  try {
    await context.persistence.setCollection('sessionLifecyclesBySession', {
      'session-1': {
        contractVersion: 'main-agent-collaboration/v1',
        sessionId: 'session-1',
        dataEpoch: 'epoch',
        generation: 2,
        revision: 2,
        state: 'active',
        admission: 'closed',
        stopStatus: 'stopping'
      }
    });

    const refused = await context.store.submit({ binding: binding(), generation: 2 });

    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'SESSION_ADMISSION_CLOSED');
  } finally {
    await context.cleanup();
  }
});

test('a stale generation cannot submit: a restored session must not run a pre-restore approval', async () => {
  const context = await fixture();
  try {
    const refused = await context.store.submit({ binding: binding(), generation: 1 });

    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'WORKFLOW_START_STALE_GENERATION');
  } finally {
    await context.cleanup();
  }
});

test('submit and dispatch are separate: only one claimer may dispatch a pending request', async () => {
  const context = await fixture();
  try {
    const submitted = await context.store.submit({ binding: binding(), generation: 2 });
    assert.equal(submitted.status, 'submitted');
    const requestId = submitted.status === 'submitted' ? submitted.request.id : '';

    // Two workers race for the same pending request.
    const [a, b] = await Promise.all([
      context.store.claim(requestId, { workerId: 'worker-a' }),
      context.reopen().claim(requestId, { workerId: 'worker-b' })
    ]);

    assert.deepEqual([a.status, b.status].sort(), ['already_claimed', 'claimed']);
    const stored = context.store.list('session-1')[0];
    assert.equal(stored.status, 'dispatched');
    assert.ok(stored.claimedBy, 'the winning worker is recorded so a crash is attributable');
  } finally {
    await context.cleanup();
  }
});

test('a pending request survives a restart and is still claimable exactly once', async () => {
  const context = await fixture();
  try {
    const submitted = await context.store.submit({ binding: binding(), generation: 2 });
    const requestId = submitted.status === 'submitted' ? submitted.request.id : '';

    // The process restarts before any worker picked the request up.
    const afterRestart = context.reopen();
    assert.deepEqual(afterRestart.claimable('session-1').map((item) => item.id), [requestId]);

    const claimed = await afterRestart.claim(requestId, { workerId: 'worker-after-restart' });
    assert.equal(claimed.status, 'claimed');
    assert.deepEqual(afterRestart.claimable('session-1'), [], 'a dispatched request is no longer claimable');
  } finally {
    await context.cleanup();
  }
});

test('completing a request records its run and makes a replayed submit return that run', async () => {
  const context = await fixture();
  try {
    const submitted = await context.store.submit({ binding: binding(), generation: 2 });
    const requestId = submitted.status === 'submitted' ? submitted.request.id : '';
    await context.store.claim(requestId, { workerId: 'worker-a' });

    const completed = await context.store.complete(requestId, { workflowRunId: 'run-1' });
    assert.equal(completed.status, 'completed');

    // A retried submit of the same decision must resolve to the existing run
    // instead of creating a second one.
    const replay = await context.store.submit({ binding: binding(), generation: 2 });
    assert.equal(replay.status, 'duplicate');
    assert.equal(replay.status === 'duplicate' && replay.request.workflowRunId, 'run-1');
    assert.equal(replay.status === 'duplicate' && replay.request.status, 'completed');
  } finally {
    await context.cleanup();
  }
});

test('a crashed dispatch is recoverable without creating a second run', async () => {
  const context = await fixture();
  try {
    const submitted = await context.store.submit({ binding: binding(), generation: 2 });
    const requestId = submitted.status === 'submitted' ? submitted.request.id : '';
    await context.store.claim(requestId, { workerId: 'worker-crashed' });

    // The worker died after claiming but before recording a run.
    const afterRestart = context.reopen();
    const recoverable = afterRestart.recoverable('session-1');
    assert.deepEqual(recoverable.map((item) => item.id), [requestId]);
    assert.equal(recoverable[0].workflowRunId, undefined, 'no run was created yet');

    const reclaimed = await afterRestart.claim(requestId, { workerId: 'worker-recovery', reclaimDispatched: true });
    assert.equal(reclaimed.status, 'claimed');
    await afterRestart.complete(requestId, { workflowRunId: 'run-recovered' });

    assert.equal(afterRestart.list('session-1').length, 1, 'recovery must not fork the request');
    assert.deepEqual(afterRestart.recoverable('session-1'), []);
  } finally {
    await context.cleanup();
  }
});

test('a completed request is never reclaimed and never carries a second run', async () => {
  const context = await fixture();
  try {
    const submitted = await context.store.submit({ binding: binding(), generation: 2 });
    const requestId = submitted.status === 'submitted' ? submitted.request.id : '';
    await context.store.claim(requestId, { workerId: 'worker-a' });
    await context.store.complete(requestId, { workflowRunId: 'run-1' });

    const again = await context.store.claim(requestId, { workerId: 'worker-b', reclaimDispatched: true });
    assert.equal(again.status, 'already_claimed');

    const second = await context.store.complete(requestId, { workflowRunId: 'run-2' });
    assert.equal(second.status, 'idempotent');
    assert.equal(context.store.list('session-1')[0].workflowRunId, 'run-1', 'the first run stays authoritative');
  } finally {
    await context.cleanup();
  }
});

test('stored requests carry no document body, only versions and hashes', async () => {
  const context = await fixture();
  try {
    await context.store.submit({ binding: binding(), generation: 2 });

    const serialized = JSON.stringify(context.store.list('session-1'));
    assert.equal(serialized.includes('hash-doc-2'), true, 'the hash is the binding');
    assert.equal(/goal|scope|acceptance/i.test(serialized), false, 'no requirement prose is copied into the request');
  } finally {
    await context.cleanup();
  }
});
