import { ConflictException } from '@nestjs/common';
import { isIsolatedTestScope, validateRuntimeOutput, type AgentTask, type CollaborationEvent, type CorrectIntentRoutingInput,
  type DecisionRecord, type IntentContextSnapshot, type IntentRoutingRecord, type SessionDetail,
  type SessionFollowUpMessage, type WorkItem } from '@agent-cluster/shared';
import type { PersistedState } from '../persistence/persistence.service.js';
import { routingBusinessFingerprint } from '../context-management/context-management.service.js';
import { validateIntentRoutingDecision } from './intent-policy.service.js';
import { correctionRows as rows } from './intent-correction-state.js';
import { compileIntentRoutePlan } from './route-plan-compiler.service.js';
import type { SessionLifecyclesBySession } from '../runtimes/session-lifecycle-store.js';
import { currentTestGrant, currentTestReportGrant, intentEffectAuthoritySnapshot } from './intent-test-authority.js';
import { assertBriefRevisionPlan } from './intent-brief-revision.js';

/** All references come from the persisted classification snapshot, never a second free-text guess. */
export function resolveMessageCorrection(draft: PersistedState, session: SessionDetail,
  input: { routingId: string; expectedLeaseOwner?: string }) {
  const routes = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id);
  const source = routes.find(row => row.id === input.routingId);
  const fail = (code: string): never => { throw new ConflictException(code); };
  if (!source || source.rolloutMode === 'shadow' || source.dispatchHold || source.status !== 'VALIDATING') return fail('CORRECTION_SOURCE_NOT_READY');
  if ((source.leaseOwner || input.expectedLeaseOwner) && (source.leaseOwner !== input.expectedLeaseOwner ||
    !(Date.parse(source.leaseExpiresAt ?? '') > Date.now()))) return fail('ROUTING_LEASE_LOST');
  if (source.semanticContractVersion) return resolveSemanticCorrection(draft, session, source);
  const snapshot = rows<IntentContextSnapshot>(draft, 'contextSnapshotsBySession', session.id).find(row => row.id === source.snapshotId);
  const follow = rows<SessionFollowUpMessage>(draft, 'followUpMessagesBySession', session.id).find(row => row.routingId === source.id);
  const events = rows<CollaborationEvent>(draft, 'eventsBySession', session.id);
  const event = events.find(row => row.id === source.sourceEventId && row.type === 'user_message' && row.sessionId === session.id);
  if (!snapshot || snapshot.sessionId !== session.id || snapshot.sourceEventId !== source.sourceEventId || !follow || !event ||
    follow.sourceEventId !== event.id || follow.status !== 'queued' || follow.content !== event.content ||
    snapshot.currentMessage !== event.content || snapshot.replyToEventId !== follow.replyToEventId) return fail('CORRECTION_SOURCE_MISMATCH');
  const decision = source.decision;
  if (!decision || decision.dialogueAct !== 'correction' || decision.scopeRelation !== 'same_requirement' ||
    decision.requestedAction !== 'continue_active_work_item' || !decision.selectedWorkItemId ||
    decision.selectedDecisionIds.length > 1 || decision.goalSegments.length > 1) return fail('CORRECTION_TARGET_REQUIRED');
  const schema = validateRuntimeOutput('intent_routing_decision', { ...decision, schemaVersion: '1.0', kind: 'intent_routing_decision',
    requestedAgentIds: decision.requestedAgentIds ?? [], modelConfidence: decision.modelConfidence ?? null });
  if (!schema.valid) return fail('CORRECTION_SOURCE_SCHEMA_INVALID');
  const works = rows<WorkItem>(draft, 'workItemsBySession', session.id);
  const target = works.find(row => row.id === decision.selectedWorkItemId);
  if (!target || !snapshot.businessFingerprint || snapshot.businessFingerprint !== routingBusinessFingerprint(session, works, events,
    rows<AgentTask>(draft, 'tasksBySession', session.id))) return fail('CORRECTION_SOURCE_STALE');
  const validation = validateIntentRoutingDecision({ session, snapshot, decision, snapshotCurrent: true, inheritedArtifactIds: target.inheritedArtifactIds });
  if (!validation.safeToApply) return fail('CORRECTION_SOURCE_POLICY_INVALID');
  const old = decision.selectedDecisionIds.length ? rows<DecisionRecord>(draft, 'decisionRecordsBySession', session.id)
    .find(row => row.id === decision.selectedDecisionIds[0]) : undefined;
  const oldInSnapshot = old && snapshot.validDecisions.find(row => row.id === old.id);
  if (decision.selectedDecisionIds.length && (!old || !oldInSnapshot || old.status !== 'confirmed' || old.revision !== oldInSnapshot.revision ||
    (old.workItemId !== target.id && !target.inheritedDecisionIds.includes(old.id)))) return fail('CORRECTION_DECISION_STALE');
  const candidates = (snapshot.correctionCandidates ?? []).filter(candidate =>
    (old ? candidate.decisionIds.includes(old.id) : (candidate.referenceEventId ?? candidate.sourceEventId) === snapshot.replyToEventId) &&
    (!snapshot.replyToEventId || (candidate.referenceEventId ?? candidate.sourceEventId) === snapshot.replyToEventId));
  if (candidates.length !== 1) return fail('CORRECTION_TARGET_REQUIRED');
  const candidate = candidates[0];
  const original = routes.find(row => row.id === candidate.routingId);
  const reference = routes.find(row => row.sourceEventId === (candidate.referenceEventId ?? candidate.sourceEventId) &&
    (row.id === candidate.routingId || row.correctionTargetRoutingId === candidate.routingId));
  if (!original || original.id === source.id || original.sourceEventId !== candidate.sourceEventId ||
    !reference || (original.routingRevision ?? 1) !== candidate.routingRevision) return fail('CORRECTION_TARGET_STALE');
  // A reply alone may identify a route, but cannot retarget it to an unrelated task.
  if (!candidate.workItemIds.includes(target.id)) return fail('CORRECTION_TARGET_REQUIRED');
  const request: CorrectIntentRoutingInput = { contractVersion: 'intent-correction-v1',
    expectedRoutingRevision: candidate.routingRevision, idempotencyKey: `chat-correction:${source.id}`,
    instruction: event.content, targetWorkItemId: target.id, supersedesDecisionId: old?.id ?? null,
    expectedDecisionRevision: oldInSnapshot?.revision ?? null };
  return { routingId: original.id, request, source, follow, event };
}

