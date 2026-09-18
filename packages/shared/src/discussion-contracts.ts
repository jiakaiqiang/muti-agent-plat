import type { ISODateTime, UUID } from './contracts.js';

/**
 * Phase 3 lifecycle records for a main-agent-hosted discussion. These are the
 * persisted plan that recovery trusts; the in-memory consultation loop is only
 * an executor of what is recorded here (plan §2.4).
 *
 * Execution scope and action ownership for discussions were frozen in phase 0
 * (`CollaborationExecutionScope.discussion`, `delegate_expert: 'coordinator'`).
 * This module adds the records those refer to; it does not redefine them.
 */
export const DISCUSSION_CONTRACT_VERSION = '1.0' as const;

/**
 * planning → consulting → synthesizing → waiting_user | ready_for_confirmation.
 * `paused` and `failed` are side exits that keep the run resumable; they are
 * deliberately not values of SessionStatus (plan §2.3).
 */
export type DiscussionRunStatus =
  | 'planning'
  | 'consulting'
  | 'synthesizing'
  | 'waiting_user'
  | 'ready_for_confirmation'
  | 'paused'
  | 'failed';

export type DelegationStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'superseded';

/** Who asked for this consultation. A user @ is a delegation, not a broadcast. */
export type DelegationOrigin = 'coordinator' | 'user_mention';

/**
 * What an expert hands back. Conclusions and their evidence — never a
 * transcript of how the expert got there (plan §2.6). The validator rejects
 * unknown fields so a private reasoning dump cannot be smuggled in.
 */
export type ExpertReport = {
  conclusion: string;
  evidenceRefs: string[];
  risks: string[];
  openQuestions: string[];
  suggestedActions: string[];
};

export type Delegation = {
  id: UUID;
  discussionId: UUID;
  sessionId: UUID;
  workItemId: UUID;
  /** The requirement revision this ask was made against. A newer revision supersedes it. */
  requirementRevision: number;
  /** Session lifecycle generation at creation; a recovered session does not revive older ones. */
  generation: number;
  targetAgentId: UUID;
  origin: DelegationOrigin;
  objective: string;
  expectedResult: string;
  deadline?: ISODateTime;
  budgetTokens: number;
  /** LogicalOperation id that deduplicates the side effects of running it. */
  operationId: UUID;
  invocationId?: UUID;
  status: DelegationStatus;
  result?: ExpertReport;
  failure?: { code: string; message: string; retryable: boolean };
  /**
   * Set when a newer requirement revision arrived after this delegation
   * finished. The result stays as history; synthesis must not read it as
   * current (AC7).
   */
  stale?: true;
  revision: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type DiscussionRun = {
  id: UUID;
  sessionId: UUID;
  workItemId: UUID;
  requirementRevision: number;
  generation: number;
  parentDiscussionId?: UUID;
  coordinatorAgentId: UUID;
  objective: string;
  exitCondition: string;
  roundLimit: number;
  roundsStarted: number;
  budgetTokens: number;
  status: DiscussionRunStatus;
  delegations: Delegation[];
  /** Populated by the coordinator's synthesis; absent until then. */
  synthesis?: {
    summary: string;
    conflicts: string[];
    unresolved: string[];
    /** Delegation ids the synthesis actually read, so "summarised" is checkable. */
    sourceDelegationIds: UUID[];
    createdAt: ISODateTime;
  };
  /** Confirmation/request id owned by the coordinator when waiting on the user (plan §2.7). */
  pendingConfirmationId?: UUID;
  revision: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

const DISCUSSION_TRANSITIONS: Readonly<Record<DiscussionRunStatus, readonly DiscussionRunStatus[]>> = {
  planning: ['consulting', 'paused', 'failed'],
  consulting: ['synthesizing', 'paused', 'failed'],
  synthesizing: ['waiting_user', 'ready_for_confirmation', 'consulting', 'paused', 'failed'],
  // A user answer reopens a bounded round; it never jumps straight to confirmation.
  waiting_user: ['consulting', 'paused', 'failed'],
  ready_for_confirmation: ['paused'],
  paused: ['planning', 'consulting', 'synthesizing', 'waiting_user', 'failed'],
  failed: ['planning', 'consulting']
};

export function canTransitionDiscussion(from: DiscussionRunStatus, to: DiscussionRunStatus): boolean {
  return DISCUSSION_TRANSITIONS[from].includes(to);
}

const DELEGATION_TRANSITIONS: Readonly<Record<DelegationStatus, readonly DelegationStatus[]>> = {
  pending: ['running', 'cancelled', 'superseded'],
  running: ['completed', 'blocked', 'failed', 'cancelled', 'superseded'],
  blocked: ['running', 'cancelled', 'superseded'],
  completed: [],
  failed: [],
  cancelled: [],
  superseded: []
};

export function canTransitionDelegation(from: DelegationStatus, to: DelegationStatus): boolean {
  return DELEGATION_TRANSITIONS[from].includes(to);
}

const KEY_DELIMITER = '|';

/**
 * Identity of one piece of consultation work. Two delegations with the same
 * key are the same ask, whichever call site or restart produced them, which is
 * what lets a reservation refuse the duplicate instead of running it twice.
 */
export function delegationLogicalKey(
  delegation: Pick<Delegation, 'discussionId' | 'targetAgentId' | 'requirementRevision'>
): string {
  return [
    delegation.discussionId.replaceAll(KEY_DELIMITER, '%7C'),
    delegation.targetAgentId.replaceAll(KEY_DELIMITER, '%7C'),
    String(delegation.requirementRevision)
  ].join(KEY_DELIMITER);
}

/**
 * What a restart or resume should actually dispatch. Finished work is not
 * repeated, terminal states stay terminal, `blocked` waits for its input, and
 * anything recorded under an older generation belongs to a session that was
 * since deleted or recovered.
 */
export function delegationsToRun(
  delegations: readonly Delegation[],
  scope: { generation: number }
): Delegation[] {
  return delegations.filter(
    (item) => item.generation === scope.generation && (item.status === 'pending' || item.status === 'running')
  );
}

/**
 * Applies a requirement revision to existing delegations. Unfinished work on
 * the old revision is superseded; finished work is kept but marked stale so
 * synthesis cannot present an answer to a question the user has since changed.
 */
export function supersedeStaleDelegations(
  delegations: readonly Delegation[],
  input: { currentRequirementRevision: number; now: ISODateTime }
): Delegation[] {
  return delegations.map((item) => {
    if (item.requirementRevision >= input.currentRequirementRevision) return item;
    if (item.status === 'completed') {
      return item.stale ? item : { ...item, stale: true, revision: item.revision + 1, updatedAt: input.now };
    }
    if (!canTransitionDelegation(item.status, 'superseded')) return item;
    return { ...item, status: 'superseded', revision: item.revision + 1, updatedAt: input.now };
  });
}

const EXPERT_REPORT_FIELDS = ['conclusion', 'evidenceRefs', 'risks', 'openQuestions', 'suggestedActions'] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isExpertReport(value: unknown): value is ExpertReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // Closed shape: an extra field is how a thinking transcript would ride along.
  if (Object.keys(record).some((key) => !(EXPERT_REPORT_FIELDS as readonly string[]).includes(key))) return false;
  return (
    typeof record.conclusion === 'string' &&
    record.conclusion.trim().length > 0 &&
    isStringArray(record.evidenceRefs) &&
    isStringArray(record.risks) &&
    isStringArray(record.openQuestions) &&
    isStringArray(record.suggestedActions)
  );
}
