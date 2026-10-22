import type { AgentTask, IntentCorrection, IntentPlanStepRecord, IntentReconciliationCase, LogicalOperation, SessionDetail, WorkspaceWritebackRecord, Artifact } from '@agent-cluster/shared';
import type { PersistedState } from '../persistence/persistence.service.js';
import type { RuntimeInvocationLog } from '../runtimes/runtime.service.js';
import { reconciliationHash, reconciliationTasks, originalReconciliationBinding, reconciliationProcessId } from './intent-reconciliation-state.js';
import { isIntentRetryExecutionLocal } from './intent-retry-guard.js';
import { unresolvedSourceClaim } from './intent-source-authority.js';

export const sessionRows = <T>(state: PersistedState, key: string, sessionId: string): T[] =>
  (state[key] as Record<string, T[]> | undefined)?.[sessionId] ?? [];
export type ReconciliationSource = Pick<IntentReconciliationCase, 'source' | 'sourceId' | 'routingId' | 'binding'>;
export function reconciliationSources(state: PersistedState, session: SessionDetail): ReconciliationSource[] {
  const sources = new Map<string, ReconciliationSource>();
  const add = (row: ReconciliationSource) => { if (!sources.has(row.sourceId)) sources.set(row.sourceId, row); };
  const steps = sessionRows<IntentPlanStepRecord>(state, 'intentPlanStepsBySession', session.id);
  for (const step of steps.filter(row => row.dataEpoch === session.dataEpoch)) {
    for (const receipt of step.resumeReceipts ?? []) if (['failed', 'reconciliation_required'].includes(receipt.status) ||
      (receipt.status === 'running' && receipt.processId !== reconciliationProcessId)) {
      add({ source: 'resume', sourceId: `resume:${receipt.binding.pausedAt}`, routingId: receipt.binding.routingId, binding: receipt.binding });
    }
    for (const receipt of step.retryReceipts ?? []) if (receipt.status === 'reconciliation_required' ||
      (receipt.status === 'running' && receipt.processId !== reconciliationProcessId) || receipt.execution?.status === 'reconciliation_required' ||
      (receipt.execution?.status === 'running' && !isIntentRetryExecutionLocal(receipt.execution))) {
      add({ source: 'retry', sourceId: `retry:${receipt.binding.checkpointId}`, routingId: receipt.binding.routingId, binding: receipt.binding });
    }
    if (step.status === 'reconciliation_required') {
      if (step.resumeBinding) add({ source: 'resume', sourceId: `resume:${step.resumeBinding.pausedAt}`, routingId: step.resumeBinding.routingId, binding: step.resumeBinding });
      else if (step.retryBinding) add({ source: 'retry', sourceId: `retry:${step.retryBinding.checkpointId}`, routingId: step.retryBinding.routingId, binding: step.retryBinding });
      else add({ source: 'plan_step', sourceId: `step:${step.id}`, routingId: step.routingId });
    }
  }
  const retry = session.activeRecoveryCheckpoint?.retryBinding;
  if (retry && !['generic_llm', 'mock', 'code_reader'].includes(retry.failure.runtimeType)) {
    add({ source: 'runtime_safety', sourceId: `retry:${retry.checkpointId}`, routingId: retry.routingId, binding: retry });
  }
  for (const row of sessionRows<IntentCorrection>(state, 'intentCorrectionsBySession', session.id)) {
    if (row.dataEpoch === session.dataEpoch && row.status === 'reconciliation_required') add({ source: 'correction', sourceId: `correction:${row.id}`, routingId: row.routingId });
  }
  for (const operation of sessionRows<LogicalOperation>(state, 'logicalOperationsBySession', session.id)) {
    for (const attempt of operation.isolatedTestAttempts ?? []) if (attempt.phase === 'reconciliation_required') {
      if (operation.dataEpoch === session.dataEpoch && operation.executionBinding) add({ source: 'isolated_test', sourceId: `test:${operation.id}:${attempt.invocationId}`, routingId: operation.executionBinding.routingId });
    }
  }
  for (const authority of session.intentSourceAuthorities ?? []) for (const claim of authority.applyClaims) {
    if (unresolvedSourceClaim(session, claim)) add({ source: 'source_writeback', sourceId: `source-writeback:${claim.id}`, routingId: '', binding: undefined });
  }
  return [...sources.values()].map(row => ({ ...row, ...(row.binding ? { binding: originalReconciliationBinding(row.binding) } : {}) }));
}

