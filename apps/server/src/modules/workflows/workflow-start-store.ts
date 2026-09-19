import type { WorkflowStartBinding } from '@agent-cluster/shared';
import { isWorkflowStartBindingCurrent, workflowStartLogicalKey } from '@agent-cluster/shared';
import type { PersistedState, PersistenceService } from '../persistence/persistence.service.js';
import {
  SESSION_LIFECYCLES_COLLECTION,
  type SessionLifecyclesBySession
} from '../runtimes/session-lifecycle-store.js';

export const WORKFLOW_START_REQUESTS_COLLECTION = 'workflowStartRequestsBySession';
export type WorkflowStartRequestsBySession = Record<string, WorkflowStartRequest[]>;

export type WorkflowStartRequestStatus = 'pending' | 'dispatched' | 'completed';

/**
 * A durable record of "the user authorized this exact start".
 *
 * It holds only ids, revisions and hashes — never requirement prose. The
 * document itself stays the single authoritative text; copying it here would
 * create a second version that could drift from the one the user confirmed.
 */
export type WorkflowStartRequest = {
  id: string;
  sessionId: string;
  /** Every version the decision depended on, collapsed into one uniqueness key. */
  logicalKey: string;
  binding: WorkflowStartBinding;
  generation?: number;
  status: WorkflowStartRequestStatus;
  claimedBy?: string;
  workflowRunId?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowStartRejectionCode =
  | 'SESSION_ADMISSION_CLOSED'
  | 'WORKFLOW_START_STALE_GENERATION'
  | 'WORKFLOW_START_STALE_BINDING';

export type WorkflowStartSubmitInput = {
  binding: WorkflowStartBinding;
  generation?: number;
  /** Live versions to re-check the binding against, when the caller can read them. */
  current?: {
    workItemRevision: number;
    documentRevision: number;
    contentHash: string;
    definitionHash: string;
  };
  requestId?: string;
};

export type WorkflowStartSubmitOutcome =
  | { status: 'submitted'; request: WorkflowStartRequest }
  | { status: 'duplicate'; request: WorkflowStartRequest }
  | { status: 'rejected'; code: WorkflowStartRejectionCode };

export type WorkflowStartClaimOutcome =
  | { status: 'claimed'; request: WorkflowStartRequest }
  | { status: 'already_claimed'; request: WorkflowStartRequest }
  | { status: 'unknown' };

export type WorkflowStartCompleteOutcome =
  | { status: 'completed'; request: WorkflowStartRequest }
  | { status: 'idempotent'; request: WorkflowStartRequest }
  | { status: 'unknown' };

/**
 * Separates authorizing a workflow start from actually dispatching it.
 *
 * Before this, the start was one in-process call keyed on
 * `sessionId:confirmationId`, so a crash between "user clicked start" and "run
 * created" left nothing to recover from, and a revised document reusing that
 * confirmation replayed the old approval. Submitting writes a durable request
 * inside the persistence transaction; a worker then claims it exactly once and
 * records the run it produced.
 */
export class WorkflowStartStore {
  private pending = Promise.resolve();
  private cache: WorkflowStartRequestsBySession = {};

  constructor(
    private readonly persistence: PersistenceService,
    private readonly now = () => new Date().toISOString()
  ) {}

  list(sessionId: string): WorkflowStartRequest[] {
    return this.persistence.getCollection<WorkflowStartRequestsBySession>(
      WORKFLOW_START_REQUESTS_COLLECTION,
      this.cache
    )[sessionId] ?? [];
  }

  /** Requests nobody has picked up yet. */
  claimable(sessionId: string): WorkflowStartRequest[] {
    return this.list(sessionId).filter((item) => item.status === 'pending');
  }

  /**
   * Requests a worker claimed but never finished. The missing `workflowRunId` is
   * what makes them safe to retry: no run exists yet, so reclaiming cannot fork
   * a second one.
   */
  recoverable(sessionId: string): WorkflowStartRequest[] {
    return this.list(sessionId).filter((item) => item.status === 'dispatched' && !item.workflowRunId);
  }

  findByLogicalKey(sessionId: string, binding: WorkflowStartBinding): WorkflowStartRequest | undefined {
    const logicalKey = workflowStartLogicalKey(binding);
    return this.list(sessionId).find((item) => item.logicalKey === logicalKey);
  }

  submit(input: WorkflowStartSubmitInput): Promise<WorkflowStartSubmitOutcome> {
    const now = this.now();
    const sessionId = input.binding.sessionId;
    return this.mutate(sessionId, (rows, state): WorkflowStartSubmitOutcome => {
      const lifecycle = ((state[SESSION_LIFECYCLES_COLLECTION] ?? {}) as SessionLifecyclesBySession)[sessionId];
      if (lifecycle && (lifecycle.state !== 'active' || lifecycle.admission !== 'open')) {
        return { status: 'rejected', code: 'SESSION_ADMISSION_CLOSED' };
      }
      if (lifecycle && input.generation !== undefined && input.generation !== lifecycle.generation) {
        return { status: 'rejected', code: 'WORKFLOW_START_STALE_GENERATION' };
      }
      // Re-check against live versions: the approval may have been given against
      // a document or graph that has since moved on.
      if (input.current && !isWorkflowStartBindingCurrent(input.binding, input.current)) {
        return { status: 'rejected', code: 'WORKFLOW_START_STALE_BINDING' };
      }

      const logicalKey = workflowStartLogicalKey(input.binding);
      const existing = rows.find((item) => item.logicalKey === logicalKey);
      if (existing) return { status: 'duplicate', request: structuredClone(existing) };

      const request: WorkflowStartRequest = {
        id: input.requestId ?? crypto.randomUUID(),
        sessionId,
        logicalKey,
        binding: structuredClone(input.binding),
        ...(input.generation !== undefined ? { generation: input.generation } : {}),
        status: 'pending',
        createdAt: now,
        updatedAt: now
      };
      rows.push(request);
      return { status: 'submitted', request: structuredClone(request) };
    });
  }

  /**
   * Takes ownership of a pending request. `reclaimDispatched` is for recovery
   * only and still refuses a completed request, so a late worker can never
   * create a second run for a decision that already produced one.
   */
  claim(requestId: string, input: { workerId: string; reclaimDispatched?: boolean }): Promise<WorkflowStartClaimOutcome> {
    const now = this.now();
    return this.mutateById(requestId, (request): WorkflowStartClaimOutcome => {
      if (!request) return { status: 'unknown' };
      if (request.status === 'completed') return { status: 'already_claimed', request: structuredClone(request) };
      if (request.status === 'dispatched' && !input.reclaimDispatched) {
        return { status: 'already_claimed', request: structuredClone(request) };
      }
      request.status = 'dispatched';
      request.claimedBy = input.workerId;
      request.updatedAt = now;
      return { status: 'claimed', request: structuredClone(request) };
    });
  }

  /** Binds the run the dispatch produced. The first run recorded stays authoritative. */
  complete(requestId: string, input: { workflowRunId: string }): Promise<WorkflowStartCompleteOutcome> {
    const now = this.now();
    return this.mutateById(requestId, (request): WorkflowStartCompleteOutcome => {
      if (!request) return { status: 'unknown' };
      if (request.status === 'completed') return { status: 'idempotent', request: structuredClone(request) };
      request.status = 'completed';
      request.workflowRunId = input.workflowRunId;
      request.updatedAt = now;
      return { status: 'completed', request: structuredClone(request) };
    });
  }

  private mutateById<T>(
    requestId: string,
    mutation: (request: WorkflowStartRequest | undefined) => T
  ): Promise<T> {
    return this.mutateAll((all) => {
      for (const rows of Object.values(all)) {
        const found = rows.find((item) => item.id === requestId);
        if (found) return mutation(found);
      }
      return mutation(undefined);
    });
  }

  private mutate<T>(
    sessionId: string,
    mutation: (rows: WorkflowStartRequest[], state: PersistedState) => T
  ): Promise<T> {
    return this.mutateAll((all, state) => mutation(all[sessionId] ??= [], state));
  }

  private mutateAll<T>(
    mutation: (all: WorkflowStartRequestsBySession, state: PersistedState) => T
  ): Promise<T> {
    const run = async () => {
      let committed: WorkflowStartRequestsBySession | undefined;
      const result = await this.persistence.mutateCollections(
        [WORKFLOW_START_REQUESTS_COLLECTION, SESSION_LIFECYCLES_COLLECTION],
        (draft: PersistedState) => {
          const all = (draft[WORKFLOW_START_REQUESTS_COLLECTION] ??= {}) as WorkflowStartRequestsBySession;
          const outcome = mutation(all, draft);
          committed = structuredClone(all);
          return outcome;
        }
      );
      if (committed) this.cache = committed;
      return result;
    };
    // Serialize in-process; cross-process atomicity comes from the persistence transaction.
    const result = this.pending.then(run, run);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
}
