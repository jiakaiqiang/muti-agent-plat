import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistenceService } from '../persistence/persistence.service.js';
import { WorkItemBudgetStore } from './work-item-budget-store.js';

const NOW = '2026-09-17T00:00:00.000Z';

async function withStore(
  fn: (context: { store: WorkItemBudgetStore; persistence: PersistenceService; directory: string }) => Promise<void>
) {
  const directory = mkdtempSync(join(tmpdir(), 'work-item-budget-'));
  const persistence = new PersistenceService({
    enabled: true,
    backend: 'file',
    filePath: join(directory, 'state.json')
  });
  await persistence.initialize();
  try {
    await fn({ store: new WorkItemBudgetStore(persistence, () => NOW), persistence, directory });
  } finally {
    await persistence.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
  }
}

function reserveInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    workItemId: 'work-item-1',
    attemptId: 'attempt-1',
    operationId: 'operation-1',
    category: 'execution',
    requestedTokens: 400,
    limitTokens: 1_000,
    now: NOW,
    ...overrides
  } as never;
}

test('a reservation survives a restart instead of resetting the requirement budget', async () => {
  await withStore(async ({ store, persistence }) => {
    const reserved = await store.reserve(reserveInput());
    assert.equal(reserved.status, 'reserved');
    assert.equal(store.available('session-1', 'work-item-1'), 600);

    // A fresh store over the same file is what a restart looks like.
    const reopened = new WorkItemBudgetStore(persistence, () => NOW);
    assert.equal(reopened.available('session-1', 'work-item-1'), 600);
    const refused = await reopened.reserve(reserveInput({ attemptId: 'attempt-2', requestedTokens: 700 }));
    assert.equal(refused.status, 'insufficient');
    assert.equal(refused.availableTokens, 600);
  });
});

test('settlement releases the reservation and records the measured usage', async () => {
  await withStore(async ({ store }) => {
    await store.reserve(reserveInput());
    const settled = await store.settle({
      sessionId: 'session-1',
      workItemId: 'work-item-1',
      attemptId: 'attempt-1',
      outcome: { kind: 'reported', actualTokens: 320 },
      now: NOW
    });

    assert.equal(settled.status, 'settled');
    const ledger = store.get('session-1', 'work-item-1');
    assert.equal(ledger?.reservedTokens, 0);
    assert.equal(ledger?.actualTokens, 320);
    assert.equal(store.available('session-1', 'work-item-1'), 680);
  });
});

test('a replayed settlement does not charge the requirement twice', async () => {
  await withStore(async ({ store }) => {
    await store.reserve(reserveInput());
    const request = {
      sessionId: 'session-1',
      workItemId: 'work-item-1',
      attemptId: 'attempt-1',
      outcome: { kind: 'reported', actualTokens: 320 },
      now: NOW
    } as const;
    await store.settle(request);
    const replay = await store.settle(request);

    assert.equal(replay.status, 'idempotent');
    assert.equal(store.get('session-1', 'work-item-1')?.actualTokens, 320);
  });
});

test('an attempt that was never reserved cannot be settled through the store', async () => {
  await withStore(async ({ store }) => {
    await store.reserve(reserveInput());
    const rejected = await store.settle({
      sessionId: 'session-1',
      workItemId: 'work-item-1',
      attemptId: 'attempt-never-reserved',
      outcome: { kind: 'reported', actualTokens: 320 },
      now: NOW
    });

    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.code, 'WORK_ITEM_BUDGET_ATTEMPT_UNKNOWN');
    assert.equal(store.get('session-1', 'work-item-1')?.actualTokens, 0);
  });
});

test('concurrent reservations cannot both spend the same remaining allowance', async () => {
  await withStore(async ({ store }) => {
    // Both are issued before either settles, which is what two experts on one
    // requirement look like.
    const [first, second] = await Promise.all([
      store.reserve(reserveInput({ attemptId: 'attempt-a', requestedTokens: 700 })),
      store.reserve(reserveInput({ attemptId: 'attempt-b', requestedTokens: 700 }))
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, ['insufficient', 'reserved'], 'exactly one may commit');
    const ledger = store.get('session-1', 'work-item-1');
    assert.equal(ledger?.reservedTokens, 700, 'the committed allowance must not be double-spent');
    assert.equal(store.available('session-1', 'work-item-1'), 300);
  });
});

test('unavailable usage keeps the reservation cap instead of refunding it', async () => {
  await withStore(async ({ store }) => {
    await store.reserve(reserveInput());
    await store.settle({
      sessionId: 'session-1',
      workItemId: 'work-item-1',
      attemptId: 'attempt-1',
      outcome: { kind: 'unavailable' },
      now: NOW
    });

    const ledger = store.get('session-1', 'work-item-1');
    assert.equal(ledger?.actualTokens, 0);
    assert.equal(ledger?.unknownTokens, 400);
    assert.equal(store.available('session-1', 'work-item-1'), 600);
  });
});

test('separate requirements keep separate ledgers', async () => {
  await withStore(async ({ store }) => {
    await store.reserve(reserveInput({ workItemId: 'work-item-1', attemptId: 'a', requestedTokens: 400 }));
    await store.reserve(reserveInput({ workItemId: 'work-item-2', attemptId: 'b', requestedTokens: 400 }));

    assert.equal(store.available('session-1', 'work-item-1'), 600);
    assert.equal(store.available('session-1', 'work-item-2'), 600);
    assert.equal(store.available('session-1', 'work-item-3'), undefined, 'an unknown requirement has no ledger yet');
  });
});
