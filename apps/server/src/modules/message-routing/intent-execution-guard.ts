import type { AgentTask, DecisionRecord, IntentEffectScope, IntentExecutionBinding, IntentPlanStepRecord, IntentRouteRevision, IntentRoutingRecord, SessionDetail, WorkItem } from '@agent-cluster/shared';
import { isDeepStrictEqual } from 'node:util';
import type { PersistedState } from '../persistence/persistence.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { decisionSetHash, effectiveDecisions } from '../context-management/effective-decisions.js';
import { isReadOnlyAnswerScope } from '@agent-cluster/shared';
import { currentWorkspaceReadGrant } from './intent-workspace-read.js';
import { currentTestGrant, currentTestReportGrant } from './intent-test-authority.js';
import { completedBriefReviews } from './intent-brief-reviews.js';

export const INTENT_EXECUTION_COLLECTIONS = ['workItemsBySession', 'tasksBySession',
  'intentRoutingRecordsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession', 'decisionRecordsBySession'] as const;

export type IntentExecutionIdentity = {
  /** LogicalOperation uses id; runtime input uses operationId. */
  id?: string;
  operationId?: string;
  operation?: { id: string };
  sessionId: string;
  taskId?: string;
  workItemId?: string;
  dataEpoch?: string;
  sessionGeneration?: number;
  admissionClass?: 'business' | 'routing' | 'response';
  intentStepId?: string;
  invocationId?: string;
  agentId?: string;
  agent?: { agentId: string };
  phase?: string;
  effectScope?: IntentEffectScope;
  executionBinding?: IntentExecutionBinding;
};

