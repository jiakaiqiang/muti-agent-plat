import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { AgentTask, CollaborationEvent, DecisionRecord, IntentContextSnapshot, IntentFollowUp, IntentPlanStepRecord, IntentRouteRevision,
  IntentRoutingRecord, IntentSourceAuthority, IntentUnderstandingOutput, LogicalOperation, SessionDetail, TaskBrief, ValidatedRoutePlan, WorkItem, WorkspaceWritebackRecord } from '@agent-cluster/shared';
import type { PersistedState } from '../persistence/persistence.service.js';
import { decisionSetHash, effectiveDecisions } from '../context-management/effective-decisions.js';
import { routingBusinessFingerprint } from '../context-management/context-management.service.js';
import { appendCorrectionEvent, correctionRows as rows } from './intent-correction-state.js';
import { currentSourceGrants, sourceHash } from './intent-source-authority.js';
import { currentWorkspaceReadGrant, workspaceReadBindingHash } from './intent-workspace-read.js';
import { compileIntentRoutePlan } from './route-plan-compiler.service.js';
import { assertNoPendingInputBudget } from './intent-resume-guard.js';

export const FOLLOW_UP_COLLECTIONS = ['sessions', 'sessionLifecyclesBySession', 'workItemsBySession', 'decisionRecordsBySession', 'tasksBySession',
  'logicalOperationsBySession', 'intentRoutingRecordsBySession', 'intentRouteRevisionsBySession', 'intentPlanStepsBySession', 'contextSnapshotsBySession',
  'followUpMessagesBySession', 'briefsBySession', 'intentReconciliationsBySession', 'intentCorrectionsBySession', 'workflowRuntime',
  'workspaceWritebacks', 'runtimeInvocationsBySession', 'sessionStopRequestsBySession', 'eventsBySession', 'eventOutbox'];
export const followUpDecisionsHash = (draft: PersistedState, session: SessionDetail, work: WorkItem) =>
  decisionSetHash(effectiveDecisions(rows<DecisionRecord>(draft, 'decisionRecordsBySession', session.id), work));

export function liveFollowUpAuthority(session: SessionDetail, generation: number, workItemId: string, id: string) {
  const authority = session.intentSourceAuthorities?.find(row => row.id === id);
  if (!authority || authority.workItemId !== workItemId || authority.sessionGeneration !== generation ||
    !currentSourceGrants(session).some(row => row.id === authority.grant.id)) throw new ConflictException('INTENT_SOURCE_AUTHORITY_STALE');
  return authority;
}

/** Bind only a source effect to a separately owner-confirmed exact scope. Keep the original proposal verbatim. */
export function bindFollowUpUnderstanding(original: IntentUnderstandingOutput, session: SessionDetail, authority: IntentSourceAuthority) {
  const result = structuredClone(original), segment = result.segments[0], read = currentWorkspaceReadGrant(session);
  if (result.segments.length !== 1 || segment.scopeRelation !== 'same_requirement' || segment.suggestedAction !== 'enqueue_follow_up' || segment.dialogueAct !== 'command' ||
    segment.contextPolicy !== 'inherit_confirmed' || segment.correction || segment.dependencies.length || segment.target.agentIds.length || segment.target.decisionIds.length ||
    segment.target.artifactIds.length || segment.target.confirmationId || segment.target.correctionOfRoutingId ||
    segment.requestedEffects.filter(row => row.kind === 'modify_source').length !== 1 || segment.requestedEffects.some(row => !['modify_source', 'read_workspace'].includes(row.kind))) throw new ConflictException('INTENT_FOLLOW_UP_UNSUPPORTED');
  const effects = segment.requestedEffects.map(effect => {
    if (effect.kind === 'modify_source') {
      if (!(effect.target.kind === 'unresolved' || (effect.target.kind === 'workspace' && effect.target.refId === session.workspaceId) ||
        (effect.target.kind === 'source' && effect.target.refId === authority.sourceResourceId))) throw new ConflictException('INTENT_SOURCE_TARGET_UNRESOLVED');
      return { ...effect, target: structuredClone(authority.grant.resource) };
    } else if (!read || !((effect.target.kind === 'workspace' && effect.target.refId === session.workspaceId) || effect.target.kind === 'unresolved')) throw new ConflictException('INTENT_WORKSPACE_READ_AUTHORITY_REQUIRED');
    else return { ...effect, target: structuredClone(read.resource) };
  });
  result.segments[0] = { ...segment, requestedEffects: effects };
  // A canonical schema subresource is safe only with the independently confirmed, enforced policy.
  // Unknown/general bans remain untouched and the frozen compiler rejects them.
  return result;
}

