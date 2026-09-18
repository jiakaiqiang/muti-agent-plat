import type {
  WorkItemBudgetCategory,
  WorkItemBudgetLedger,
  WorkItemBudgetReservation,
  WorkItemBudgetSettlement
} from '@agent-cluster/shared';

export type WorkItemBudgetReserveInput = {
  attemptId: string;
  operationId: string;
  category: WorkItemBudgetCategory;
  requestedTokens: number;
  now: string;
};

export type WorkItemBudgetSettleInput = {
  attemptId: string;
  outcome: { kind: 'reported'; actualTokens: number } | { kind: 'unavailable' };
  now: string;
};

export type WorkItemBudgetReserveOutcome =
  | { status: 'reserved'; ledger: WorkItemBudgetLedger }
  | {
      status: 'insufficient';
      code: 'WORK_ITEM_BUDGET_EXHAUSTED';
      ledger: WorkItemBudgetLedger;
      availableTokens: number;
      requestedTokens: number;
    };

export type WorkItemBudgetSettleOutcome =
  | { status: 'settled'; ledger: WorkItemBudgetLedger }
  | { status: 'idempotent'; ledger: WorkItemBudgetLedger }
  | { status: 'rejected'; code: 'WORK_ITEM_BUDGET_ATTEMPT_UNKNOWN'; ledger: WorkItemBudgetLedger };

function normalizeTokens(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : 0;
}

function clone(ledger: WorkItemBudgetLedger): WorkItemBudgetLedger {
  return {
    ...ledger,
    reservations: ledger.reservations.map((item) => ({ ...item })),
    settlements: ledger.settlements.map((item) => ({ ...item }))
  };
}

export function createWorkItemBudgetLedger(input: {
  workItemId: string;
  limitTokens: number;
  now: string;
}): WorkItemBudgetLedger {
  return {
    workItemId: input.workItemId as WorkItemBudgetLedger['workItemId'],
    limitTokens: normalizeTokens(input.limitTokens),
    reservedTokens: 0,
    actualTokens: 0,
    unknownTokens: 0,
    overrunTokens: 0,
    reservations: [],
    settlements: [],
    revision: 1,
    updatedAt: input.now
  };
}

/**
 * What the requirement can still commit. Reservations count against it, so
 * concurrent experts cannot each spend the whole remaining allowance.
 */
export function availableWorkItemTokens(ledger: WorkItemBudgetLedger): number {
  const committed = ledger.reservedTokens + ledger.actualTokens + ledger.unknownTokens;
  return Math.max(0, ledger.limitTokens - committed);
}

function withDerivedTotals(ledger: WorkItemBudgetLedger): WorkItemBudgetLedger {
  return {
    ...ledger,
    overrunTokens: Math.max(0, ledger.actualTokens + ledger.unknownTokens - ledger.limitTokens)
  };
}

/**
 * Commits an allowance before the call starts. The `attemptId` is the
 * idempotency key: replaying a reservation never charges the requirement twice,
 * so a retry must present a new attempt id rather than reuse the settled one.
 */
export function reserveWorkItemBudget(
  ledger: WorkItemBudgetLedger,
  input: WorkItemBudgetReserveInput
): WorkItemBudgetReserveOutcome {
  const known =
    ledger.reservations.some((item) => item.attemptId === input.attemptId) ||
    ledger.settlements.some((item) => item.attemptId === input.attemptId);
  if (known) return { status: 'reserved', ledger };

  const requestedTokens = normalizeTokens(input.requestedTokens);
  const availableTokens = availableWorkItemTokens(ledger);
  if (requestedTokens > availableTokens) {
    return {
      status: 'insufficient',
      code: 'WORK_ITEM_BUDGET_EXHAUSTED',
      ledger,
      availableTokens,
      requestedTokens
    };
  }

  const reservation: WorkItemBudgetReservation = {
    attemptId: input.attemptId,
    operationId: input.operationId,
    category: input.category,
    reservedTokens: requestedTokens,
    reservedAt: input.now
  };
  return {
    status: 'reserved',
    ledger: withDerivedTotals({
      ...clone(ledger),
      reservedTokens: ledger.reservedTokens + requestedTokens,
      reservations: [...ledger.reservations, reservation],
      revision: ledger.revision + 1,
      updatedAt: input.now
    })
  };
}

/**
 * Replaces the reservation with what the call actually cost. A replay of the
 * same attempt is a no-op, and an attempt that was never reserved cannot be
 * settled — either would corrupt the requirement's ledger.
 */
export function settleWorkItemBudget(
  ledger: WorkItemBudgetLedger,
  input: WorkItemBudgetSettleInput
): WorkItemBudgetSettleOutcome {
  const reservation = ledger.reservations.find((item) => item.attemptId === input.attemptId);
  if (!reservation) {
    const alreadySettled = ledger.settlements.some((item) => item.attemptId === input.attemptId);
    return alreadySettled
      ? { status: 'idempotent', ledger }
      : { status: 'rejected', code: 'WORK_ITEM_BUDGET_ATTEMPT_UNKNOWN', ledger };
  }

  const actualTokens = input.outcome.kind === 'reported' ? normalizeTokens(input.outcome.actualTokens) : 0;
  const unknownTokens = input.outcome.kind === 'unavailable' ? reservation.reservedTokens : 0;
  const settlement: WorkItemBudgetSettlement = {
    attemptId: input.attemptId,
    settledAt: input.now,
    outcome: input.outcome.kind,
    actualTokens,
    unknownTokens
  };

  return {
    status: 'settled',
    ledger: withDerivedTotals({
      ...clone(ledger),
      reservedTokens: Math.max(0, ledger.reservedTokens - reservation.reservedTokens),
      actualTokens: ledger.actualTokens + actualTokens,
      unknownTokens: ledger.unknownTokens + unknownTokens,
      reservations: ledger.reservations.filter((item) => item.attemptId !== input.attemptId),
      settlements: [...ledger.settlements, settlement],
      revision: ledger.revision + 1,
      updatedAt: input.now
    })
  };
}
