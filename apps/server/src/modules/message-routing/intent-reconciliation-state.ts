import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ConflictException } from '@nestjs/common';
import type { IntentReconciliationAttemptRef, IntentReconciliationCase, IntentResumeBinding, IntentRetryBinding, SessionDetail, RuntimeType } from '@agent-cluster/shared';
import type { PersistenceService, PersistedState } from '../persistence/persistence.service.js';

export const RECONCILIATIONS = 'intentReconciliationsBySession';
export const CLI_RISK_VERSION = 'intent-cli-workspace-responsibility-v1';
export const reconciliationProcessId = randomUUID();
export const reconciliationHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const reconciliationRows = (state: PersistedState, sessionId: string): IntentReconciliationCase[] =>
  (state[RECONCILIATIONS] as Record<string, IntentReconciliationCase[]> | undefined)?.[sessionId] ?? [];
export const reconciliationTasks = (binding: IntentResumeBinding | IntentRetryBinding) => 'task' in binding ? [binding.task] : binding.tasks;
export function originalReconciliationBinding<T extends IntentResumeBinding | IntentRetryBinding>(binding: T): T {
  const { reconciliationAttempt: _attempt, ...original } = binding;
  return original as T;
}
export function activeReconciliationAttempt(state: PersistedState, sessionId: string, ref: IntentReconciliationAttemptRef,
  binding?: IntentResumeBinding | IntentRetryBinding) {
  const row = reconciliationRows(state, sessionId).find(item => item.id === ref.caseId);
  const session = (state.sessions as SessionDetail[] | undefined)?.find(item => item.id === sessionId);
  const lifecycle = (state.sessionLifecyclesBySession as Record<string, { generation: number; state: string }> | undefined)?.[sessionId];
  const attempt = row?.attempts.at(-1);
  if (!row || !session || session.intentContractVersion !== 'intent-understanding-v1' || session.archivedAt ||
    session.dataEpoch !== row.dataEpoch || lifecycle?.generation !== row.sessionGeneration || lifecycle.state !== 'active' ||
    row.status !== 'dispatching' || attempt?.id !== ref.attemptId || attempt.processId !== reconciliationProcessId || !['claimed', 'running'].includes(attempt.status) ||
    (binding && !isDeepStrictEqual(originalReconciliationBinding(binding), row.binding))) {
    throw new ConflictException('INTENT_RECONCILIATION_ATTEMPT_STALE');
  }
  return { row, attempt };
}

/** Both ordinary dispatch and human decisions read this same persisted fence. */
export function assertReconciliationFence(state: PersistedState, input: { sessionId: string; taskId?: string;
  operationId?: string; invocationId?: string; reconciliationAttempt?: IntentReconciliationAttemptRef }) {
  const session = (state.sessions as SessionDetail[] | undefined)?.find(item => item.id === input.sessionId);
  if (session?.intentContractVersion !== 'intent-understanding-v1') return;
  const matches = reconciliationRows(state, input.sessionId).filter(row => row.dataEpoch === session.dataEpoch && row.binding &&
    !(row.status === 'resolved' && row.decisions.at(-1)?.action === 'redispatch' && input.reconciliationAttempt?.caseId !== row.id) &&
    reconciliationTasks(row.binding).some(target => target.taskId === input.taskId || target.operationId === input.operationId));
  for (const row of matches) {
    if (!input.reconciliationAttempt || input.reconciliationAttempt.caseId !== row.id) {
      throw new ConflictException('INTENT_RECONCILIATION_DECISION_REQUIRED');
    }
    const { attempt } = activeReconciliationAttempt(state, input.sessionId, input.reconciliationAttempt);
    if (input.invocationId && !attempt.invocationIds.includes(input.invocationId)) throw new ConflictException('INTENT_RECONCILIATION_INVOCATION_STALE');
  }
  if (input.reconciliationAttempt) activeReconciliationAttempt(state, input.sessionId, input.reconciliationAttempt);
}

/** Keep assertIntentRetryRuntimeSafe unchanged; this is the narrow, audited exception at its callers. */
export function hasReconciledCliConfirmation(state: PersistedState, binding: IntentRetryBinding, runtimeType: RuntimeType) {
  if (!binding.reconciliationAttempt) return false;
  const { row, attempt } = activeReconciliationAttempt(state, binding.sessionId, binding.reconciliationAttempt, binding);
  const proof = attempt.cliConfirmation;
  return ['codex', 'claude_code'].includes(runtimeType) && proof?.runtimeType === runtimeType &&
    proof.actorId === binding.actorId && proof.evidenceHash === row.evidenceHash &&
    proof.riskVersion === CLI_RISK_VERSION;
}

