import { ConflictException, Injectable } from '@nestjs/common';
import type { IntentPlanStepRecord, IntentResumeBinding, IntentRetryBinding, IntentRoutingRecord, SessionDetail } from '@agent-cluster/shared';
import { PersistenceService, type PersistedState } from '../persistence/persistence.service.js';
import { bindIntentResume, INTENT_RESUME_COLLECTIONS } from './intent-resume-guard.js';
import { assertNoPendingInputBudget } from './intent-resume-guard.js';
import { bindIntentRetry, INTENT_RETRY_COLLECTIONS, isIntentRetryExecutionLocal } from './intent-retry-guard.js';
import { activeReconciliationAttempt, reconciliationProcessId } from './intent-reconciliation-state.js';

const rows = <T>(state: PersistedState, key: string, sessionId: string): T[] =>
  (state[key] as Record<string, T[]> | undefined)?.[sessionId] ?? [];
const processId = reconciliationProcessId;

/** Delivery bookkeeping only. Both command and semantic resume still execute SessionsService.resume. */
@Injectable()
export class IntentResumeControlService {
  private readonly processId = processId;
  private readonly tails = new Map<string, Promise<unknown>>();
  private port?: (input: { sessionId: string; stepId: string }) => Promise<unknown>;
  constructor(private readonly persistence: PersistenceService) {}
  get available() { return Boolean(this.port); }
  bind(port: NonNullable<IntentResumeControlService['port']>) { this.port = port; }
  async dispatch(input: { sessionId: string; stepId: string }) {
    if (!this.port) throw new ConflictException('INTENT_ACTION_EXECUTOR_UNAVAILABLE');
    return this.port(input);
  }

