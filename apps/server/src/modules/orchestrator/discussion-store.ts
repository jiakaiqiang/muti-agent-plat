import {
  canTransitionDelegation,
  canTransitionDiscussion,
  delegationLogicalKey,
  delegationsToRun,
  isExpertReport,
  supersedeStaleDelegations,
  type Delegation,
  type DelegationOrigin,
  type DelegationStatus,
  type DiscussionRun,
  type DiscussionRunStatus,
  type ExpertReport,
  type WorkItem
} from '@agent-cluster/shared';
import type { PersistedState, PersistenceService } from '../persistence/persistence.service.js';
import {
  SESSION_LIFECYCLES_COLLECTION,
  type SessionLifecyclesBySession
} from '../runtimes/session-lifecycle-store.js';

export const DISCUSSIONS_COLLECTION = 'discussionsBySession';
export type DiscussionsBySession = Record<string, DiscussionRun[]>;

export type DiscussionRejectionCode =
  | 'SESSION_ADMISSION_CLOSED'
  | 'DISCUSSION_STALE_GENERATION'
  | 'DISCUSSION_STALE_VERSION'
  | 'DISCUSSION_NOT_FOUND'
  | 'DISCUSSION_INVALID_TRANSITION'
  | 'DISCUSSION_ROUND_LIMIT'
  | 'DELEGATION_STALE_REVISION'
  | 'DELEGATION_NOT_FOUND'
  | 'DELEGATION_INVALID_TRANSITION'
  | 'EXPERT_REPORT_INVALID';

type Rejected = { status: 'rejected'; code: DiscussionRejectionCode };

export type OpenDiscussionInput = {
  sessionId: string;
  workItemId: string;
  requirementRevision: number;
  generation: number;
  coordinatorAgentId: string;
  objective: string;
  exitCondition: string;
  roundLimit: number;
  budgetTokens: number;
  parentDiscussionId?: string;
  discussionId?: string;
};

export type OpenDiscussionOutcome = { status: 'opened'; run: DiscussionRun } | Rejected;

export type ReserveDelegationInput = {
  targetAgentId: string;
  origin: DelegationOrigin;
  objective: string;
  expectedResult: string;
  budgetTokens: number;
  requirementRevision: number;
  deadline?: string;
  delegationId?: string;
  operationId?: string;
};

export type ReserveDelegationOutcome =
  | { status: 'reserved'; delegation: Delegation }
  | { status: 'duplicate'; delegation: Delegation }
  | Rejected;

export type DelegationTransition =
  | { status: 'running'; invocationId?: string }
  | { status: 'completed'; result: ExpertReport }
  | { status: 'blocked' }
  | { status: 'failed'; failure: { code: string; message: string; retryable: boolean } }
  | { status: 'cancelled' }
  | { status: 'superseded' };

export type TransitionOutcome<T> = { status: 'applied'; run: DiscussionRun; delegation?: T } | { status: 'idempotent' } | Rejected;

/**
 * Durable discussion runs and their delegations — the plan that recovery
 * trusts. The consultation loop executes what is recorded here; it does not
 * decide it.
 *
 * Same discipline as the 2B checkpoint store: every write runs inside the
 * persistence transaction that reads the current rows, a delegation is
 * reserved at most once per (discussion, expert, requirement revision), and
 * anything that fails validation is refused without leaving a row behind.
 */
export class DiscussionStore {
  private pending = Promise.resolve();
  private cache: DiscussionsBySession = {};

  constructor(
    private readonly persistence: PersistenceService,
    private readonly now = () => new Date().toISOString()
  ) {}

  list(sessionId: string): DiscussionRun[] {
    return this.persistence.getCollection<DiscussionsBySession>(DISCUSSIONS_COLLECTION, this.cache)[sessionId] ?? [];
  }

  get(sessionId: string, discussionId: string): DiscussionRun | undefined {
    const run = this.list(sessionId).find((item) => item.id === discussionId);
    return run ? structuredClone(run) : undefined;
  }