export async function claimReconciliationExecution(persistence: PersistenceService, sessionId: string, ref: IntentReconciliationAttemptRef) {
  return persistence.mutateCollections([RECONCILIATIONS, 'sessions', 'sessionLifecyclesBySession', 'logicalOperationsBySession'], draft => {
    const { attempt } = activeReconciliationAttempt(draft, sessionId, ref);
    if (attempt.status !== 'claimed') throw new ConflictException('INTENT_RECONCILIATION_ALREADY_CLAIMED');
    if (attempt.dispatchClaimedBy !== reconciliationProcessId) throw new ConflictException('INTENT_RECONCILIATION_DISPATCH_UNCLAIMED');
    attempt.status = 'running'; attempt.processId = reconciliationProcessId; attempt.claimId = randomUUID();
    return attempt.claimId;
  }, { sessionIds: [sessionId] });
}
export async function settleReconciliationExecution(persistence: PersistenceService, sessionId: string,
  ref: IntentReconciliationAttemptRef, claimId: string, unknown = false) {
  return persistence.mutateCollections([RECONCILIATIONS, 'sessions', 'sessionLifecyclesBySession', 'logicalOperationsBySession'], draft => {
    const { row, attempt } = activeReconciliationAttempt(draft, sessionId, ref);
    if (attempt.claimId !== claimId || attempt.processId !== reconciliationProcessId) throw new ConflictException('INTENT_RECONCILIATION_ATTEMPT_STALE');
    attempt.status = unknown ? 'reconciliation_required' : 'settled'; row.status = unknown ? 'open' : 'resolved';
    row.revision++; row.updatedAt = new Date().toISOString();
    for (const operation of ((draft.logicalOperationsBySession as Record<string, import('@agent-cluster/shared').LogicalOperation[]> | undefined)?.[sessionId] ?? [])) {
      if (operation.reconciliationAttempt?.caseId === ref.caseId && operation.reconciliationAttempt.attemptId === ref.attemptId) delete operation.reconciliationAttempt;
    }
  }, { sessionIds: [sessionId] });
}

export async function reserveReconciliationInvocation(persistence: PersistenceService, input: {
  sessionId: string; taskId?: string; phase?: string; invocationId: string; reconciliationAttempt?: IntentReconciliationAttemptRef }) {
  if (!input.reconciliationAttempt) return;
  await persistence.mutateCollections([RECONCILIATIONS, 'sessions', 'sessionLifecyclesBySession'], draft => {
    const { row, attempt } = activeReconciliationAttempt(draft, input.sessionId, input.reconciliationAttempt!);
    if (attempt.status !== 'running' || attempt.processId !== reconciliationProcessId || !input.taskId ||
      !row.binding || !reconciliationTasks(row.binding).some(target => target.taskId === input.taskId)) throw new ConflictException('INTENT_RECONCILIATION_ATTEMPT_STALE');
    const tasks = attempt.invocationTasks ??= {};
    const slot = JSON.stringify([input.taskId, input.phase ?? 'task_execution']);
    if (tasks[slot] && tasks[slot] !== input.invocationId) throw new ConflictException('INTENT_RECONCILIATION_ONCE_EXHAUSTED');
    tasks[slot] = input.invocationId;
    if (!attempt.invocationIds.includes(input.invocationId)) attempt.invocationIds.push(input.invocationId);
  }, { sessionIds: [input.sessionId] });
}

/** Pipeline outcomes may follow a settled call; a later human decision still wins. */
export function assertReconciliationOutcome(state: PersistedState, sessionId: string, taskIds: string[], ref?: IntentReconciliationAttemptRef) {
  const session = (state.sessions as SessionDetail[] | undefined)?.find(row => row.id === sessionId);
  if (session?.intentContractVersion !== 'intent-understanding-v1') return;
  for (const row of reconciliationRows(state, sessionId).filter(row => row.dataEpoch === session.dataEpoch && row.binding &&
    reconciliationTasks(row.binding).some(target => taskIds.includes(target.taskId)))) {
    const attempt = row.attempts.at(-1);
    if (ref?.caseId !== row.id || ref.attemptId !== attempt?.id || row.decisions.at(-1)?.action !== 'redispatch' ||
      !['running', 'settled'].includes(attempt.status)) throw new ConflictException('INTENT_RECONCILIATION_OUTCOME_STALE');
  }
}
