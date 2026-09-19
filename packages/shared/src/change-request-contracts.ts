import type { UserMessageIntent, UUID } from './contracts.js';

/**
 * Phase 5 contracts for an execution-time scope change.
 *
 * A ChangeRequest is the single durable truth for "the user asked for something
 * while a run was in flight". It is deliberately not a second queue: it binds to
 * the WorkItem/document/run versions that were live when the message arrived, so
 * an impact analysis can never be applied to a requirement it was not produced
 * against.
 */
export const CHANGE_REQUEST_CONTRACT_VERSION = 'change-request-v1' as const;

/** Every version a change decision depends on. */
export type ChangeRequestBase = {
  sessionId: UUID;
  workItemId: UUID;
  workItemRevision: number;
  /** The run that was executing when the message arrived; undefined before execution. */
  workflowRunId?: UUID;
  documentId?: UUID;
  documentRevision?: number;
};

/**
 * received → analyzing → waiting_user → (deferred | rejected | stopping) and,
 * once stopped, revising → waiting_confirmation → ready.
 *
 * `ready` and `rejected` are final. `deferred` is the one resolved state the
 * user can pick up after the current run ends, and it reopens only into
 * analysis — never straight to ready — because the versions it was analysed
 * against have almost certainly moved.
 */
/**
 * What the user may pick when the coordinator presents an impact analysis.
 * `pause_and_revise` stops the run and revises the requirement; `defer` keeps
 * the change for after the current run; `reject` drops it. Nothing else may
 * change a confirmed scope mid-flight.
 */
export type ChangeRequestChoice = 'pause_and_revise' | 'defer' | 'reject';

export type ChangeRequestStatus =
  | 'received'
  | 'analyzing'
  | 'waiting_user'
  | 'deferred'
  | 'rejected'
  | 'stopping'
  | 'revising'
  | 'waiting_confirmation'
  | 'ready';

const CHANGE_TRANSITIONS: Readonly<Record<ChangeRequestStatus, readonly ChangeRequestStatus[]>> = {
  received: ['analyzing', 'rejected'],
  analyzing: ['waiting_user', 'rejected'],
  waiting_user: ['stopping', 'deferred', 'rejected'],
  stopping: ['revising', 'rejected'],
  revising: ['waiting_confirmation', 'rejected'],
  waiting_confirmation: ['ready', 'revising', 'rejected'],
  deferred: ['analyzing', 'rejected'],
  ready: [],
  rejected: []
};

export function canTransitionChangeRequest(from: ChangeRequestStatus, to: ChangeRequestStatus): boolean {
  return CHANGE_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * One source message is one change request. The source event id makes a
 * resubmitted click idempotent; the requirement and document versions make the
 * same words against a revised requirement a genuinely different request.
 */
export function changeRequestLogicalKey(input: { base: ChangeRequestBase; sourceEventId: UUID }): string {
  const { base, sourceEventId } = input;
  return [
    CHANGE_REQUEST_CONTRACT_VERSION,
    base.sessionId,
    `event:${sourceEventId}`,
    `wi:${base.workItemId}`,
    `wir:${base.workItemRevision}`,
    `run:${base.workflowRunId ?? 'none'}`,
    `doc:${base.documentId ?? 'none'}`,
    `docr:${base.documentRevision ?? 0}`
  ].join('|');
}

/**
 * An impact analysis is a statement about a specific execution state. Execution
 * keeps moving while the analysis is produced, so before acting on it the server
 * re-checks that every version it was produced against still holds.
 */
export function isChangeAnalysisCurrent(
  analysis: { base: ChangeRequestBase; analysisRevision: number },
  current: ChangeRequestBase
): boolean {
  const recorded = analysis.base;
  return (
    recorded.sessionId === current.sessionId &&
    recorded.workItemId === current.workItemId &&
    recorded.workItemRevision === current.workItemRevision &&
    recorded.workflowRunId === current.workflowRunId &&
    recorded.documentId === current.documentId &&
    recorded.documentRevision === current.documentRevision
  );
}

export type ExecutionMessageSegment = {
  intent: UserMessageIntent;
  content: string;
  priority: 'low' | 'normal' | 'high';
};

const PRIORITY_RANK: Readonly<Record<ExecutionMessageSegment['priority'], number>> = {
  high: 0,
  normal: 1,
  low: 2
};

/**
 * Orders the segments of one execution-time message. A stop buried in the middle
 * of a long message must be handled before the rest, but nothing is discarded:
 * the remaining segments stay in their original order so a replay produces the
 * same plan, and each one is persisted as pending work.
 */
export function splitExecutionMessageSegments(
  segments: readonly ExecutionMessageSegment[]
): ExecutionMessageSegment[] {
  return [...segments]
    .map((segment, index) => ({ segment, index }))
    .sort((left, right) => {
      const byPriority = PRIORITY_RANK[left.segment.priority] - PRIORITY_RANK[right.segment.priority];
      return byPriority !== 0 ? byPriority : left.index - right.index;
    })
    .map((item) => item.segment);
}