  /**
   * The run a restart should continue instead of opening a second one: same
   * requirement, same revision, same generation, and not yet past consulting.
   * `synthesizing` and later have nothing left to dispatch; `failed` is a
   * deliberate side exit that a retry re-plans rather than silently resumes.
   */
  findResumable(sessionId: string, scope: { workItemId: string; requirementRevision: number; generation: number }): DiscussionRun | undefined {
    const run = this.list(sessionId).find(
      (item) =>
        item.workItemId === scope.workItemId &&
        item.requirementRevision === scope.requirementRevision &&
        item.generation === scope.generation &&
        (item.status === 'planning' || item.status === 'consulting' || item.status === 'paused')
    );
    return run ? structuredClone(run) : undefined;
  }

  /**
   * The requirement's live run regardless of revision: the one a follow-up
   * attaches to and the one a requirement change supersedes in place.
   * `ready_for_confirmation` and `failed` are closed to new rounds.
   */
  findOpenRun(sessionId: string, scope: { workItemId: string; generation: number }): DiscussionRun | undefined {
    const run = this.list(sessionId).find(
      (item) =>
        item.workItemId === scope.workItemId &&
        item.generation === scope.generation &&
        item.status !== 'ready_for_confirmation' &&
        item.status !== 'failed'
    );
    return run ? structuredClone(run) : undefined;
  }

  /** Delegations a resume or restart should dispatch — never finished or older-generation work. */
  runnableDelegations(sessionId: string, discussionId: string, scope: { generation: number }): Delegation[] {
    const run = this.get(sessionId, discussionId);
    return run ? delegationsToRun(run.delegations, scope) : [];
  }

  open(input: OpenDiscussionInput): Promise<OpenDiscussionOutcome> {
    const now = this.now();
    return this.mutate(input.sessionId, (rows, state): OpenDiscussionOutcome => {
      const admission = this.checkAdmission(state, input.sessionId, input.generation);
      if (admission) return admission;
      const workItem = ((state.workItemsBySession as Record<string, WorkItem[]> | undefined)?.[input.sessionId] ?? [])
        .find((item) => item.id === input.workItemId);
      if (!workItem || workItem.revision !== input.requirementRevision) {
        return { status: 'rejected', code: 'DISCUSSION_STALE_VERSION' };
      }
      const run: DiscussionRun = {
        id: input.discussionId ?? crypto.randomUUID(),
        sessionId: input.sessionId,
        workItemId: input.workItemId,
        requirementRevision: input.requirementRevision,
        generation: input.generation,
        ...(input.parentDiscussionId ? { parentDiscussionId: input.parentDiscussionId } : {}),
        coordinatorAgentId: input.coordinatorAgentId,
        objective: input.objective,
        exitCondition: input.exitCondition,
        roundLimit: Math.max(1, Math.floor(input.roundLimit)),
        roundsStarted: 0,
        budgetTokens: Math.max(0, Math.floor(input.budgetTokens)),
        status: 'planning',
        delegations: [],
        revision: 1,
        createdAt: now,
        updatedAt: now
      };
      rows.push(run);
      return { status: 'opened', run: structuredClone(run) };
    });
  }

  reserveDelegation(discussionId: string, input: ReserveDelegationInput): Promise<ReserveDelegationOutcome> {
    const now = this.now();
    return this.mutateRun(discussionId, (run): ReserveDelegationOutcome => {
      // A delegation against an older requirement than the run's current one
      // is an answer to a question the user has since changed.
      if (input.requirementRevision !== run.requirementRevision) {
        return { status: 'rejected', code: 'DELEGATION_STALE_REVISION' };
      }
      const logicalKey = delegationLogicalKey({
        discussionId: run.id,
        targetAgentId: input.targetAgentId,
        requirementRevision: input.requirementRevision
      });
      const existing = run.delegations.find((item) => delegationLogicalKey(item) === logicalKey);
      if (existing) return { status: 'duplicate', delegation: structuredClone(existing) };

      const delegation: Delegation = {
        id: input.delegationId ?? crypto.randomUUID(),
        discussionId: run.id,
        sessionId: run.sessionId,
        workItemId: run.workItemId,
        requirementRevision: input.requirementRevision,
        generation: run.generation,
        targetAgentId: input.targetAgentId,
        origin: input.origin,
        objective: input.objective,
        expectedResult: input.expectedResult,
        ...(input.deadline ? { deadline: input.deadline } : {}),
        budgetTokens: Math.max(0, Math.floor(input.budgetTokens)),
        operationId: input.operationId ?? crypto.randomUUID(),
        status: 'pending',
        revision: 1,
        createdAt: now,
        updatedAt: now
      };
      run.delegations.push(delegation);
      run.revision += 1;
      run.updatedAt = now;
      return { status: 'reserved', delegation: structuredClone(delegation) };
    });
  }