/** Revalidate the saved semantic proposal inside the same transaction that installs the hold. */
function resolveSemanticCorrection(draft: PersistedState, session: SessionDetail, source: IntentRoutingRecord) {
  const fail = (code: string): never => { throw new ConflictException(code); };
  const proposal = source.semanticProposal;
  const lifecycle = (draft.sessionLifecyclesBySession as SessionLifecyclesBySession | undefined)?.[session.id];
  if (!proposal?.understanding || proposal.dataEpoch !== session.dataEpoch || proposal.sessionGeneration !== lifecycle?.generation ||
    source.leaseOwner || source.semanticPlan) return fail('CORRECTION_SOURCE_STALE');
  const snapshot = rows<IntentContextSnapshot>(draft, 'contextSnapshotsBySession', session.id).find(row => row.id === source.snapshotId);
  const events = rows<CollaborationEvent>(draft, 'eventsBySession', session.id);
  const event = events.find(row => row.id === source.sourceEventId && row.type === 'user_message' && row.sessionId === session.id);
  if (!snapshot || snapshot.id !== proposal.snapshotId || snapshot.sessionId !== session.id || snapshot.sourceEventId !== source.sourceEventId ||
    !event || snapshot.currentMessage !== event.content || snapshot.replyToEventId !== (event.metadata.payload?.replyToEventId ?? undefined)) return fail('CORRECTION_SOURCE_MISMATCH');
  const works = rows<WorkItem>(draft, 'workItemsBySession', session.id);
  if (!snapshot.businessFingerprint || snapshot.businessFingerprint !== routingBusinessFingerprint(session, works, events,
    rows<AgentTask>(draft, 'tasksBySession', session.id))) return fail('SNAPSHOT_STALE');
  const authority = intentEffectAuthoritySnapshot(session);
  const allowedEffects = [...(currentTestGrant(session) ? ['run_tests' as const] : []), ...(currentTestReportGrant(session) ? ['write_artifact' as const] : [])];
  const plan = compileIntentRoutePlan({ session, routing: source, snapshot, understanding: proposal.understanding, snapshotCurrent: true,
    intentRevision: 1, requirementRevision: 1, executionEpoch: 1, sessionGeneration: lifecycle!.generation,
    validArtifactIds: [], correctionRoutingIds: (snapshot.correctionCandidates ?? []).map(row => row.routingId), stopConfirmed: false,
    scopePolicy: { grants: authority.grants, resources: authority.resources,
      phaseAllowed: [...allowedEffects], toolAllowed: [...allowedEffects], workspaceAllowed: [...allowedEffects], runtimeAllowed: [...allowedEffects],
      // This validates acceptance only. Activation rechecks admission, executor availability and live authority.
      enforceableProhibitions: proposal.understanding.segments.flatMap(segment => segment.prohibitions.filter(item =>
        item.scope === 'message' && item.effectKind !== 'answer' && item.object.kind === 'workspace' && item.object.refId === session.workspaceId)) } });
  if (plan.outcome !== 'applicable') return fail('CORRECTION_SOURCE_POLICY_INVALID');
  assertBriefRevisionPlan(draft, session, source, plan);
  const segment = proposal.understanding.segments[0], step = plan.steps[0];
  if (segment.dialogueAct !== 'correction' || segment.scopeRelation !== 'same_requirement' || step.action !== 'correct_route' ||
    !step.target.workItemId || !step.target.correctionOfRoutingId || (step.effectScope.effects.length && !isIsolatedTestScope(step.effectScope)) || step.target.agentIds.length ||
    step.target.artifactIds.length || step.target.decisionIds.some(id => id !== step.correction?.supersedesDecisionId)) return fail('CORRECTION_TARGET_REQUIRED');
  const target = works.find(row => row.id === step.target.workItemId);
  if (!target) return fail('CORRECTION_TARGET_REQUIRED');
  const old = step.correction && rows<DecisionRecord>(draft, 'decisionRecordsBySession', session.id).find(row => row.id === step.correction!.supersedesDecisionId);
  if (step.correction && (!old || old.status !== 'confirmed' || old.revision !== step.correction.expectedDecisionRevision ||
    (old.workItemId !== target.id && !target.inheritedDecisionIds.includes(old.id)) ||
    !step.evidence.some(evidence => evidence.quote.includes(step.correction!.replacementText)))) return fail('CORRECTION_DECISION_STALE');
  const candidates = (snapshot.correctionCandidates ?? []).filter(candidate => candidate.routingId === step.target.correctionOfRoutingId &&
    candidate.workItemIds.includes(target.id) && (old ? candidate.decisionIds.includes(old.id) : Boolean(snapshot.replyToEventId)) &&
    (!snapshot.replyToEventId || (candidate.referenceEventId ?? candidate.sourceEventId) === snapshot.replyToEventId));
  if (candidates.length !== 1) return fail('CORRECTION_TARGET_REQUIRED');
  const candidate = candidates[0];
  const original = rows<IntentRoutingRecord>(draft, 'intentRoutingRecordsBySession', session.id).find(row => row.id === candidate.routingId);
  if (!original || original.id === source.id || original.correctionTargetRoutingId || original.sourceEventId !== candidate.sourceEventId ||
    (original.routingRevision ?? 1) !== candidate.routingRevision) return fail('CORRECTION_TARGET_STALE');
  const request: CorrectIntentRoutingInput = { contractVersion: 'intent-correction-v1', expectedRoutingRevision: candidate.routingRevision,
    idempotencyKey: `chat-correction:${source.id}`, instruction: event.content, targetWorkItemId: target.id,
    supersedesDecisionId: old?.id ?? null, expectedDecisionRevision: old?.revision ?? null };
  return { routingId: original.id, request, source, event, follow: undefined };
}
