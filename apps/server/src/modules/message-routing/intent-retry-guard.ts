import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentTask, Artifact, IntentPlanStepRecord, IntentRetryBinding, LogicalOperation, RuntimeType, SessionDetail,
  WorkflowNodeRun, WorkflowRun, WorkspaceWritebackRecord } from '@agent-cluster/shared';
import type { PersistenceService, PersistedState } from '../persistence/persistence.service.js';
import type { RuntimeInvocationLog } from '../runtimes/runtime.service.js';
import { assertNoPendingInputBudget, bindIntentRecoveryAuthority, INTENT_RESUME_COLLECTIONS } from './intent-resume-guard.js';

export const INTENT_RETRY_COLLECTIONS = [...INTENT_RESUME_COLLECTIONS, 'runtimeInvocationsBySession', 'workspaceWritebacks', 'artifacts'];
const rows = <T>(state: PersistedState, key: string, sessionId: string): T[] =>
  (state[key] as Record<string, T[]> | undefined)?.[sessionId] ?? [];
const fail = (code: string): never => { throw new ConflictException(code); };
const unique = <T>(items: T[]): T | undefined => {
  if (items.length > 1) fail('INTENT_RETRY_CHECKPOINT_AMBIGUOUS');
  return items[0];
};
const executionProcessId = randomUUID();
export const isIntentRetryExecutionLocal = (execution: { processId: string }) => execution.processId === executionProcessId;

/** Dispatch acceptance is not execution ownership. Fence duplicate/stalled queue deliveries before a Runtime call. */
export async function claimIntentRetryExecution(persistence: PersistenceService, binding: IntentRetryBinding) {
  const claim = await persistence.mutateCollections(INTENT_RETRY_COLLECTIONS, draft => {
    const receipt = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', binding.sessionId)
      .find(row => row.id === binding.task.stepId)?.retryReceipts?.find(row => row.binding.checkpointId === binding.checkpointId);
    if (!receipt || !isDeepStrictEqual(receipt.binding, binding) || receipt.status === 'reconciliation_required') {
      return { error: 'INTENT_RETRY_RECONCILIATION_REQUIRED' };
    }
    if (receipt.execution) {
      if (receipt.execution.status === 'settled') return { error: 'INTENT_RETRY_ALREADY_EXECUTED' };
      if (receipt.execution.status === 'running' && receipt.execution.processId === executionProcessId) return { error: 'INTENT_RETRY_IN_PROGRESS' };
      receipt.execution.status = 'reconciliation_required';
      return { error: 'INTENT_RETRY_RECONCILIATION_REQUIRED' };
    }
    bindIntentRetry(draft, binding.sessionId, binding.actorId, binding, true);
    receipt.execution = { processId: executionProcessId, claimId: randomUUID(), status: 'running' };
    return { claimId: receipt.execution.claimId };
  }, { sessionIds: [binding.sessionId] });
  if (claim.error) fail(claim.error);
  return claim.claimId!;
}

export async function settleIntentRetryExecution(persistence: PersistenceService, binding: IntentRetryBinding, claimId: string, unknown = false) {
  await persistence.mutateCollections(['intentPlanStepsBySession'], draft => {
    const execution = rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', binding.sessionId)
      .find(row => row.id === binding.task.stepId)?.retryReceipts?.find(row => row.binding.checkpointId === binding.checkpointId)?.execution;
    if (!execution || execution.claimId !== claimId || execution.processId !== executionProcessId || execution.status !== 'running') {
      fail('INTENT_RETRY_RECONCILIATION_REQUIRED');
    }
    execution!.status = unknown ? 'reconciliation_required' : 'settled';
  }, { sessionIds: [binding.sessionId] });
}
export const readIntentRetryState = (persistence: PersistenceService): PersistedState =>
  Object.fromEntries(INTENT_RETRY_COLLECTIONS.map(key => [key, persistence.getCollection(key,
    ['sessions', 'workspaceWritebacks'].includes(key) ? [] : {})]));

/** Only adapters whose task execution is demonstrably read-only may rerun. */
export function assertIntentRetryRuntimeSafe(runtimeType: RuntimeType) {
  if (!['generic_llm', 'mock', 'code_reader'].includes(runtimeType)) fail('INTENT_RETRY_RECONCILIATION_REQUIRED');
}

