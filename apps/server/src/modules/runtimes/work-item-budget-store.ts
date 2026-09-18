import type { WorkItemBudgetCategory, WorkItemBudgetLedger } from '@agent-cluster/shared';
import type { PersistedState, PersistenceService } from '../persistence/persistence.service.js';
import {
  availableWorkItemTokens,
  createWorkItemBudgetLedger,
  reserveWorkItemBudget,
  settleWorkItemBudget,
  type WorkItemBudgetReserveOutcome,
  type WorkItemBudgetSettleOutcome
} from './work-item-budget.js';

export const WORK_ITEM_BUDGETS_COLLECTION = 'workItemBudgetsBySession';
export type WorkItemBudgetsBySession = Record<string, WorkItemBudgetLedger[]>;

export type WorkItemBudgetReserveRequest = {
  sessionId: string;
  workItemId: string;
  attemptId: string;
  operationId: string;
  category: WorkItemBudgetCategory;
  requestedTokens: number;
  /** Applied only when the ledger is created; an existing limit is never silently changed. */
  limitTokens?: number;
  now?: string;
};

export type WorkItemBudgetSettleRequest = {
  sessionId: string;
  workItemId: string;
  attemptId: string;
  outcome: { kind: 'reported'; actualTokens: number } | { kind: 'unavailable' };
  now?: string;
};

/**
 * Durable requirement-level budget ledger.
 *
 * Reservation runs inside the same persistence transaction that reads the
 * ledger, so two processes cannot both spend the same remaining allowance, and
 * the committed ledger survives a restart instead of resetting on retry.
 */
export class WorkItemBudgetStore {
  private pending = Promise.resolve();
  private cache: WorkItemBudgetsBySession = {};

  constructor(
    private readonly persistence: PersistenceService,
    private readonly now = () => new Date().toISOString()
  ) {}

  get(sessionId: string, workItemId: string): WorkItemBudgetLedger | undefined {
    return this.list(sessionId).find((item) => item.workItemId === workItemId);
  }

  available(sessionId: string, workItemId: string): number | undefined {
    const ledger = this.get(sessionId, workItemId);
    return ledger ? availableWorkItemTokens(ledger) : undefined;
  }

  reserve(input: WorkItemBudgetReserveRequest): Promise<WorkItemBudgetReserveOutcome> {
    const now = input.now ?? this.now();
    return this.mutate(input.sessionId, (ledgers) => {
      const existing = ledgers.find((item) => item.workItemId === input.workItemId);
      const base = existing ?? createWorkItemBudgetLedger({
        workItemId: input.workItemId,
        limitTokens: input.limitTokens ?? 0,
        now
      });
      const outcome = reserveWorkItemBudget(base, {
        attemptId: input.attemptId,
        operationId: input.operationId,
        category: input.category,
        requestedTokens: input.requestedTokens,
        now
      });
      // A refusal changes no accounted usage, so it must not be persisted: a
      // stale empty ledger write would race the winner's revision and leave this
      // instance's projection diverged from the committed row.
      if (outcome.status === 'reserved') replace(ledgers, outcome.ledger);
      return outcome;
    });
  }

  settle(input: WorkItemBudgetSettleRequest): Promise<WorkItemBudgetSettleOutcome> {
    const now = input.now ?? this.now();
    return this.mutate(input.sessionId, (ledgers) => {
      const ledger = ledgers.find((item) => item.workItemId === input.workItemId);
      if (!ledger) {
        return {
          status: 'rejected',
          code: 'WORK_ITEM_BUDGET_ATTEMPT_UNKNOWN',
          ledger: createWorkItemBudgetLedger({ workItemId: input.workItemId, limitTokens: 0, now })
        };
      }
      const outcome = settleWorkItemBudget(ledger, {
        attemptId: input.attemptId,
        outcome: input.outcome,
        now
      });
      replace(ledgers, outcome.ledger);
      return outcome;
    });
  }

  private list(sessionId: string): WorkItemBudgetLedger[] {
    return this.persistence.getCollection<WorkItemBudgetsBySession>(WORK_ITEM_BUDGETS_COLLECTION, this.cache)[sessionId] ?? [];
  }

  private mutate<T>(
    sessionId: string,
    mutation: (ledgers: WorkItemBudgetLedger[]) => T
  ): Promise<T> {
    const run = async () => {
      let committed: WorkItemBudgetsBySession | undefined;
      const result = await this.persistence.mutateCollections(
        [WORK_ITEM_BUDGETS_COLLECTION],
        (draft: PersistedState) => {
          const all = (draft[WORK_ITEM_BUDGETS_COLLECTION] ??= {}) as WorkItemBudgetsBySession;
          const outcome = mutation(all[sessionId] ??= []);
          committed = structuredClone(all);
          return outcome;
        }
      );
      if (committed) this.cache = committed;
      return result;
    };
    // Serialize in-process mutations; cross-process atomicity comes from the
    // persistence transaction itself.
    const result = this.pending.then(run, run);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}

function replace(ledgers: WorkItemBudgetLedger[], next: WorkItemBudgetLedger) {
  const index = ledgers.findIndex((item) => item.workItemId === next.workItemId);
  if (index === -1) ledgers.push(next);
  else ledgers[index] = next;
}
