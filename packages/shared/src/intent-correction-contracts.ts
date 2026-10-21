import type { IntentClarificationResolution, IntentRoutingDecisionV2 } from './contracts.js';
import type { IntentUnderstandingOutput } from './runtime-contracts/intent-understanding.js';
import type { ValidatedRoutePlan, ValidatedRouteStep } from './intent-plan-contracts.js';

export type IntentDispatchHold = {
  correctionId: string;
  reason: 'intent_correction';
  createdAt: string;
};

export type CorrectIntentRoutingInput = {
  contractVersion: 'intent-correction-v1';
  expectedRoutingRevision: number;
  idempotencyKey: string;
  instruction: string;
  targetWorkItemId: string | null;
  supersedesDecisionId: string | null;
  expectedDecisionRevision: number | null;
};

export type IntentCorrectionStatus = 'accepted' | 'waiting_for_stop' | 'validating' |
  'clarification_required' | 'applied' | 'reconciliation_required' | 'rejected';

export type IntentCorrection = {
  /** Server-produced evidence. Retained reports and discarded scratch are distinct; neither means external rollback. */
  effectReconciliation?: { policyVersion: 'isolated-test-reconciliation-v1' | 'isolated-test-reconciliation-v2'; confirmedAt: string;
    executions: Array<{ invocationId: string; operationId: string; bindingHash: string; snapshotHash?: string;
      disposition: 'isolated_scratch_discarded' | 'published_report_retained'; resultKnown: boolean;
      artifactId?: string; artifactContentHash?: string }> };
  /** Existing chat input consumed atomically; API corrections create their own input event. */
  originRoutingId?: string;
  originFollowUpId?: string;
  sessionGeneration?: number;
  processing?: {
    ownerId: string;
    leaseExpiresAt: string;
    deadlineAt: string;
    attemptsUsed: number;
    repairsUsed: number;
    snapshotRebuildsUsed: number;
    snapshotId?: string;
    repairFeedback?: { previousOutput: string; validationErrors: string[] };
    invocationIds: string[];
  };
  failureClass?: 'transient' | 'auth' | 'config' | 'schema' | 'unknown_effect' | 'budget';
  validationErrors?: string[];
  supersededByCorrectionId?: string;
  id: string;
  sessionId: string;
  dataEpoch: string;
  routingId: string;
  actorId: string;
  idempotencyKey: string;
  payloadHash: string;
  request: CorrectIntentRoutingInput;
  sourceEventId: string;
  previousIntentRevision: number;
  pendingIntentRevision: number;
  routingRevision: number;
  status: IntentCorrectionStatus;
  affectedWorkItemIds: string[];
  affectedExecutionIds: string[];
  reasonCodes: string[];
  createdAt: string;
  updatedAt: string;
};

/** Immutable after insertion. Legacy records retain unknown authorization. */
export type IntentRouteRevision = {
  authorityGrants?: import('./intent-plan-contracts.js').IntentEffectGrant[];
  id: string;
  sessionId: string;
  dataEpoch: string;
  routingId: string;
  intentRevision: number;
  previousRevision: number | null;
  sourceEventId: string;
  authorizationState: 'unknown' | 'validated';
  understanding: IntentUnderstandingOutput | null;
  validatedPlan: ValidatedRoutePlan | null;
  legacyDecision?: IntentRoutingDecisionV2;
  policyVersion: string;
  createdAt: string;
};

export type IntentResolutionReceipt = {
  id: string;
  sessionId: string;
  dataEpoch: string;
  routingId: string;
  resolution: IntentClarificationResolution;
  createdAt: string;
};

export type IntentPlanStepRecord = {
  retryBinding?: IntentRetryBinding;
  retryReceipts?: Array<{ status: 'running' | 'applied' | 'reconciliation_required'; processId: string;
    controlStepId?: string; binding: IntentRetryBinding; failureCode?: string;
    execution?: { processId: string; claimId: string; status: 'running' | 'settled' | 'reconciliation_required' } }>;
  /** Server-bound original execution authority; an empty resume message grants nothing. */
  resumeBinding?: IntentResumeBinding;
  /** Claim before calling the shared Session resume port. Unknown delivery is never replayed. */
  resumeReceipts?: Array<{ pauseRevision: number; status: 'running' | 'applied' | 'failed' | 'reconciliation_required';
    processId: string; controlStepId?: string; binding: IntentResumeBinding; failureCode?: string }>;
  briefOperationId?: string;
  briefRetryReceipts?: Array<{ id: string; actorId: string; request: import('./intent-brief-retry.js').RetryIntentBriefInput;
    operationId: string; previousOperationId: string; acceptedRoutingRevision: number; createdAt: string;
    previous: { failureCode?: string; failureDetail?: string; processing?: IntentPlanStepRecord['processing'] } }>;
  /** Server-bound report lineage, immutable with this step; old reports remain untouched. */
  supersedesArtifactIds?: string[];
  processing?: { ownerId: string; leaseExpiresAt: string; deadlineAt: string; attemptsUsed: number;
    invocationId?: string; repairFeedback?: { previousOutput: string; validationErrors: string[] };
    retryAt?: string; result?: { content: string; agentId: string; invocationId: string };
    briefResult?: { output: import('./contracts.js').TaskBriefOutput; agentId: string; invocationId: string } };
  failureCode?: string;
  failureDetail?: string;
  responseEventId?: string;
  resultArtifactId?: string;
  resultBriefId?: string;
  id: string;
  sessionId: string;
  dataEpoch: string;
  routingId: string;
  intentRevision: number;
  localKey: string;
  step: ValidatedRouteStep;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'invalidated' | 'reconciliation_required';
  reusedEffectIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type IntentResumeBinding = {
  sessionId: string;
  dataEpoch: string;
  sessionGeneration: number;
  pauseRevision: number;
  pausedAt: string;
  workItemId: string;
  briefId: string;
  briefVersion: number;
  confirmationReceiptId: string;
  routingId: string;
  intentRevision: number;
  workflow?: { id: string; nodeRunId: string; definitionHash: string };
  tasks: Array<{ taskId: string; operationId: string; stepId: string;
    executionBinding: import('./intent-plan-contracts.js').IntentExecutionBinding }>;
};

/** Server-captured failure identity. A retry never grants a new effect scope. */
export type IntentRetryBinding = Omit<IntentResumeBinding, 'pauseRevision' | 'pausedAt' | 'tasks' | 'workflow'> & {
  actorId: string;
  checkpointId: string;
  task: IntentResumeBinding['tasks'][number];
  failure: { invocationId: string; phase: 'task_execution'; runtimeType: import('./contracts.js').RuntimeType; attempt: number };
  workflow?: NonNullable<IntentResumeBinding['workflow']> & { revision: number; attempt: number };
};