  transitionDelegation(
    discussionId: string,
    delegationId: string,
    transition: DelegationTransition
  ): Promise<TransitionOutcome<Delegation>> {
    const now = this.now();
    return this.mutateRun(discussionId, (run): TransitionOutcome<Delegation> => {
      const delegation = run.delegations.find((item) => item.id === delegationId);
      if (!delegation) return { status: 'rejected', code: 'DELEGATION_NOT_FOUND' };
      if (delegation.status === transition.status) return { status: 'idempotent' };
      if (!canTransitionDelegation(delegation.status, transition.status)) {
        return { status: 'rejected', code: 'DELEGATION_INVALID_TRANSITION' };
      }
      if (transition.status === 'completed' && !isExpertReport(transition.result)) {
        return { status: 'rejected', code: 'EXPERT_REPORT_INVALID' };
      }

      delegation.status = transition.status as DelegationStatus;
      if (transition.status === 'running' && transition.invocationId) delegation.invocationId = transition.invocationId;
      if (transition.status === 'completed') delegation.result = structuredClone(transition.result);
      if (transition.status === 'failed') delegation.failure = { ...transition.failure };
      delegation.revision += 1;
      delegation.updatedAt = now;
      run.revision += 1;
      run.updatedAt = now;
      return { status: 'applied', run: structuredClone(run), delegation: structuredClone(delegation) };
    });
  }

  transitionRun(discussionId: string, transition: { status: DiscussionRunStatus }): Promise<TransitionOutcome<never>> {
    const now = this.now();
    return this.mutateRun(discussionId, (run): TransitionOutcome<never> => {
      if (run.status === transition.status) return { status: 'idempotent' };
      if (!canTransitionDiscussion(run.status, transition.status)) {
        return { status: 'rejected', code: 'DISCUSSION_INVALID_TRANSITION' };
      }
      // Entering consulting starts a bounded round. The limit is enforced here,
      // in the store, so no caller can loop past it by retrying. Coming back
      // from `paused` continues the interrupted round rather than opening one.
      if (transition.status === 'consulting' && run.status !== 'paused') {
        if (run.roundsStarted >= run.roundLimit) return { status: 'rejected', code: 'DISCUSSION_ROUND_LIMIT' };
        run.roundsStarted += 1;
      }
      run.status = transition.status;
      run.revision += 1;
      run.updatedAt = now;
      return { status: 'applied', run: structuredClone(run) };
    });
  }

  /**
   * Records the coordinator's synthesis and closes the round on its outcome:
   * `ready` → ready_for_confirmation, `needs_user` → waiting_user with the
   * confirmation the run now waits on. Only a run that actually consulted
   * (status synthesizing) has anything to synthesize.
   */
  recordSynthesis(
    discussionId: string,
    input: {
      summary: string;
      conflicts: string[];
      unresolved: string[];
      sourceDelegationIds: string[];
      outcome: 'ready' | 'needs_user';
      pendingConfirmationId?: string;
    }
  ): Promise<TransitionOutcome<never>> {
    const now = this.now();
    return this.mutateRun(discussionId, (run): TransitionOutcome<never> => {
      if (run.status !== 'synthesizing') return { status: 'rejected', code: 'DISCUSSION_INVALID_TRANSITION' };
      run.synthesis = {
        summary: input.summary,
        conflicts: [...input.conflicts],
        unresolved: [...input.unresolved],
        sourceDelegationIds: [...input.sourceDelegationIds],
        createdAt: now
      };
      if (input.outcome === 'needs_user') {
        run.status = 'waiting_user';
        if (input.pendingConfirmationId) run.pendingConfirmationId = input.pendingConfirmationId;
      } else {
        run.status = 'ready_for_confirmation';
        delete run.pendingConfirmationId;
      }
      run.revision += 1;
      run.updatedAt = now;
      return { status: 'applied', run: structuredClone(run) };
    });
  }