function failedCall(state: PersistedState, sessionId: string, taskId: string, invocationId: string) {
  const task = unique(rows<AgentTask>(state, 'tasksBySession', sessionId).filter(row => row.id === taskId));
  const operation = unique(rows<LogicalOperation>(state, 'logicalOperationsBySession', sessionId).filter(row => row.id === task?.executionOperationId));
  const call = unique(rows<RuntimeInvocationLog>(state, 'runtimeInvocationsBySession', sessionId).filter(row => row.invocationId === invocationId));
  if (!task || !operation || !call || call.taskId !== task.id || call.sessionId !== sessionId || call.workItemId !== task.workItemId ||
    call.phase !== 'task_execution' || !['failed', 'interrupted', 'cancelled', 'timed_out'].includes(call.status) ||
    call.operation?.id !== operation.id || operation.invocationIds.at(-1) !== call.invocationId ||
    !isDeepStrictEqual(call.executionBinding, operation.executionBinding)) fail('INTENT_RETRY_CHECKPOINT_STALE');
  return { task: task!, operation: operation!, call: call! };
}

/** Called with the exact failed task/call at failure time. Never finds a "latest" task. */
export function captureIntentRetryBinding(state: PersistedState, sessionId: string, actorId: string,
  checkpointId: string, taskId: string, invocationId: string): IntentRetryBinding | undefined {
  try {
    const authority = bindIntentRecoveryAuthority(state, sessionId, actorId, taskId);
    const { task, operation, call } = failedCall(state, sessionId, taskId, invocationId);
    if (task.status !== 'failed' || call.dataEpoch !== authority.dataEpoch || call.contextGeneration !== authority.sessionGeneration) return undefined;
    const { tasks, workflow, ...base } = authority;
    const runtime = state.workflowRuntime as { runs?: WorkflowRun[]; nodeRunsByRunId?: Record<string, WorkflowNodeRun[]> } | undefined;
    const run = workflow && unique((runtime?.runs ?? []).filter(row => row.id === workflow.id));
    const node = workflow && unique((runtime?.nodeRunsByRunId?.[workflow.id] ?? []).filter(row => row.id === workflow.nodeRunId));
    return { ...base, actorId, checkpointId, task: tasks[0],
      failure: { invocationId, phase: 'task_execution', runtimeType: call.runtimeType, attempt: operation.invocationIds.length },
      ...(workflow && run && node ? { workflow: { ...workflow, revision: run.revision, attempt: node.attempt } } : {}) };
  } catch { return undefined; } // Missing proof leaves the ordinary recovery card, never invented authority.
}

