import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ConflictException } from '@nestjs/common';
import type { AgentTask, CollaborationEvent, IntentPlanStepRecord, IntentResumeBinding, IntentRouteRevision,
  IntentRoutingRecord, LogicalOperation, SessionDetail, TaskBrief, WorkflowRun, WorkflowNodeRun, WorkItem } from '@agent-cluster/shared';
import type { PersistenceService, PersistedState } from '../persistence/persistence.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { assertIntentExecutionCurrent } from './intent-execution-guard.js';
import { intentEffectAuthoritySnapshot } from './intent-test-authority.js';

export const INTENT_RESUME_COLLECTIONS = ['sessions', 'sessionLifecyclesBySession', 'sessionStopRequestsBySession',
  'logicalOperationsBySession', 'tasksBySession', 'briefsBySession', 'workItemsBySession', 'workflowRuntime',
  'intentRoutingRecordsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession', 'decisionRecordsBySession', 'eventsBySession'];
const rows = <T>(state: PersistedState, key: string, sessionId: string): T[] =>
  (state[key] as Record<string, T[]> | undefined)?.[sessionId] ?? [];
const fail = (code: string): never => { throw new ConflictException(code); };
const unique = <T>(items: T[]): T | undefined => {
  if (items.length > 1) fail('INTENT_RESUME_PLAN_AMBIGUOUS');
  return items[0];
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function readIntentResumeState(persistence: PersistenceService): PersistedState {
  return Object.fromEntries(INTENT_RESUME_COLLECTIONS.map(key => [key, persistence.getCollection(key, key === 'sessions' ? [] : {})]));
}

/** This fence is intentionally limited to the new chain. It never approves a budget hold. */
export function assertNoPendingInputBudget(state: PersistedState, session: SessionDetail) {
  if (session.intentContractVersion !== 'intent-understanding-v1') return;
  const lifecycle = (state.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[session.id];
  const pending = rows<LogicalOperation>(state, 'logicalOperationsBySession', session.id).some(operation =>
    operation.inputBudgetDecisions?.some(hold => hold.status === 'pending' && hold.dataEpoch === session.dataEpoch &&
      hold.sessionGeneration === lifecycle?.generation));
  const events = rows<CollaborationEvent>(state, 'eventsBySession', session.id);
  const pendingCard = events.some(event => event.type === 'user_confirmation_requested' &&
    event.metadata.payload?.reason === 'input_budget_exceeded' && !events.some(resolution =>
      resolution.type === 'user_confirmation_resolved' && resolution.metadata.payload?.confirmationId === event.metadata.payload?.confirmationId));
  if (pending || pendingCard) fail('INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED');
}

export function assertActiveIntentContinuation(state: PersistedState, session: SessionDetail, workItemId: string | null) {
  assertNoPendingInputBudget(state, session);
  if (session.status !== 'EXECUTING' || !workItemId || session.activeWorkItemId !== workItemId) fail('INTENT_CONTINUATION_NOT_ACTIVE');
  const lifecycle = (state.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[session.id];
  const tasks = rows<AgentTask>(state, 'tasksBySession', session.id);
  const work = rows<WorkItem>(state, 'workItemsBySession', session.id).find(row => row.id === workItemId);
  if (!work || ['CANCELLED', 'COMPLETED', 'FAILED'].includes(work.status) || work.dispatchHold ||
    !((tasks.some(task => task.workItemId === workItemId && task.status === 'running' && !task.stale)) ||
      rows<LogicalOperation>(state, 'logicalOperationsBySession', session.id).some(operation => operation.workItemId === workItemId &&
        operation.admissionClass === 'business' && operation.activeInvocationId && operation.status === 'running' && operation.stopState === 'none' &&
        operation.dataEpoch === session.dataEpoch && operation.sessionGeneration === lifecycle?.generation &&
        tasks.some(task => task.id === operation.taskId && task.workItemId === workItemId && !task.stale && !['cancelled', 'completed', 'failed'].includes(task.status))))) {
    fail('INTENT_CONTINUATION_NOT_ACTIVE');
  }
}

/** No time-based fallback: only persisted, uniquely linked execution authority can be resumed. */
export function bindIntentResume(state: PersistedState, sessionId: string, actorId: string,
  expected?: IntentResumeBinding, dispatch = false): IntentResumeBinding {
  const authority = bindIntentRecoveryAuthority(state, sessionId, actorId, undefined, dispatch);
  const session = (state.sessions as SessionDetail[]).find(row => row.id === sessionId)!;
  const result: IntentResumeBinding = { ...authority, pauseRevision: session.revision ?? 1,
    pausedAt: session.pauseState?.pausedAt ?? expected?.pausedAt ?? fail('INTENT_RESUME_STATE_INVALID') };
  if (expected && !isDeepStrictEqual({ ...result, pauseRevision: expected.pauseRevision }, expected)) fail('INTENT_RESUME_VERSION_STALE');
  if (expected && !dispatch && result.pauseRevision !== expected.pauseRevision) fail('INTENT_RESUME_VERSION_STALE');
  return structuredClone(expected ?? result);
}

/** Common original-authority proof. Retry changes target/state checks, never authorization. */
export function bindIntentRecoveryAuthority(state: PersistedState, sessionId: string, actorId: string,
  retryTaskId?: string, dispatch = false): Omit<IntentResumeBinding, 'pausedAt' | 'pauseRevision'> {
  const session = unique((state.sessions as SessionDetail[] | undefined ?? []).filter(row => row.id === sessionId));
  if (!session || session.intentContractVersion !== 'intent-understanding-v1' || session.ownerId !== actorId || session.archivedAt) {
    return fail('INTENT_RESUME_SESSION_UNAVAILABLE');
  }
  assertNoPendingInputBudget(state, session);
  const lifecycle = (state.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[sessionId];
  if (!lifecycle || lifecycle.state !== 'active' || lifecycle.dataEpoch !== session.dataEpoch) fail('INTENT_RESUME_IDENTITY_STALE');
  if (!retryTaskId && ((!dispatch && session.status !== 'PAUSED') || (dispatch && !['PAUSED', 'EXECUTING'].includes(session.status)) ||
    (!dispatch && session.pauseState?.previousStatus !== 'EXECUTING'))) fail('INTENT_RESUME_STATE_INVALID');
  const operations = rows<LogicalOperation>(state, 'logicalOperationsBySession', sessionId);
  const stop = rows<{ status: string; targets: Array<{ state: string }> }>(state, 'sessionStopRequestsBySession', sessionId).at(-1);
  if (!['idle', 'confirmed'].includes(lifecycle!.stopStatus) || (stop && (stop.status !== 'confirmed' || stop.targets.some(target => target.state !== 'confirmed'))) ||
    operations.some(operation => operation.admissionClass !== 'routing' && (operation.activeInvocationId || ['requested', 'unconfirmed'].includes(operation.stopState)))) {
    fail('INTENT_RESUME_STOP_UNCONFIRMED');
  }
  const work = unique(rows<WorkItem>(state, 'workItemsBySession', sessionId).filter(row => row.id === session.activeWorkItemId));
  if (!work) return fail('INTENT_RESUME_PLAN_MISSING');
  if (['CANCELLED', 'COMPLETED', ...(!retryTaskId ? ['FAILED'] : [])].includes(work.status)) fail('INTENT_RESUME_TARGET_OBSOLETE');
  if (work.dispatchHold) fail('INTENT_DISPATCH_HELD');
  const briefs = rows<TaskBrief>(state, 'briefsBySession', sessionId);
  const brief = unique(briefs.filter(row => row.id === session.currentTaskBriefId));
  if (!brief) return fail('INTENT_RESUME_PLAN_MISSING');
  if (brief.workItemId !== work.id || briefs.some(row => row.supersedesBriefId === brief.id)) fail('INTENT_RESUME_TARGET_OBSOLETE');
  const receipt = brief.intentConfirmationReceipt;
  if (!brief.confirmedByUser || !receipt) return fail('INTENT_RESUME_AUTHORITY_UNPROVEN');
  if (receipt.actorId !== actorId || receipt.request.dataEpoch !== session.dataEpoch ||
    receipt.request.expectedBriefVersion !== brief.version || receipt.requirementRevision !== (work.requirementRevision ?? 1)) fail('INTENT_RESUME_VERSION_STALE');
  let tasks = rows<AgentTask>(state, 'tasksBySession', sessionId).filter(task => task.workItemId === work.id && task.status !== 'completed');
  if (retryTaskId) tasks = tasks.filter(task => task.id === retryTaskId);
  let workflow: IntentResumeBinding['workflow'];
  if (session.workflowRunId) {
    const runtime = state.workflowRuntime as { runs?: WorkflowRun[]; nodeRunsByRunId?: Record<string, WorkflowNodeRun[]> } | undefined;
    const run = unique((runtime?.runs ?? []).filter(row => row.id === session.workflowRunId));
    if (!run) return fail('INTENT_RESUME_PLAN_MISSING');
    if (run.sessionId !== sessionId || run.workItemId !== work.id || run.briefId !== brief.id ||
      !(retryTaskId ? ['failed', ...(dispatch ? ['running'] : [])] : ['running']).includes(run.status) ||
      run.pendingAgentSubstitution || run.pendingUpstreamRerun || run.pendingRevisionHandoff) fail('INTENT_RESUME_TARGET_OBSOLETE');
    if (run.sessionGeneration !== lifecycle!.generation) fail('INTENT_RESUME_IDENTITY_STALE');
    const node = unique((runtime?.nodeRunsByRunId?.[run.id] ?? []).filter(row => row.nodeId === run.currentNodeId &&
      (retryTaskId ? row.relatedTaskId === retryTaskId && ['failed', ...(dispatch ? ['running'] : [])].includes(row.status) : row.status === 'running')));
    if (!node?.relatedTaskId) return fail('INTENT_RESUME_PLAN_MISSING');
    if (node.workflowRunId !== run.id) fail('INTENT_RESUME_TARGET_OBSOLETE');
    tasks = rows<AgentTask>(state, 'tasksBySession', sessionId).filter(task => task.id === node.relatedTaskId);
    if (tasks.some(task => task.workflowRunId !== run.id || task.workflowNodeId !== node.nodeId || task.workflowNodeRunId !== node.id)) {
      fail('INTENT_RESUME_TARGET_OBSOLETE');
    }
    workflow = { id: run.id, nodeRunId: node.id, definitionHash: hash(run.definitionSnapshot) };
  }
  if (!tasks.length) return fail('INTENT_RESUME_PLAN_MISSING');
  const liveGrants = intentEffectAuthoritySnapshot(session).grants;
  const taskBindings: IntentResumeBinding['tasks'] = [];
  for (const task of tasks.sort((a, b) => a.id.localeCompare(b.id))) {
    if (task.sessionId !== sessionId || task.workItemId !== work.id || task.stale ||
      ['cancelled', 'completed', ...(!retryTaskId ? ['failed'] : [])].includes(task.status)) fail('INTENT_RESUME_TARGET_OBSOLETE');
    const operation = unique(operations.filter(row => row.id === task.executionOperationId));
    if (!operation?.executionBinding || !operation.intentStepId) return fail('INTENT_RESUME_AUTHORITY_UNPROVEN');
    if (operation.taskId !== task.id || operation.workItemId !== work.id) fail('INTENT_RESUME_PLAN_AMBIGUOUS');
    if (operation.dataEpoch !== session.dataEpoch || operation.sessionGeneration !== lifecycle!.generation ||
      operation.executionBinding.sessionGeneration !== lifecycle!.generation) fail('INTENT_RESUME_IDENTITY_STALE');
    const binding = operation.executionBinding;
    const route = unique(rows<IntentRoutingRecord>(state, 'intentRoutingRecordsBySession', sessionId).filter(row => row.id === binding.routingId));
    if (!route) return fail('INTENT_RESUME_PLAN_MISSING');
    if (route.effectiveIntentRevision !== binding.intentRevision || (work.requirementRevision ?? 1) !== binding.requirementRevision ||
      (work.executionEpoch ?? 1) !== binding.executionEpoch) fail('INTENT_RESUME_VERSION_STALE');
    const revision = unique(rows<IntentRouteRevision>(state, 'intentRouteRevisionsBySession', sessionId).filter(row =>
      row.routingId === binding.routingId && row.intentRevision === binding.intentRevision && row.dataEpoch === session.dataEpoch));
    if (!revision) return fail('INTENT_RESUME_PLAN_MISSING');
    if (revision.authorizationState !== 'validated' || revision.validatedPlan?.outcome !== 'applicable') return fail('INTENT_RESUME_AUTHORITY_UNPROVEN');
    const step = unique(revision.validatedPlan.steps.filter(row => row.stepId === operation.intentStepId));
    const record = unique(rows<IntentPlanStepRecord>(state, 'intentPlanStepsBySession', sessionId).filter(row => row.id === operation.intentStepId));
    if (!step || !record) return fail('INTENT_RESUME_PLAN_MISSING');
    if (['prepare_brief', 'review_brief', 'resume', 'acknowledge'].includes(step.action) || !step.effectScope.effects.length) fail('INTENT_RESUME_AUTHORITY_UNPROVEN');
    if (!isDeepStrictEqual(record.step, step) || !isDeepStrictEqual(step.executionBinding, binding) ||
      step.effectScope.scopeHash !== binding.effectScopeHash || hash({ effects: step.effectScope.effects, prohibitions: step.effectScope.prohibitions,
        grantIds: step.effectScope.grantIds }) !== step.effectScope.scopeHash ||
      ['invalidated', 'reconciliation_required', ...(!retryTaskId ? ['failed'] : [])].includes(record.status)) fail('INTENT_EXECUTION_SCOPE_STALE');
    for (const id of step.effectScope.grantIds) {
      const saved = unique((revision.authorityGrants ?? []).filter(grant => grant.id === id));
      const live = liveGrants.find(grant => grant.id === id);
      if (!saved || !live || saved.revokedAt || !isDeepStrictEqual(saved, live)) fail('INTENT_RESUME_GRANT_STALE');
    }
    if (step.effectScope.effects.some(effect => effect.kind !== 'answer' && !(revision.authorityGrants ?? []).some(grant =>
      step.effectScope.grantIds.includes(grant.id) && grant.effect === effect.kind && isDeepStrictEqual(grant.resource, effect.target)))) fail('INTENT_RESUME_GRANT_STALE');
    assertIntentExecutionCurrent(state, { ...operation, effectScope: step.effectScope });
    taskBindings.push({ taskId: task.id, operationId: operation.id, stepId: step.stepId, executionBinding: structuredClone(binding) });
  }
  if (new Set(taskBindings.map(task => JSON.stringify([task.executionBinding.routingId, task.executionBinding.intentRevision]))).size !== 1) fail('INTENT_RESUME_PLAN_AMBIGUOUS');
  return { sessionId, dataEpoch: session.dataEpoch!, sessionGeneration: lifecycle!.generation,
    workItemId: work.id, briefId: brief.id, briefVersion: brief.version, confirmationReceiptId: receipt.id,
    routingId: taskBindings[0].executionBinding.routingId, intentRevision: taskBindings[0].executionBinding.intentRevision,
    ...(workflow ? { workflow } : {}), tasks: taskBindings };
}
