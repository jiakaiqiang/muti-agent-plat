import type { IntentResumeBinding, IntentRetryBinding } from './intent-correction-contracts.js';
import type { RuntimeType } from './contracts.js';

export type IntentReconciliationAttemptRef = { caseId: string; attemptId: string };
export type IntentReconciliationAction = 'redispatch' | 'confirm_completed' | 'abandon';
export type DecideIntentReconciliationInput = {
  expectedCaseRevision: number; expectedSessionRevision: number; idempotencyKey: string;
  action: IntentReconciliationAction; acceptWorkspaceResponsibility?: true; riskVersion?: string;
};
export type IntentReconciliationCase = {
  id: string; sessionId: string; dataEpoch: string; sessionGeneration: number; routingId: string;
  source: 'resume' | 'retry' | 'runtime_safety' | 'plan_step' | 'correction' | 'isolated_test' | 'source_writeback';
  sourceId: string; binding?: IntentResumeBinding | IntentRetryBinding; revision: number;
  evidenceHash: string; status: 'open' | 'dispatching' | 'resolved'; createdAt: string; updatedAt: string;
  decisions: Array<{ actorId: string; idempotencyKey: string; payloadHash: string; action: IntentReconciliationAction;
    decidedAt: string; evidenceHash: string; expectedCaseRevision: number; resultRevision: number; attemptId?: string }>;
  attempts: Array<{ id: string; status: 'claimed' | 'running' | 'settled' | 'reconciliation_required';
    processId?: string; claimId?: string; dispatchClaimedBy?: string; invocationIds: string[]; invocationTasks?: Record<string, string>; createdAt: string;
    cliConfirmation?: { actorId: string; confirmedAt: string; evidenceHash: string; riskVersion: string; runtimeType: RuntimeType } }>;
};
export type IntentReconciliationView = {
  record: IntentReconciliationCase; sessionRevision: number; readOnly: boolean;
  evidence: Record<string, unknown>; actions: Array<{ action: IntentReconciliationAction; enabled: boolean; reason?: string }>;
  handler?: string;
};