export function bindIntentRetry(state: PersistedState, sessionId: string, actorId: string,
  expected?: IntentRetryBinding, dispatch = false): IntentRetryBinding {
  const session = unique((state.sessions as SessionDetail[] | undefined ?? []).filter(row => row.id === sessionId));
  if (!session || session.ownerId !== actorId || session.archivedAt || session.intentContractVersion !== 'intent-understanding-v1') {
    return fail('INTENT_RESUME_SESSION_UNAVAILABLE');
  }
  assertNoPendingInputBudget(state, session);
  const checkpoint = session.activeRecoveryCheckpoint;
  const saved = expected ?? checkpoint?.retryBinding;
  if (!saved) return fail('RETRY_CHECKPOINT_REQUIRED');
  if (saved.actorId !== actorId || saved.sessionId !== sessionId || !saved.checkpointId) fail('INTENT_RETRY_CHECKPOINT_STALE');
  if (!dispatch && (!checkpoint || checkpoint.confirmationId !== saved.checkpointId || !isDeepStrictEqual(checkpoint.retryBinding, saved))) {
    fail('INTENT_RETRY_CHECKPOINT_STALE');
  }
  if (dispatch) {
    const receipt = unique(rows<IntentPlanStepRecord>(state, 'intentPlanStepsBySession', sessionId).flatMap(row => row.retryReceipts ?? [])
      .filter(row => row.binding.checkpointId === saved.checkpointId));
    if (!receipt || receipt.execution?.status === 'reconciliation_required' || !['running', 'applied'].includes(receipt.status) || !isDeepStrictEqual(receipt.binding, saved) ||
      (checkpoint && checkpoint.confirmationId !== saved.checkpointId)) fail('INTENT_RETRY_RECONCILIATION_REQUIRED');
  }
  if (!(dispatch ? ['FAILED', 'INTERRUPTED', 'EXECUTING'] : ['FAILED', 'INTERRUPTED']).includes(session.status)) fail('INTENT_RETRY_STATE_INVALID');
  const { task, operation, call } = failedCall(state, sessionId, saved.task.taskId, saved.failure.invocationId);
  if (call.error?.code === 'INPUT_BUDGET_EXCEEDED') fail('INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED');
  if (!(dispatch ? ['failed', 'pending', 'assigned'] : ['failed']).includes(task.status) || task.stale) fail('INTENT_RETRY_TARGET_OBSOLETE');
  if (operation.invocationIds.length !== saved.failure.attempt || call.runtimeType !== saved.failure.runtimeType ||
    call.dataEpoch !== session.dataEpoch || call.contextGeneration !== saved.sessionGeneration) fail('INTENT_RETRY_CHECKPOINT_STALE');
  if (!['ready', 'paused'].includes(operation.status)) fail('INTENT_RETRY_RECONCILIATION_REQUIRED');
  if ((operation.attemptsUsed !== undefined && operation.attemptsUsed >= operation.maxAttempts) ||
    (operation.remainingActiveMs !== undefined && operation.remainingActiveMs <= 0) ||
    (operation.deadlineCeilingAt && Date.parse(operation.deadlineCeilingAt) <= Date.now()) ||
    (operation.status === 'ready' && operation.deadlineAt && Date.parse(operation.deadlineAt) <= Date.now())) {
    fail('INTENT_RETRY_OPERATION_BUDGET_EXHAUSTED');
  }
  const authority = bindIntentRecoveryAuthority(state, sessionId, actorId, task.id, dispatch);
  const { tasks, workflow, ...base } = authority;
  if (saved.workflow) {
    const runtime = state.workflowRuntime as { runs?: WorkflowRun[]; nodeRunsByRunId?: Record<string, WorkflowNodeRun[]> };
    const run = unique((runtime.runs ?? []).filter(row => row.id === saved.workflow!.id));
    const node = unique((runtime.nodeRunsByRunId?.[saved.workflow.id] ?? []).filter(row => row.id === saved.workflow!.nodeRunId));
    if (!run || !node || node.attempt !== saved.workflow.attempt ||
      run.revision !== saved.workflow.revision + (dispatch && run.status === 'running' ? 1 : 0)) fail('INTENT_RETRY_CHECKPOINT_STALE');
  }
  const current = { ...base, actorId, checkpointId: saved.checkpointId, task: tasks[0], failure: saved.failure,
    ...(workflow ? { workflow: { ...workflow, revision: saved.workflow?.revision, attempt: saved.workflow?.attempt } } : {}) };
  if (!isDeepStrictEqual(current, saved)) fail('INTENT_RETRY_CHECKPOINT_STALE');
  const writebacks = [...((state.workspaceWritebacks as WorkspaceWritebackRecord[] | undefined) ?? []), ...(session.workspaceWritebacks ?? [])]
    .filter(row => row.sessionId === sessionId && (row.taskId === task.id || row.invocationId === call.invocationId));
  const submissions = Object.values((state.artifacts as { artifactsById?: Record<string, Artifact> } | undefined)?.artifactsById ?? {})
    .filter(row => row.sessionId === sessionId && row.metadata?.phase === 'task_execution' &&
      (row.systemEvidence?.invocationId === call.invocationId || row.taskId === task.id));
  if (task.executionCheckpoint || call.executionCandidate || call.githubCandidate || call.workspaceExecution || writebacks.length ||
    call.systemEvidence?.workspaceChangeSet || submissions.length) {
    throw new ConflictException({ code: 'INTENT_RETRY_STEP_UNSUPPORTED', message: 'INTENT_RETRY_STEP_UNSUPPORTED',
      details: { writebackIds: [...new Set(writebacks.map(row => row.id))], artifactIds: submissions.map(row => row.id),
        resolution: { method: 'POST', path: `/sessions/${sessionId}/workspace-writebacks/:writebackId/resolve`,
          note: '使用现有写回/冲突处理入口；没有写回记录时不支持自动阶段接续。' } } });
  }
  assertIntentRetryRuntimeSafe(call.runtimeType);
  return structuredClone(saved);
}