  /**
   * Applies a new requirement revision. Unfinished delegations on the old
   * revision are superseded and finished ones marked stale — the user changed
   * the question, so old answers must not be presented as current (AC7).
   */
  reviseRequirement(discussionId: string, input: { requirementRevision: number }): Promise<TransitionOutcome<never>> {
    const now = this.now();
    return this.mutateRun(discussionId, (run): TransitionOutcome<never> => {
      if (input.requirementRevision === run.requirementRevision) return { status: 'idempotent' };
      if (input.requirementRevision < run.requirementRevision) {
        return { status: 'rejected', code: 'DISCUSSION_STALE_VERSION' };
      }
      run.delegations = supersedeStaleDelegations(run.delegations, {
        currentRequirementRevision: input.requirementRevision,
        now
      });
      run.requirementRevision = input.requirementRevision;
      run.revision += 1;
      run.updatedAt = now;
      return { status: 'applied', run: structuredClone(run) };
    });
  }

  private checkAdmission(state: PersistedState, sessionId: string, generation: number): Rejected | undefined {
    const lifecycle = ((state[SESSION_LIFECYCLES_COLLECTION] ?? {}) as SessionLifecyclesBySession)[sessionId];
    if (!lifecycle) return undefined;
    if (lifecycle.state !== 'active' || lifecycle.admission !== 'open') {
      return { status: 'rejected', code: 'SESSION_ADMISSION_CLOSED' };
    }
    if (generation !== lifecycle.generation) return { status: 'rejected', code: 'DISCUSSION_STALE_GENERATION' };
    return undefined;
  }

  private mutateRun<T extends { status: string }>(
    discussionId: string,
    mutation: (run: DiscussionRun, state: PersistedState) => T
  ): Promise<T | Rejected> {
    // The session is found from the run, so callers address a discussion by id
    // alone; a run that does not exist anywhere is a not-found, not a crash.
    const sessionId = this.sessionIdOf(discussionId);
    if (!sessionId) return Promise.resolve({ status: 'rejected', code: 'DISCUSSION_NOT_FOUND' } as Rejected);
    return this.mutate(sessionId, (rows, state): T | Rejected => {
      const run = rows.find((item) => item.id === discussionId);
      if (!run) return { status: 'rejected', code: 'DISCUSSION_NOT_FOUND' };
      const admission = this.checkAdmission(state, sessionId, run.generation);
      if (admission) return admission;
      return mutation(run, state);
    });
  }

  private sessionIdOf(discussionId: string): string | undefined {
    const all = this.persistence.getCollection<DiscussionsBySession>(DISCUSSIONS_COLLECTION, this.cache);
    for (const [sessionId, runs] of Object.entries(all)) {
      if (runs.some((run) => run.id === discussionId)) return sessionId;
    }
    return undefined;
  }

  private mutate<T>(sessionId: string, mutation: (rows: DiscussionRun[], state: PersistedState) => T): Promise<T> {
    const run = async () => {
      let committed: DiscussionsBySession | undefined;
      const result = await this.persistence.mutateCollections(
        [DISCUSSIONS_COLLECTION, SESSION_LIFECYCLES_COLLECTION, 'sessions', 'workItemsBySession'],
        (draft: PersistedState) => {
          const all = (draft[DISCUSSIONS_COLLECTION] ??= {}) as DiscussionsBySession;
          const outcome = mutation(all[sessionId] ??= [], draft);
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
