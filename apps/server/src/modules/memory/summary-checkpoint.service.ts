import type { SummaryCheckpointRecord, SummaryCheckpointRejectionCode, SummaryMemory } from '@agent-cluster/shared';
import { SUMMARY_CHECKPOINT_POLICY_VERSION } from '@agent-cluster/shared';
import type { WorkItemBudgetStore } from '../runtimes/work-item-budget-store.js';
import {
  SummaryCheckpointStore,
  type SummaryCheckpointDraft,
  summaryCheckpointLogicalKey
} from './summary-checkpoint-store.js';

export type SummaryCheckpointTrigger = 'phase_end' | 'work_item_end' | 'budget_threshold';

/** Events that must accumulate past the last checkpoint before a budget-threshold summary fires. */
export const SUMMARY_CHECKPOINT_EVENT_THRESHOLD = 24;
/** Bounded retries for transient persistence failures; rejections are never retried. */
export const SUMMARY_CHECKPOINT_MAX_ATTEMPTS = 3;

/**
 * Immutable inputs for one summary generation. Captured before generation so a
 * late commit can be compared against what the summary actually covered.
 */
export type SummaryCheckpointSnapshot = Omit<SummaryCheckpointDraft, 'summaryMemory' | 'policyVersion' | 'checkpointId'> & {
  policyVersion?: string;
};

export type SummaryCheckpointRequest = {
  trigger: SummaryCheckpointTrigger;
  snapshot: SummaryCheckpointSnapshot;
  /** Pure derivation over the immutable snapshot; must not read live state. */
  generate: (snapshot: SummaryCheckpointSnapshot) => SummaryMemory | Promise<SummaryMemory>;
  budget?: { requestedTokens: number; limitTokens: number; operationId: string };
  checkpointId?: string;
};

export type SummaryCheckpointOutcome =
  | { status: 'committed'; record: SummaryCheckpointRecord }
  | { status: 'duplicate'; record: SummaryCheckpointRecord }
  | { status: 'skipped'; reason: 'already_covered' | 'below_threshold' | 'budget_insufficient' }
  | { status: 'rejected'; code: SummaryCheckpointRejectionCode; latest?: SummaryCheckpointRecord }
  | { status: 'failed'; error: string; attempts: number };

/**
 * Incremental summary pipeline: decide → reserve budget → generate from an
 * immutable snapshot → version-checked commit → settle.
 *
 * Nothing here holds a persistence transaction across generation, and a stop
 * request is never blocked: a failed or rejected checkpoint simply leaves the
 * previous valid checkpoint in place.
 */
export class SummaryCheckpointService {
  constructor(
    private readonly store: SummaryCheckpointStore,
    private readonly budgets?: WorkItemBudgetStore
  ) {}

  latest(sessionId: string, workItemId: string) {
    return this.store.latest(sessionId, workItemId);
  }

  shouldCheckpoint(trigger: SummaryCheckpointTrigger, snapshot: SummaryCheckpointSnapshot):
    { run: true } | { run: false; reason: 'already_covered' | 'below_threshold' } {
    const policyVersion = snapshot.policyVersion ?? SUMMARY_CHECKPOINT_POLICY_VERSION;
    const latest = this.store.latest(snapshot.sessionId, snapshot.workItemId);
    if (!latest) {
      if (trigger === 'budget_threshold' && snapshot.coveredEventSeq < SUMMARY_CHECKPOINT_EVENT_THRESHOLD) {
        return { run: false, reason: 'below_threshold' };
      }
      return { run: true };
    }
    if (latest.logicalKey === summaryCheckpointLogicalKey({ ...snapshot, policyVersion })) {
      return { run: false, reason: 'already_covered' };
    }
    const versionMoved =
      snapshot.workItemRevision !== latest.workItemRevision ||
      snapshot.decisionLedgerRevision !== latest.decisionLedgerRevision ||
      policyVersion !== latest.policyVersion;
    const newEvents = snapshot.coveredEventSeq - latest.coveredEventSeq;
    if (trigger === 'budget_threshold') {
      return newEvents >= SUMMARY_CHECKPOINT_EVENT_THRESHOLD || versionMoved
        ? { run: true }
        : { run: false, reason: 'below_threshold' };
    }
    // Phase/work-item boundaries always summarize when anything moved; an
    // identical coverage with identical versions was already handled above.
    return newEvents > 0 || versionMoved ? { run: true } : { run: false, reason: 'already_covered' };
  }

  async checkpoint(request: SummaryCheckpointRequest): Promise<SummaryCheckpointOutcome> {
    const decision = this.shouldCheckpoint(request.trigger, request.snapshot);
    if (!decision.run) return { status: 'skipped', reason: decision.reason };
    const policyVersion = request.snapshot.policyVersion ?? SUMMARY_CHECKPOINT_POLICY_VERSION;
    const checkpointId = request.checkpointId ?? crypto.randomUUID();
    const attemptId = `summary:${checkpointId}`;

    if (request.budget && this.budgets) {
      const reserved = await this.budgets.reserve({
        sessionId: request.snapshot.sessionId,
        workItemId: request.snapshot.workItemId,
        attemptId,
        operationId: request.budget.operationId,
        category: 'summary',
        requestedTokens: request.budget.requestedTokens,
        limitTokens: request.budget.limitTokens
      });
      if (reserved.status !== 'reserved') return { status: 'skipped', reason: 'budget_insufficient' };
    }

    let summaryMemory: SummaryMemory;
    try {
      summaryMemory = await request.generate(structuredClone(request.snapshot));
    } catch (error) {
      await this.settle(request, attemptId, { kind: 'unavailable' });
      return { status: 'failed', error: errorMessage(error), attempts: 0 };
    }

    let lastError = '';
    for (let attempt = 1; attempt <= SUMMARY_CHECKPOINT_MAX_ATTEMPTS; attempt += 1) {
      try {
        const outcome = await this.store.commit({
          ...request.snapshot,
          policyVersion,
          summaryMemory,
          checkpointId
        });
        await this.settle(request, attemptId, { kind: 'reported', actualTokens: estimateSummaryTokens(summaryMemory) });
        if (outcome.status === 'rejected') return { status: 'rejected', code: outcome.code, latest: outcome.latest };
        return outcome;
      } catch (error) {
        lastError = errorMessage(error);
      }
    }
    await this.settle(request, attemptId, { kind: 'unavailable' });
    return { status: 'failed', error: lastError, attempts: SUMMARY_CHECKPOINT_MAX_ATTEMPTS };
  }

  private async settle(
    request: SummaryCheckpointRequest,
    attemptId: string,
    outcome: { kind: 'reported'; actualTokens: number } | { kind: 'unavailable' }
  ) {
    if (!request.budget || !this.budgets) return;
    await this.budgets.settle({
      sessionId: request.snapshot.sessionId,
      workItemId: request.snapshot.workItemId,
      attemptId,
      outcome
    });
  }
}

function estimateSummaryTokens(summary: SummaryMemory) {
  return Math.ceil(JSON.stringify(summary).length / 4);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