export function compileFollowUp(draft: PersistedState, session: SessionDetail, route: IntentRoutingRecord, work: WorkItem, authority: IntentSourceAuthority,
  understanding: IntentUnderstandingOutput, snapshot: IntentContextSnapshot, intentRevision: number, requirementRevision: number, generation: number) {
  const read = currentWorkspaceReadGrant(session), grants = [authority.grant, ...(read ? [read] : [])];
  const schema = { kind: 'source' as const, refId: `schema:${session.workspaceId}` };
  const bans = understanding.segments[0].prohibitions.filter(ban => ban.effectKind === 'modify_source' && ban.object.kind === schema.kind &&
    ban.object.refId === schema.refId && authority.prohibitions.includes('no_schema_change'));
  return compileIntentRoutePlan({ session, routing: route, snapshot, understanding, snapshotCurrent: true, intentRevision, requirementRevision,
    executionEpoch: work.executionEpoch ?? 1, sessionGeneration: generation, validArtifactIds: [], correctionRoutingIds: [], stopConfirmed: true,
    scopePolicy: { grants, resources: [...grants.map(row => row.resource), schema],
      phaseAllowed: ['modify_source', 'read_workspace'], toolAllowed: ['modify_source', 'read_workspace'], workspaceAllowed: ['modify_source', 'read_workspace'],
      runtimeAllowed: ['modify_source', 'read_workspace'], enforceableProhibitions: bans } });
}

export function saveFollowUpPlan(draft: PersistedState, session: SessionDetail, route: IntentRoutingRecord, follow: IntentFollowUp, plan: ValidatedRoutePlan,
  understanding: IntentUnderstandingOutput, authority: IntentSourceAuthority, statuses: IntentPlanStepRecord['status'][]) {
  const previousRevision = route.currentIntentRevision ?? null, now = new Date().toISOString();
  rows<IntentRouteRevision>(draft, 'intentRouteRevisionsBySession', session.id).push({ id: `intent-revision:${route.id}:${plan.intentRevision}`, sessionId: session.id,
    dataEpoch: session.dataEpoch!, routingId: route.id, intentRevision: plan.intentRevision, previousRevision, sourceEventId: follow.sourceEventId,
    authorizationState: 'validated', authorityGrants: [structuredClone(authority.grant), ...(currentWorkspaceReadGrant(session) ? [currentWorkspaceReadGrant(session)!] : [])],
    understanding: structuredClone(understanding), validatedPlan: structuredClone(plan), policyVersion: plan.policyVersion, createdAt: now });
  plan.steps.forEach((step, index) => rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', session.id).push({ id: step.stepId, sessionId: session.id, dataEpoch: session.dataEpoch!,
    routingId: route.id, intentRevision: plan.intentRevision, localKey: step.segmentKey, step: structuredClone(step), status: statuses[index], reusedEffectIds: [], createdAt: now, updatedAt: now }));
  route.currentIntentRevision = route.effectiveIntentRevision = plan.intentRevision; route.semanticPlan = structuredClone(plan); route.status = 'ROUTED';
  route.actionStatus = 'pending'; route.routingRevision = (route.routingRevision ?? 1) + 1; route.updatedAt = now;
  route.reasonCodes = []; delete route.blockedReason;
}

export function followUpQuiescent(draft: PersistedState, session: SessionDetail, follow: IntentFollowUp) {
  if (['PAUSED', 'INTERRUPTED', 'CANCELLED', 'COMPLETED', 'FAILED'].includes(session.status) || session.activeRecoveryCheckpoint || session.pendingBriefRevisionRoutingId) return false;
  assertNoPendingInputBudget(draft, session);
  const life = (draft.sessionLifecyclesBySession as Record<string, { admission: string; stopStatus: string }>)[session.id];
  if (life.admission !== 'open' || !['idle', 'confirmed'].includes(life.stopStatus)) return false;
  if (rows<AgentTask>(draft, 'tasksBySession', session.id).some(row => (!row.workItemId || row.workItemId === follow.workItemId) && !['completed', 'cancelled', 'failed'].includes(row.status))) return false;
  if (rows<LogicalOperation>(draft, 'logicalOperationsBySession', session.id).some(row => row.admissionClass !== 'routing' &&
    (row.activeInvocationId || ['requested', 'unconfirmed'].includes(row.stopState) || row.isolatedTestAttempts?.some(attempt => !attempt.stopConfirmed || attempt.cleanupRequired)))) return false;
  const workflow = draft.workflowRuntime as { runs?: Array<{ sessionId: string; status: string }> } | undefined;
  if (workflow?.runs?.some(row => row.sessionId === session.id && !['completed', 'cancelled', 'failed'].includes(row.status))) return false;
  if (rows<{ status: string }>(draft, 'intentReconciliationsBySession', session.id).some(row => row.status !== 'resolved') ||
    rows<{ status: string }>(draft, 'intentCorrectionsBySession', session.id).some(row => !['applied', 'rejected', 'failed', 'cancelled'].includes(row.status))) return false;
  if (rows<IntentPlanStepRecord>(draft, 'intentPlanStepsBySession', session.id).some(row => row.routingId !== follow.routingId &&
    !session.intentFollowUps?.some(queued => queued.routingId === row.routingId && ['queued', 'blocked', 'cancelled', 'completed'].includes(queued.status)) && ['queued', 'running', 'reconciliation_required'].includes(row.status))) return false;
  const writebacks = (draft.workspaceWritebacks ?? []) as WorkspaceWritebackRecord[];
  if (writebacks.some(row => row.sessionId === session.id && !['applied', 'abandoned'].includes(row.status))) return false;
  const claims = session.intentSourceAuthorities?.flatMap(row => row.applyClaims) ?? [];
  if (claims.some(claim => (!claim.outcome || claim.outcome === 'unknown') && !session.intentSourceApplyResolutions?.some(row => row.claimId === claim.id))) return false;
  return !(session.intentSourceCandidates ?? []).some(row => row.candidate && !claims.some(claim => claim.candidateId === row.candidate!.id &&
    (claim.outcome === 'applied' || session.intentSourceApplyResolutions?.some(resolution => resolution.claimId === claim.id && ['confirm_completed', 'abandon'].includes(resolution.action)))));
}