export function assertIntentExecutionCurrent(draft: PersistedState, input: IntentExecutionIdentity) {
  // Keep the classifier tool-free, and fence stale preparation after an explicit recognition retry.
  if (input.admissionClass === 'routing') {
    const operationId = input.operation?.id ?? input.operationId ?? input.id;
    const routes = (draft.intentRoutingRecordsBySession as Record<string, IntentRoutingRecord[]> | undefined)?.[input.sessionId] ?? [];
    const route = operationId && routes.find(row => row.semanticContractVersion === 'intent-understanding-v1' &&
      (row.id === operationId || row.recognitionOperationId === operationId ||
        row.recognitionRetryReceipts?.some(receipt => receipt.operationId === operationId || receipt.previousOperationId === operationId)));
    if (route && (route.dispatchHold || operationId !== (route.recognitionOperationId ?? route.id))) throw new Error('INTENT_RECOGNITION_SUPERSEDED');
    return;
  }
  const records = <T>(key: string) => ((draft[key] ?? {}) as Record<string, T[]>)[input.sessionId] ?? [];
  const task = records<AgentTask>('tasksBySession').find(item => item.id === input.taskId);
  if (task?.workItemId && input.workItemId && task.workItemId !== input.workItemId) throw new Error('INTENT_EXECUTION_TARGET_MISMATCH');
  const workItemId = input.workItemId ?? task?.workItemId;
  const works = records<WorkItem>('workItemsBySession');
  const work = works.find(item => item.id === workItemId);
  const routes = records<IntentRoutingRecord>('intentRoutingRecordsBySession');
  const binding = input.executionBinding;
  if (input.admissionClass === 'response' && (!binding || !input.intentStepId || input.taskId || !input.dataEpoch)) {
    throw new Error('RESPONSE_ADMISSION_INVALID');
  }
  const route = routes.find(item => item.id === binding?.routingId);
  const session = (draft.sessions as SessionDetail[] | undefined)?.find(item => item.id === input.sessionId);
  const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[input.sessionId];
  if ((input.dataEpoch && (!session || input.dataEpoch !== session.dataEpoch)) || session?.archivedAt ||
    (lifecycle && (lifecycle.state !== 'active' || (input.sessionGeneration !== undefined && lifecycle.generation !== input.sessionGeneration)))) {
    throw new Error('INTENT_EXECUTION_STALE');
  }
  if (work?.dispatchHold || route?.dispatchHold || (!workItemId && !binding &&
    (works.some(item => item.dispatchHold) || routes.some(item => item.dispatchHold)))) throw new Error('INTENT_DISPATCH_HELD');
  if (!binding) {
    if (session?.intentContractVersion === 'intent-understanding-v1') throw new Error('INTENT_EXECUTION_BINDING_REQUIRED');
    if ((work?.executionEpoch ?? 1) > 1) throw new Error('INTENT_EXECUTION_BINDING_REQUIRED');
    return;
  }
  if (!session || session.archivedAt || (input.dataEpoch && input.dataEpoch !== session.dataEpoch) ||
    (lifecycle && (lifecycle.state !== 'active' || lifecycle.generation !== binding.sessionGeneration))) throw new Error('INTENT_EXECUTION_STALE');
  if (!route || route.effectiveIntentRevision !== binding.intentRevision ||
    (work?.requirementRevision ?? 1) !== binding.requirementRevision ||
    (work?.executionEpoch ?? route.executionEpoch ?? 1) !== binding.executionEpoch) throw new Error('INTENT_EXECUTION_STALE');
  if (workItemId && !work) throw new Error('INTENT_EXECUTION_TARGET_MISMATCH');
  const revision = records<IntentRouteRevision>('intentRouteRevisionsBySession').find(item =>
    item.routingId === route.id && item.intentRevision === binding.intentRevision && item.dataEpoch === session.dataEpoch);
  if (!revision || revision.authorizationState !== 'validated' || revision.validatedPlan?.outcome !== 'applicable' || !revision.validatedPlan.steps.some(step =>
    (step.target.workItemId ?? undefined) === workItemId &&
    step.executionBinding.requirementRevision === binding.requirementRevision &&
    step.executionBinding.executionEpoch === binding.executionEpoch &&
    step.executionBinding.sessionGeneration === binding.sessionGeneration &&
    step.executionBinding.decisionSetHash === binding.decisionSetHash &&
    (!input.effectScope || isDeepStrictEqual(step.effectScope, input.effectScope)) &&
    step.executionBinding.effectScopeHash === binding.effectScopeHash)) throw new Error('INTENT_EXECUTION_SCOPE_STALE');
  const matchingSteps = revision.validatedPlan.steps.filter(step => (step.target.workItemId ?? undefined) === workItemId &&
    step.executionBinding.effectScopeHash === binding.effectScopeHash);
  if (matchingSteps.some(step => step.action === 'prepare_brief' || step.action === 'review_brief')) {
    const record = records<IntentPlanStepRecord>('intentPlanStepsBySession').find(row => row.id === input.intentStepId);
    const operationId = input.operation?.id ?? input.operationId ?? input.id;
    if (record && operationId && operationId !== (record.briefOperationId ?? `brief:${record.id}`)) throw new Error('INTENT_BRIEF_OPERATION_SUPERSEDED');
    const review = record?.step.action === 'review_brief';
    if (input.admissionClass !== 'business' || !record || !['prepare_brief', 'review_brief'].includes(record.step.action) || record.status !== 'running' ||
      record.dataEpoch !== session.dataEpoch || record.routingId !== route.id || record.intentRevision !== binding.intentRevision ||
      !record.processing || Date.parse(record.processing.deadlineAt) <= Date.now() || Date.parse(record.processing.leaseExpiresAt) <= Date.now() ||
      (input.invocationId && record.processing.invocationId !== input.invocationId) || (input.phase && input.phase !== (review ? 'brief_revision' : 'brief_generation')) ||
      !isDeepStrictEqual(record.step.executionBinding, binding) || !revision.validatedPlan.steps.some(step => isDeepStrictEqual(step, record.step))) {
      throw new Error('INTENT_BRIEF_STEP_STALE');
    }
    if (review && (record.step.target.agentIds.length !== 1 || record.step.effectScope.effects.length ||
      (input.invocationId && (input.agent?.agentId ?? input.agentId) !== record.step.target.agentIds[0]))) throw new Error('INTENT_BRIEF_REVIEW_AGENT_MISMATCH');
    if (review && route.briefRevision && (!route.briefRevision.reviewerIds?.includes(record.step.target.agentIds[0]) ||
      !session.participatingAgentIds.includes(record.step.target.agentIds[0]))) throw new Error('INTENT_BRIEF_REVIEW_TARGET_UNAVAILABLE');
    if (!review) completedBriefReviews(record, records<IntentPlanStepRecord>('intentPlanStepsBySession'), revision);
  }
  for (const step of matchingSteps.filter(step => step.effectScope.effects.some(effect => effect.kind === 'write_artifact'))) {
    const grant = currentTestReportGrant(session);
    if (!grant || !step.effectScope.grantIds.includes(grant.id) || !revision.authorityGrants?.some(saved => isDeepStrictEqual(saved, grant)) ||
      step.effectScope.effects.some(effect => effect.kind === 'write_artifact' && !isDeepStrictEqual(effect.target, grant.resource))) {
      throw new Error('INTENT_REPORT_AUTHORITY_STALE');
    }
  }
  for (const step of matchingSteps.filter(step => step.effectScope.effects.some(effect => effect.kind === 'run_tests'))) {
    const grant = currentTestGrant(session);
    if (!grant || !step.effectScope.grantIds.includes(grant.id) || !revision.authorityGrants?.some(saved => isDeepStrictEqual(saved, grant)) ||
      step.effectScope.effects.some(effect => effect.kind === 'run_tests' &&
        (effect.target.kind !== grant.resource.kind || effect.target.refId !== grant.resource.refId))) throw new Error('INTENT_TEST_AUTHORITY_STALE');
  }
  if (input.admissionClass === 'response') {
    const record = records<IntentPlanStepRecord>('intentPlanStepsBySession').find(row => row.id === input.intentStepId);
    if (route.status !== 'ROUTED' || !record || record.dataEpoch !== session.dataEpoch || record.routingId !== route.id || record.intentRevision !== binding.intentRevision ||
      record.status !== 'running' || !record.processing || Date.parse(record.processing.deadlineAt) <= Date.now() ||
      Date.parse(record.processing.leaseExpiresAt) <= Date.now() || (input.invocationId && record.processing.invocationId !== input.invocationId) ||
      record.step.action !== 'answer_in_chat' || !isReadOnlyAnswerScope(record.step.effectScope, session.workspaceId) ||
      !isDeepStrictEqual(record.step.executionBinding, binding) || !revision.validatedPlan.steps.some(step => isDeepStrictEqual(step, record.step))) {
      throw new Error('INTENT_RESPONSE_STEP_STALE');
    }
    if (record.step.effectScope.effects.some(effect => effect.kind === 'read_workspace')) {
      const grant = currentWorkspaceReadGrant(session);
      if (!grant || !record.step.effectScope.grantIds.includes(grant.id) ||
        !revision.authorityGrants?.some(saved => isDeepStrictEqual(saved, grant))) throw new Error('INTENT_WORKSPACE_READ_AUTHORITY_STALE');
    }
    if (input.invocationId && record.step.target.agentIds.length &&
      (record.step.target.agentIds.length !== 1 || (input.agent?.agentId ?? input.agentId) !== record.step.target.agentIds[0])) {
      throw new Error('INTENT_RESPONSE_AGENT_MISMATCH');
    }
  }
  if (work && decisionSetHash(effectiveDecisions(records<DecisionRecord>('decisionRecordsBySession'), work)) !== binding.decisionSetHash) {
    throw new Error('INTENT_EXECUTION_DECISIONS_STALE');
  }
}

/** Internal control flow: an audited obsolete result must not become a business failure/retry. */
export class IntentExecutionSupersededError extends Error {
  constructor(readonly reason: string) { super(`INTENT_EXECUTION_SUPERSEDED: ${reason}`); }
}
