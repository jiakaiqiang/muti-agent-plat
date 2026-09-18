import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableWorkItemTokens,
  createWorkItemBudgetLedger,
  reserveWorkItemBudget,
  settleWorkItemBudget
} from './work-item-budget.js';

const T0 = '2026-09-17T00:00:00.000Z';

function ledger(limitTokens = 1_000) {
  return createWorkItemBudgetLedger({ workItemId: 'work-item-1', limitTokens, now: T0 });
}

function reserve(current: ReturnType<typeof ledger>, overrides: Partial<{
  attemptId: string;
  operationId: string;
  category: string;
  requestedTokens: number;
}> = {}) {
  return reserveWorkItemBudget(current, {
    attemptId: 'attempt-1',
    operationId: 'operation-1',
    category: 'execution',
    requestedTokens: 100,
    now: T0,
    ...overrides
  } as never);
}

test('a reservation is committed before the call and reduces what is still available', () => {
  const start = ledger(1_000);
  assert.equal(availableWorkItemTokens(start), 1_000);

  const reserved = reserve(start, { requestedTokens: 400 });
  assert.equal(reserved.status, 'reserved');
  assert.equal(reserved.ledger.reservedTokens, 400);
  assert.equal(reserved.ledger.actualTokens, 0);
  assert.equal(availableWorkItemTokens(reserved.ledger), 600);
});

test('an attempt cannot be reserved twice, so a retry cannot double-charge the requirement', () => {
  const first = reserve(ledger(1_000), { attemptId: 'attempt-1', requestedTokens: 400 });
  assert.equal(first.status, 'reserved');

  const again = reserve(first.ledger, { attemptId: 'attempt-1', requestedTokens: 400 });
  assert.equal(again.status, 'reserved', 'a duplicate reservation is not an error');
  assert.equal(again.ledger.reservedTokens, 400, 'the requirement must not be charged twice');
  assert.equal(again.ledger.reservations.length, 1);
});

test('a request that exceeds the remaining budget is refused with an explainable outcome', () => {
  const reserved = reserve(ledger(1_000), { requestedTokens: 900 });
  assert.equal(reserved.status, 'reserved');

  const refused = reserve(reserved.ledger, { attemptId: 'attempt-2', requestedTokens: 400 });
  assert.equal(refused.status, 'insufficient');
  assert.equal(refused.code, 'WORK_ITEM_BUDGET_EXHAUSTED');
  assert.equal(refused.availableTokens, 100);
  assert.equal(refused.requestedTokens, 400);
  assert.equal(
    refused.ledger.reservations.length,
    1,
    'a refused reservation must not be recorded'
  );
});

test('settlement replaces the reservation with the measured usage', () => {
  const reserved = reserve(ledger(1_000), { requestedTokens: 400 });
  const settled = settleWorkItemBudget(reserved.ledger, {
    attemptId: 'attempt-1',
    outcome: { kind: 'reported', actualTokens: 320 },
    now: T0
  });

  assert.equal(settled.status, 'settled');
  assert.equal(settled.ledger.reservedTokens, 0, 'the outstanding reservation must be released');
  assert.equal(settled.ledger.actualTokens, 320);
  assert.equal(availableWorkItemTokens(settled.ledger), 680);
});

test('settling the same attempt twice is idempotent', () => {
  const reserved = reserve(ledger(1_000), { requestedTokens: 400 });
  const first = settleWorkItemBudget(reserved.ledger, {
    attemptId: 'attempt-1',
    outcome: { kind: 'reported', actualTokens: 320 },
    now: T0
  });
  const second = settleWorkItemBudget(first.ledger, {
    attemptId: 'attempt-1',
    outcome: { kind: 'reported', actualTokens: 320 },
    now: T0
  });

  assert.equal(second.status, 'idempotent');
  assert.equal(second.ledger.actualTokens, 320, 'a replay must not charge the usage again');
  assert.equal(second.ledger.revision, first.ledger.revision, 'a replay must not bump the revision');
});

test('an attempt that was never reserved cannot be settled', () => {
  const outcome = settleWorkItemBudget(ledger(1_000), {
    attemptId: 'attempt-never-reserved',
    outcome: { kind: 'reported', actualTokens: 320 },
    now: T0
  });

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.code, 'WORK_ITEM_BUDGET_ATTEMPT_UNKNOWN');
});

test('a failed call with unavailable usage keeps a conservative bound instead of refunding it', () => {
  const reserved = reserve(ledger(1_000), { requestedTokens: 400 });
  const settled = settleWorkItemBudget(reserved.ledger, {
    attemptId: 'attempt-1',
    outcome: { kind: 'unavailable' },
    now: T0
  });

  assert.equal(settled.status, 'settled');
  assert.equal(settled.ledger.reservedTokens, 0);
  assert.equal(
    settled.ledger.actualTokens,
    0,
    'unknown usage is not a measurement, so it must not be reported as actual tokens'
  );
  assert.equal(
    settled.ledger.unknownTokens,
    400,
    'the reservation cap is retained as the conservative unknown bound'
  );
  assert.equal(
    availableWorkItemTokens(settled.ledger),
    600,
    'a possibly-billed call must not silently return its whole allowance'
  );
});

test('every counted category accumulates into the same requirement budget', () => {
  let current = ledger(1_000);
  for (const category of ['classification', 'consultation', 'retry', 'summary', 'supplemental_read']) {
    const reserved = reserve(current, {
      attemptId: `attempt-${category}`,
      category,
      requestedTokens: 150
    });
    assert.equal(reserved.status, 'reserved', `${category} must be counted`);
    const settled = settleWorkItemBudget(reserved.ledger, {
      attemptId: `attempt-${category}`,
      outcome: { kind: 'reported', actualTokens: 150 },
      now: T0
    });
    current = settled.ledger;
  }

  assert.equal(current.actualTokens, 750, 'classification/consultation/retry/summary/supplement must all count');
  assert.equal(availableWorkItemTokens(current), 250);
});

test('spending past the limit is recorded rather than hidden', () => {
  const reserved = reserve(ledger(500), { requestedTokens: 400 });
  const settled = settleWorkItemBudget(reserved.ledger, {
    attemptId: 'attempt-1',
    // The provider reports more than was reserved: a real overrun, not a rounding artifact.
    outcome: { kind: 'reported', actualTokens: 700 },
    now: T0
  });

  assert.equal(settled.ledger.actualTokens, 700);
  assert.equal(availableWorkItemTokens(settled.ledger), 0, 'availability never reports a negative allowance');
  assert.equal(settled.ledger.overrunTokens, 200, 'the overrun must stay visible for the ledger owner');
});
