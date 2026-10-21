import type { IntentAction, IntentEffectKind, IntentSegment } from './runtime-contracts/intent-understanding.js';
import type { SessionStatus } from './contracts.js';

export type IntentResource = IntentSegment['requestedEffects'][number]['target'];
export type IntentEffectGrant = {
  id: string;
  effect: IntentEffectKind;
  resource: IntentResource;
  revision: number;
  sourceEventId: string;
  revokedAt?: string;
};
export type IntentEffectScope = {
  effects: IntentSegment['requestedEffects'];
  prohibitions: IntentSegment['prohibitions'];
  grantIds: string[];
  scopeHash: string;
};
export type IntentExecutionBinding = {
  routingId: string;
  intentRevision: number;
  requirementRevision: number;
  executionEpoch: number;
  sessionGeneration: number;
  decisionSetHash: string;
  effectScopeHash: string;
};
export type ValidatedRouteStep = {
  stepId: string;
  segmentId: string;
  segmentKey: string;
  /** Brief preparation/review are derived by the server, never model intent actions. */
  action: IntentAction | 'prepare_brief' | 'review_brief';
  derivedFromStepId?: string;
  /** Server-bound immutable predecessor for a regenerated Brief. */
  replacesBrief?: { briefId: string; version: number };
  /** All review steps must complete before the Coordinator may generate a draft. */
  requiredBriefReviewStepIds?: string[];
  goal: string;
  target: IntentSegment['target'];
  contextPolicy: IntentSegment['contextPolicy'];
  correction: IntentSegment['correction'];
  dependencies: IntentSegment['dependencies'];
  evidence: IntentSegment['evidence'];
  expectedSessionStatus: SessionStatus;
  effectScope: IntentEffectScope;
  executionBinding: IntentExecutionBinding;
  idempotencyKey: string;
};
export type ValidatedRoutePlan = {
  planId: string;
  routingId: string;
  routingRevision: number;
  intentRevision: number;
  sourceEventId: string;
  snapshotId: string;
  businessFingerprint: string;
  policyVersion: 'intent-policy-v1';
  outcome: 'applicable' | 'needs_clarification' | 'rejected' | 'blocked';
  steps: ValidatedRouteStep[];
  validation: {
    schemaValid: boolean;
    referencesValid: boolean;
    relationActionValid: boolean;
    stateValid: boolean;
    authorizationValid: boolean;
    snapshotCurrent: boolean;
    errorCodes: string[];
    validationScore: number;
  };
};