export function reconciliationEvidence(state: PersistedState, session: SessionDetail, source: ReconciliationSource) {
  const targets = source.binding ? reconciliationTasks(source.binding) : [];
  const operations = sessionRows<LogicalOperation>(state, 'logicalOperationsBySession', session.id).filter(row =>
    targets.some(target => target.operationId === row.id) || (!targets.length && row.executionBinding?.routingId === source.routingId));
  const tasks = sessionRows<AgentTask>(state, 'tasksBySession', session.id).filter(row => targets.some(target => target.taskId === row.id));
  const calls = sessionRows<RuntimeInvocationLog>(state, 'runtimeInvocationsBySession', session.id).filter(row =>
    operations.some(operation => operation.invocationIds.includes(row.invocationId)) || targets.some(target => target.taskId === row.taskId));
  const writebacks = [...((state.workspaceWritebacks as WorkspaceWritebackRecord[] | undefined) ?? []), ...(session.workspaceWritebacks ?? [])]
    .filter(row => row.sessionId === session.id && (targets.some(target => target.taskId === row.taskId) || calls.some(call => call.invocationId === row.invocationId)));
  const artifacts = Object.values((state.artifacts as { artifactsById?: Record<string, Artifact> } | undefined)?.artifactsById ?? {})
    .filter(row => row.sessionId === session.id && (targets.some(target => target.taskId === row.taskId) || calls.some(call => call.invocationId === row.systemEvidence?.invocationId)));
  const steps = sessionRows<IntentPlanStepRecord>(state, 'intentPlanStepsBySession', session.id).filter(row => row.routingId === source.routingId);
  const corrections = sessionRows<IntentCorrection>(state, 'intentCorrectionsBySession', session.id).filter(row => `correction:${row.id}` === source.sourceId);
  const evidence = {
    source: { collection: source.source === 'correction' ? 'intentCorrectionsBySession' : source.source === 'isolated_test' ? 'logicalOperationsBySession' : 'intentPlanStepsBySession / activeRecoveryCheckpoint', id: source.sourceId },
    session: { status: session.status, revision: session.revision ?? 1, dataEpoch: session.dataEpoch,
      generation: (state.sessionLifecyclesBySession as any)?.[session.id]?.generation ?? '未知' },
    tasks: tasks.map(row => ({ id: row.id, status: row.status, stale: row.stale ?? false, updatedAt: row.updatedAt ?? '未知', checkpoint: row.executionCheckpoint ?? '未记录' })),
    operations: operations.map(row => ({ id: row.id, status: row.status, stopState: row.stopState, activeInvocationId: row.activeInvocationId ?? null,
      invocationIds: row.invocationIds, attemptsUsed: row.attemptsUsed, maxAttempts: row.maxAttempts, remainingActiveMs: row.remainingActiveMs,
      deadlineAt: row.deadlineAt, updatedAt: row.updatedAt, isolatedTestAttempts: row.isolatedTestAttempts ?? [] })),
    invocations: calls.map(row => ({ id: row.invocationId, status: row.status, runtimeType: row.runtimeType, errorCode: row.error?.code ?? null,
      candidate: row.executionCandidate ? '已记录' : '未记录', githubCandidate: row.githubCandidate ? '已记录' : '未记录',
      workspaceExecution: row.workspaceExecution ?? '未知', systemEvidence: row.systemEvidence ?? '未知', updatedAt: (row as any).completedAt ?? (row as any).startedAt ?? '未知' })),
    writebacks: writebacks.map(row => ({ id: row.id, status: row.status, updatedAt: row.updatedAt })),
    artifacts: artifacts.map(row => ({ id: row.id, type: row.type, status: row.metadata?.status ?? '未知', createdAt: row.createdAt })),
    steps: steps.map(row => ({ id: row.id, status: row.status, failureCode: row.failureCode, updatedAt: row.updatedAt,
      resumeReceipts: row.resumeReceipts, retryReceipts: row.retryReceipts, processing: row.processing && { invocationId: row.processing.invocationId, leaseExpiresAt: row.processing.leaseExpiresAt } })),
    corrections: corrections.map(row => ({ id: row.id, status: row.status, reasonCodes: row.reasonCodes, effectReconciliation: row.effectReconciliation, updatedAt: row.updatedAt })),
    unownedWorkspaceChanges: '未知', note: '仅服务端存储事实；未记录不代表未执行，历史工作区快照不证明当前归属。'
  };
  return { evidence, evidenceHash: reconciliationHash(evidence), operations, tasks, writebacks };
}
