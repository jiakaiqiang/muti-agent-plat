import type { ChangeRequestStatus } from './change-request-contracts.js';

/**
 * The execution-time change queue as both clients must read it. Ordering,
 * staleness and "is this authorised" are business state, so they are decided
 * here once; Web and desktop only choose how to draw the rows.
 *
 * Browser-safe on purpose: no `node:` imports, no hashing, no clock.
 */
export type ChangeQueueItem = {
  id: string;
  /** The user's own wording. Model reasoning is never projected. */
  summary: string;
  status: ChangeRequestStatus;
  raisedAt: string;
  workItemRevision: number;
  documentRevision?: number;
};

export type ChangeQueueInput = {
  items: ChangeQueueItem[];
  currentWorkItemRevision: number;
  currentDocumentRevision?: number;
};

export type ChangeQueueStaleReason = 'work_item_revision_changed' | 'document_revision_changed';

export type ChangeQueueRow = ChangeQueueItem & {
  stale: boolean;
  staleReason?: ChangeQueueStaleReason;
  awaitingUser: boolean;
};

export type ChangeQueueView = {
  items: ChangeQueueRow[];
  awaitingUser: ChangeQueueRow[];
  deferred: ChangeQueueRow[];
  staleItems: ChangeQueueRow[];
  total: number;
  needsDecision: boolean;
  /**
   * A queued change is a request, never an execution authorisation (AC6). Both
   * ends read this flag so neither offers a "start now" shortcut that would skip
   * the document revision and the workflow selection.
   */
  grantsExecution: false;
  requiresReconfirmation: true;
};

/** Statuses that still belong to the queue; anything else is history. */
const QUEUED_STATUSES: readonly ChangeRequestStatus[] = [
  'received',
  'analyzing',
  'waiting_user',
  'deferred',
  'stopping',
  'revising',
  'waiting_confirmation'
];

function staleness(
  item: ChangeQueueItem,
  input: ChangeQueueInput
): { stale: boolean; staleReason?: ChangeQueueStaleReason } {
  if (item.workItemRevision !== input.currentWorkItemRevision) {
    return { stale: true, staleReason: 'work_item_revision_changed' };
  }
  if (
    item.documentRevision !== undefined &&
    input.currentDocumentRevision !== undefined &&
    item.documentRevision !== input.currentDocumentRevision
  ) {
    return { stale: true, staleReason: 'document_revision_changed' };
  }
  return { stale: false };
}

export function changeQueueView(input: ChangeQueueInput): ChangeQueueView {
  const rows = input.items
    .filter((item) => QUEUED_STATUSES.includes(item.status))
    // Raised order is the queue order. Ties fall back to the id so two clients
    // never disagree about which change is "next".
    .slice()
    .sort((left, right) => left.raisedAt.localeCompare(right.raisedAt) || left.id.localeCompare(right.id))
    .map<ChangeQueueRow>((item) => ({
      // Field by field on purpose: an unknown property on the source record
      // (model reasoning, transcripts) must not reach a client.
      id: item.id,
      summary: item.summary,
      status: item.status,
      raisedAt: item.raisedAt,
      workItemRevision: item.workItemRevision,
      ...(item.documentRevision !== undefined ? { documentRevision: item.documentRevision } : {}),
      ...staleness(item, input),
      awaitingUser: item.status === 'waiting_user'
    }));

  const awaitingUser = rows.filter((row) => row.awaitingUser);
  return {
    items: rows,
    awaitingUser,
    deferred: rows.filter((row) => row.status === 'deferred'),
    staleItems: rows.filter((row) => row.stale),
    total: rows.length,
    needsDecision: awaitingUser.length > 0,
    grantsExecution: false,
    requiresReconfirmation: true
  };
}