/** Called in the same transaction as the real owner Brief receipt and Decision append. */
export function approveFollowUpInDraft(draft: PersistedState, session: SessionDetail, brief: TaskBrief) {
  const follow = session.intentFollowUps?.find(row => row.briefStepId === brief.intentBinding?.stepId && row.status === 'brief');
  if (!follow) return;
  const route = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id).find(row => row.id === follow.routingId)!;
  const work = rows<WorkItem>(draft, 'workItemsBySession', session.id).find(row => row.id === follow.workItemId)!;
  const generation = (draft.sessionLifecyclesBySession as Record<string, { generation: number }>)[session.id].generation;
  const authority = liveFollowUpAuthority(session, generation, work.id, follow.sourceAuthorityId);
  assertNoPendingInputBudget(draft, session);
  if (!brief.confirmedByUser || !brief.intentConfirmationReceipt || session.status === 'PAUSED') throw new ConflictException('INTENT_FOLLOW_UP_CONFIRMATION_REQUIRED');
  const snapshot = structuredClone(rows<IntentContextSnapshot>(draft, 'contextSnapshotsBySession', session.id).find(row => row.id === route.semanticPlan!.snapshotId)!);
  snapshot.validDecisions = effectiveDecisions(rows<DecisionRecord>(draft, 'decisionRecordsBySession', session.id), work);
  snapshot.validDecisionIds = snapshot.validDecisions.map(row => row.id);
  snapshot.businessFingerprint = routingBusinessFingerprint(session, rows<WorkItem>(draft, 'workItemsBySession', session.id), rows<CollaborationEvent>(draft, 'eventsBySession', session.id), rows<AgentTask>(draft, 'tasksBySession', session.id));
  snapshot.id = `followup-execution:${follow.id}`; rows<IntentContextSnapshot>(draft, 'contextSnapshotsBySession', session.id).push(snapshot);
  const plan = compileFollowUp(draft, session, route, work, authority, follow.compiledUnderstanding, snapshot, route.currentIntentRevision! + 1, work.requirementRevision!, generation);
  if (plan.outcome !== 'applicable') throw new ConflictException({ message: 'INTENT_FOLLOW_UP_REVALIDATION_FAILED', reasonCodes: plan.validation.errorCodes });
  const step = plan.steps[0], taskId = `followup-task:${follow.id}`, operationId = `followup-operation:${follow.id}`, now = new Date().toISOString();
  saveFollowUpPlan(draft, session, route, follow, plan, follow.compiledUnderstanding, authority, ['queued']);
  rows<AgentTask>(draft, 'tasksBySession', session.id).push({ id: taskId, sessionId: session.id, workItemId: work.id, title: step.goal.slice(0, 120), description: step.goal,
    status: 'pending', executionOperationId: operationId, dependsOnTaskIds: [], acceptanceCriteria: [...brief.acceptanceCriteria], createdAt: now, updatedAt: now });
  rows<LogicalOperation>(draft, 'logicalOperationsBySession', session.id).push({ id: operationId, sessionId: session.id, dataEpoch: session.dataEpoch, workItemId: work.id,
    taskId, intentStepId: step.stepId, executionBinding: structuredClone(step.executionBinding), sessionGeneration: generation, admissionClass: 'business', phase: 'task_execution',
    policyVersion: 'execution-reliability-v1', status: 'ready', deadlineAt: new Date(Date.now() + 1200000).toISOString(), remainingActiveMs: 1200000,
    maxAttempts: 3, attemptsUsed: 0, stopState: 'none', invocationIds: [], createdAt: now, updatedAt: now });
  Object.assign(follow, { status: 'ready', taskId, operationId, executionStepId: step.stepId, invocationId: randomUUID(), revision: follow.revision + 1, updatedAt: now });
  session.status = 'EXECUTING'; work.status = 'EXECUTING';
  const event: CollaborationEvent = { id: `followup-task-created:${follow.id}`, sessionId: session.id, workItemId: work.id, type: 'task_created', toAgentIds: [], createdAt: now,
    content: '追加需求草稿已由用户确认，已建立唯一执行任务。', metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { taskId, operationId, stepId: step.stepId, followUpId: follow.id } } };
  appendCorrectionEvent(draft, event);
}
