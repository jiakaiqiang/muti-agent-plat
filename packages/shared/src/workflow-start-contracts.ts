import type { ISODateTime, UUID } from './contracts.js';

/**
 * Bumping this invalidates every recorded start request. It is part of the
 * logical key itself, so a change in key shape can never let an old request
 * satisfy the idempotency check for a new one.
 */
export const WORKFLOW_START_CONTRACT_VERSION = 'workflow-start-v1' as const;

/**
 * Everything one start decision depends on.
 *
 * Before phase 4 the start key was `sessionId:confirmationId`. That key is
 * blind to the content the user actually approved: revise the requirement
 * document, keep the same confirmation, and the old run replays as if nothing
 * changed. Every version that can change the meaning of "start this workflow"
 * therefore belongs in the binding — and in the key derived from it.
 */
export type WorkflowStartBinding = {
  sessionId: UUID;
  workItemId: UUID;
  workItemRevision: number;
  confirmationId: UUID;
  documentId: UUID;
  documentRevision: number;
  /** Content hash of the approved document; same revision with other content is a different document. */
  contentHash: string;
  workflowId: UUID;
  workflowVersion: number;
  /** Published graph hash; a republish changes node order and rework edges. */
  definitionHash: string;
};

/** The live versions a recorded binding is checked against before dispatch. */
export type WorkflowStartCurrentVersions = {
  workItemRevision: number;
  documentRevision: number;
  contentHash: string;
  definitionHash: string;
};

export type WorkflowStartRequestStatus =
  | 'submitted'
  | 'dispatched'
  | 'started'
  | 'superseded'
  | 'rejected';

export type WorkflowStartRejectionCode =
  | 'WORKFLOW_START_STALE_DOCUMENT'
  | 'WORKFLOW_START_STALE_REQUIREMENT'
  | 'WORKFLOW_VERSION_CHANGED'
  | 'SESSION_ADMISSION_CLOSED';

/**
 * The durable record that separates submit from dispatch. A submit writes it
 * inside the business transaction; a worker claims it afterwards. Without the
 * record, a crash between "run created" and "worker started" is invisible.
 */
export type WorkflowStartRequest = {
  requestId: UUID;
  logicalKey: string;
  binding: WorkflowStartBinding;
  status: WorkflowStartRequestStatus;
  /** Session lifecycle generation at submit; a restored session cannot inherit it. */
  generation?: number;
  runId?: UUID;
  rejectionCode?: WorkflowStartRejectionCode;
  claimedBy?: string;
  claimedAt?: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

function segment(value: string | number): string {
  // A raw delimiter inside an id would let one binding forge another's key.
  return String(value).replaceAll('|', '%7C');
}

/**
 * The idempotency key for one start decision.
 *
 * Same decision submitted twice yields the same key, so a retried submit is a
 * no-op. Any version change yields a different key, so a stale approval cannot
 * ride an old request into execution.
 */
export function workflowStartLogicalKey(binding: WorkflowStartBinding): string {
  return [
    WORKFLOW_START_CONTRACT_VERSION,
    segment(binding.sessionId),
    segment(binding.workItemId),
    `wi:${segment(binding.workItemRevision)}`,
    segment(binding.confirmationId),
    segment(binding.documentId),
    `doc:${segment(binding.documentRevision)}`,
    `hash:${segment(binding.contentHash)}`,
    segment(binding.workflowId),
    `wf:${segment(binding.workflowVersion)}`,
    `graph:${segment(binding.definitionHash)}`
  ].join('|');
}

/**
 * Whether a recorded binding still describes the live state. Checked again just
 * before dispatch: selection and start are separated by user interaction, and a
 * republish or a document revision in that window must stop the start rather
 * than execute something the user never approved.
 */
export function isWorkflowStartBindingCurrent(
  binding: WorkflowStartBinding,
  current: WorkflowStartCurrentVersions
): boolean {
  return (
    binding.workItemRevision === current.workItemRevision &&
    binding.documentRevision === current.documentRevision &&
    binding.contentHash === current.contentHash &&
    binding.definitionHash === current.definitionHash
  );
}

/** Which refusal a stale binding maps to, so the user sees the real reason. */
export function workflowStartRejectionFor(
  binding: WorkflowStartBinding,
  current: WorkflowStartCurrentVersions
): WorkflowStartRejectionCode | undefined {
  if (binding.definitionHash !== current.definitionHash) return 'WORKFLOW_VERSION_CHANGED';
  if (binding.documentRevision !== current.documentRevision || binding.contentHash !== current.contentHash) {
    return 'WORKFLOW_START_STALE_DOCUMENT';
  }
  if (binding.workItemRevision !== current.workItemRevision) return 'WORKFLOW_START_STALE_REQUIREMENT';
  return undefined;
}
