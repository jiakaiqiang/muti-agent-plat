import type { IntentUnderstandingOutput } from './runtime-contracts/intent-understanding.js';
import type { IntentSourceProhibition } from './intent-source-authority-contracts.js';
import type { ValidatedRoutePlan } from './intent-plan-contracts.js';

export type IntentSourceAuthorizationRequest = {
  id: string; routingId: string; sourceEventId: string; workItemId: string; actorId: string;
  dataEpoch: string; sessionGeneration: number; workspaceBindingHash: string;
  candidateRefs: string[]; prohibitions: IntentSourceProhibition[]; revision: number;
  candidateCatalog?: IntentSourceAuthorizationCandidate[];
  expectedAuthorityRevision: number; status: 'pending' | 'approved' | 'rejected';
  createdAt: string; idempotencyKey: string; payloadHash: string;
  decision?: { idempotencyKey: string; payloadHash: string; actorId: string; decidedAt: string };
};
export type IntentSourceAuthorizationCandidate = {
  ref: string; path: string; size: number; hash: string; dev: string; ino: string;
  rootIdentity: { realPath: string; dev: string; ino: string };
  expiresAt: string; suggested: boolean;
};
export type IntentFollowUp = {
  id: string; routingId: string; sourceEventId: string; workItemId: string; actorId: string;
  dataEpoch: string; sessionGeneration: number; sourceAuthorityId: string;
  understanding: IntentUnderstandingOutput; compiledUnderstanding: IntentUnderstandingOutput;
  baseline: { requirementRevision: number; executionEpoch: number; decisionSetHash: string; workspaceBindingHash: string;
    files: Array<{ path: string; hash: string }> };
  queuedPlan: ValidatedRoutePlan; status: 'queued' | 'brief' | 'ready' | 'running' | 'waiting_budget' | 'completed' | 'blocked' | 'cancelled' | 'reconciliation_required';
  revision: number; createdAt: string; updatedAt: string; failureCode?: string;
  briefStepId?: string; executionStepId?: string; taskId?: string; operationId?: string; invocationId?: string;
  dispatch?: { processId: string; claimedAt: string };
  cancelDecisions?: Array<{ actorId: string; idempotencyKey: string; expectedRevision: number; result: IntentFollowUp }>;
};
export type IntentSourceApplyResolution = {
  claimId: string; candidateId: string; action: 'redispatch' | 'confirm_completed' | 'abandon';
  actorId: string; idempotencyKey?: string; evidenceHash: string; files: Array<{ path: string; baseHash: string; targetHash: string; currentHash: string }>;
  createdAt: string;
};
