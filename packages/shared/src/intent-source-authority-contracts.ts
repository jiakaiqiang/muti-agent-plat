import type { FileHash, RuntimeExecutionCandidate, WorkspaceRevision } from './contracts.js';
import type { IntentEffectGrant } from './intent-plan-contracts.js';
import type { IntentSourceCandidateBinding } from './intent-source-contracts.js';

export type IntentSourceProhibition = 'no_schema_change';
export type IntentSourceApplyClaim = {
  id: string; authorityId: string; sessionId: string; invocationId: string;
  candidateId: string; writebackId: string; attemptId: string; createdAt: string;
  outcome?: 'applied' | 'not_applied' | 'unknown'; finishedAt?: string;
  writerPid?: number; writerInstanceId?: string;
};

/** Immutable owner-confirmed scope. Revocation and apply claims are append-only state. */
export type IntentSourceAuthority = {
  id: string; sessionId: string; dataEpoch: string; sessionGeneration: number;
  workItemId: string; workspaceId: string; workspaceBindingHash: string;
  actorId: string; sourceEventId: string; confirmationId: string; confirmationEventId: string;
  revision: number; authorityHash: string; sourceResourceId: string;
  rootPath: string; rootIdentity: { realPath: string; dev: string; ino: string };
  files: Array<{ path: string; dev: string; ino: string }>;
  prohibitions: IntentSourceProhibition[]; grant: IntentEffectGrant; createdAt: string;
  revokedAt?: string; revokedBy?: string; applyClaims: IntentSourceApplyClaim[];
};

/** Baseline saved before the model sees it; IDs/hashes are never supplied by the model. */
export type IntentSourceCandidateRecord = {
  id: string; binding: IntentSourceCandidateBinding; createdAt: string;
  files: Array<{ path: string; content: string; hash: FileHash }>;
  baseRevision: WorkspaceRevision; snapshotHash: string;
  proposalHash?: string; candidate?: RuntimeExecutionCandidate;
};