  async retry<T>(sessionId: string, actorId: string, invoke: (binding: IntentRetryBinding) => Promise<T>, controlStepId?: string,
    reconciliationAttempt?: import('@agent-cluster/shared').IntentReconciliationAttemptRef): Promise<T | undefined> {
    if (reconciliationAttempt) return invoke(await this.claimReconciledBinding(sessionId, actorId, reconciliationAttempt, 'retry') as IntentRetryBinding);
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const claim = await this.persistence.mutateCollections(INTENT_RETRY_COLLECTIONS, draft => {
        const session = (draft.sessions as SessionDetail[]).find(row => row.id === sessionId);
        if (!session || session.ownerId !== actorId || session.archivedAt) throw new ConflictException('INTENT_RESUME_SESSION_UNAVAILABLE');
        assertNoPendingInputBudget(draft, session);
        const steps = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', sessionId);
        const control = controlStepId ? steps.find(row => row.id === controlStepId) : undefined;
        if (controlStepId) {
          const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(row => row.id === control?.routingId);
          if (!control?.retryBinding || !route || route.dispatchHold || route.effectiveIntentRevision !== control.intentRevision) {
            throw new ConflictException('INTENT_RETRY_CHECKPOINT_STALE');
          }
        }
        const saved = control?.retryBinding ?? session.activeRecoveryCheckpoint?.retryBinding;
        const existing = saved && steps.flatMap(row => row.retryReceipts ?? []).find(row =>
          row.binding.checkpointId === saved.checkpointId && row.binding.failure.invocationId === saved.failure.invocationId);
        if (existing) {
          if (existing.execution && (existing.execution.status === 'reconciliation_required' ||
            (existing.execution.status === 'running' && !isIntentRetryExecutionLocal(existing.execution)))) {
            existing.execution.status = 'reconciliation_required';
            if (control) control.status = 'reconciliation_required';
            return { error: 'INTENT_RETRY_RECONCILIATION_REQUIRED' };
          }
          if (existing.status === 'applied') {
            if (control) control.status = 'completed';
            return { replay: true as const };
          }
          if (existing.status === 'running' && existing.processId === this.processId) return { error: 'INTENT_RETRY_IN_PROGRESS' };
          existing.status = 'reconciliation_required';
          if (control) control.status = 'reconciliation_required';
          return { error: 'INTENT_RETRY_RECONCILIATION_REQUIRED' };
        }
        if (control && control.status !== 'queued') {
          control.status = 'reconciliation_required'; return { error: 'INTENT_RETRY_RECONCILIATION_REQUIRED' };
        }
        const binding = bindIntentRetry(draft, sessionId, actorId, saved);
        const original = steps.find(row => row.id === binding.task.stepId)!;
        (original.retryReceipts ??= []).push({ status: 'running', processId: this.processId,
          ...(controlStepId ? { controlStepId } : {}), binding });
        if (control) control.status = 'running';
        return { binding };
      }, { sessionIds: [sessionId] });
      if ('error' in claim) throw new ConflictException(claim.error);
      if ('replay' in claim) return undefined;
      const binding = claim.binding!;
      try {
        const result = await invoke(binding);
        await this.finishRetry(sessionId, binding, controlStepId);
        return result;
      } catch (error) {
        await this.finishRetry(sessionId, binding, controlStepId, error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    this.tails.set(sessionId, work);
    try { return await work; } finally { if (this.tails.get(sessionId) === work) this.tails.delete(sessionId); }
  }

  private finishRetry(sessionId: string, binding: IntentRetryBinding, stepId?: string, failureCode?: string) {
    return this.persistence.mutateCollections(['intentPlanStepsBySession', 'intentRoutingRecordsBySession'], draft => {
      const steps = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', sessionId);
      const receipt = steps.find(row => row.id === binding.task.stepId)?.retryReceipts?.find(row =>
        row.binding.checkpointId === binding.checkpointId && row.processId === this.processId && row.status === 'running');
      if (!receipt) throw new ConflictException('INTENT_RETRY_CHECKPOINT_STALE');
      receipt.status = failureCode ? 'reconciliation_required' : 'applied';
      if (failureCode) receipt.failureCode = failureCode;
      const control = steps.find(row => row.id === stepId);
      if (control) {
        control.status = failureCode ? 'reconciliation_required' : 'completed';
        control.updatedAt = new Date().toISOString();
        if (failureCode) control.failureCode = failureCode;
        const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(row => row.id === control.routingId);
        if (route) route.actionStatus = failureCode ? 'failed' : 'applied';
      }
    }, { sessionIds: [sessionId] });
  }

  async resume<T>(sessionId: string, actorId: string, invoke: (binding: IntentResumeBinding) => Promise<T>, controlStepId?: string,
    reconciliationAttempt?: import('@agent-cluster/shared').IntentReconciliationAttemptRef): Promise<T | undefined> {
    if (reconciliationAttempt) return invoke(await this.claimReconciledBinding(sessionId, actorId, reconciliationAttempt, 'resume') as IntentResumeBinding);
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const claim = await this.persistence.mutateCollections(INTENT_RESUME_COLLECTIONS, draft => {
        const steps = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', sessionId);
        const control = controlStepId ? steps.find(row => row.id === controlStepId) : undefined;
        if (controlStepId) {
          const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(row => row.id === control?.routingId);
          if (!control?.resumeBinding || !route || route.dispatchHold || route.effectiveIntentRevision !== control.intentRevision) {
            throw new ConflictException('INTENT_RESUME_VERSION_STALE');
          }
          if (control.status === 'completed') return { replay: true as const };
          if (control.status !== 'queued') {
            control.status = 'reconciliation_required'; control.failureCode = 'INTENT_RESUME_RECONCILIATION_REQUIRED';
            for (const original of steps) for (const receipt of original.resumeReceipts ?? []) {
              if (receipt.controlStepId === controlStepId && receipt.status === 'running') receipt.status = 'reconciliation_required';
            }
            return { error: 'INTENT_RESUME_RECONCILIATION_REQUIRED' };
          }
        }
        const binding = bindIntentResume(draft, sessionId, actorId, control?.resumeBinding);
        const original = steps.find(row => row.id === binding.tasks[0].stepId)!;
        const existing = original.resumeReceipts?.find(row => row.binding.pausedAt === binding.pausedAt && row.binding.sessionId === sessionId &&
          row.binding.dataEpoch === binding.dataEpoch && row.binding.sessionGeneration === binding.sessionGeneration);
        if (existing) {
          if (existing.status === 'applied') return { replay: true as const };
          if (existing.status === 'running' && existing.processId === this.processId) return { error: 'INTENT_RESUME_IN_PROGRESS' };
          existing.status = 'reconciliation_required';
          if (control) control.status = 'reconciliation_required';
          return { error: 'INTENT_RESUME_RECONCILIATION_REQUIRED' };
        }
        (original.resumeReceipts ??= []).push({ pauseRevision: binding.pauseRevision, status: 'running', processId: this.processId,
          ...(controlStepId ? { controlStepId } : {}), binding });
        if (control) control.status = 'running';
        return { binding };
      }, { sessionIds: [sessionId] });
      if ('error' in claim) throw new ConflictException(claim.error);
      if ('replay' in claim) return undefined;
      const binding = claim.binding!;
      try {
        const result = await invoke(binding);
        await this.finish(sessionId, binding, controlStepId, undefined);
        return result;
      } catch (error) {
        await this.finish(sessionId, binding, controlStepId, error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    this.tails.set(sessionId, work);
    try { return await work; } finally { if (this.tails.get(sessionId) === work) this.tails.delete(sessionId); }
  }

  private claimReconciledBinding(sessionId: string, actorId: string, ref: import('@agent-cluster/shared').IntentReconciliationAttemptRef, kind: 'resume' | 'retry') {
    return this.persistence.mutateCollections(INTENT_RETRY_COLLECTIONS, draft => {
      const { row, attempt } = activeReconciliationAttempt(draft, sessionId, ref);
      if (!row.binding || ('task' in row.binding) !== (kind === 'retry') || attempt.dispatchClaimedBy) throw new ConflictException('INTENT_RECONCILIATION_ALREADY_DISPATCHED');
      const binding = { ...row.binding, reconciliationAttempt: ref };
      const checked = 'task' in binding ? bindIntentRetry(draft, sessionId, actorId, binding, true) : bindIntentResume(draft, sessionId, actorId, binding, true);
      attempt.dispatchClaimedBy = this.processId;
      return checked;
    }, { sessionIds: [sessionId] });
  }

  private finish(sessionId: string, binding: IntentResumeBinding, stepId?: string, failureCode?: string) {
    return this.persistence.mutateCollections(['intentPlanStepsBySession', 'intentRoutingRecordsBySession'], draft => {
      const steps = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', sessionId);
      const receipt = steps.find(row => row.id === binding.tasks[0].stepId)?.resumeReceipts?.find(row =>
        row.pauseRevision === binding.pauseRevision && row.processId === this.processId && row.status === 'running');
      if (!receipt) throw new ConflictException('INTENT_RESUME_RECEIPT_STALE');
      receipt.status = failureCode ? 'reconciliation_required' : 'applied';
      if (failureCode) receipt.failureCode = failureCode;
      const control = steps.find(row => row.id === stepId);
      if (control) {
        control.status = failureCode ? 'reconciliation_required' : 'completed';
        control.updatedAt = new Date().toISOString();
        if (failureCode) control.failureCode = failureCode;
        const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', sessionId).find(row => row.id === control.routingId);
        if (route) route.actionStatus = failureCode ? 'failed' : 'applied';
      }
    }, { sessionIds: [sessionId] });
  }
}
