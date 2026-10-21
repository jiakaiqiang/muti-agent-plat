import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { validateRuntimeOutput, type IntentContextSnapshot, type IntentRoutingRecord, type IntentSegment,
  type SessionDetail, type ValidatedRoutePlan } from '@agent-cluster/shared';
import { resolveIntentEffectScope, type IntentScopePolicy } from '../runtime-routing/execution-scope-resolver.service.js';
import { matchExactUserCommand } from '../intent-recognition/deterministic-command-guard.service.js';
import { resolveExactCommand } from './command-state-resolver.service.js';
import { decisionSetHash } from '../context-management/effective-decisions.js';

export type CompileRoutePlanInput = {
  session: SessionDetail;
  routing: IntentRoutingRecord;
  snapshot: IntentContextSnapshot;
  understanding: unknown;
  snapshotCurrent: boolean;
  intentRevision: number;
  requirementRevision: number;
  executionEpoch: number;
  sessionGeneration: number;
  validArtifactIds: string[];
  correctionRoutingIds: string[];
  recoverableCheckpointId?: string;
  stopConfirmed: boolean;
  scopePolicy: IntentScopePolicy;
};

/** Compiles data only. No dispatch, state mutation or model-supplied authorization. */
export function compileIntentRoutePlan(input: CompileRoutePlanInput): ValidatedRoutePlan {
  const parsed = validateRuntimeOutput('intent_understanding', input.understanding);
  const validation: ValidatedRoutePlan['validation'] = { schemaValid: parsed.valid, referencesValid: true,
    relationActionValid: true, stateValid: true, authorizationValid: true, snapshotCurrent: input.snapshotCurrent,
    errorCodes: [], validationScore: 0 };
  const plan: ValidatedRoutePlan = { planId: randomUUID(), routingId: input.routing.id,
    routingRevision: input.routing.routingRevision ?? 1, intentRevision: input.intentRevision,
    sourceEventId: input.snapshot.sourceEventId, snapshotId: input.snapshot.id,
    businessFingerprint: input.snapshot.businessFingerprint ?? input.snapshot.snapshotHash,
    policyVersion: 'intent-policy-v1', outcome: 'rejected', steps: [], validation };
  if (!parsed.valid) { validation.errorCodes = ['INTENT_SCHEMA_INVALID', ...parsed.errors]; return plan; }
  const errors = validation.errorCodes;
  if (!input.snapshotCurrent) errors.push('SNAPSHOT_STALE');
  if (input.snapshot.sessionId !== input.session.id || input.routing.sessionId !== input.session.id ||
    input.routing.sourceEventId !== input.snapshot.sourceEventId) errors.push('ROUTING_BINDING_MISMATCH');
  const understanding = parsed.value;
  if (understanding.missingFields.length || understanding.ambiguityReasons.length) errors.push('INTENT_AMBIGUOUS');
  // ordered_plan is intentionally disabled until durable steps and effect reuse pass IR11.
  if (understanding.segments.length > 1) errors.push('MULTI_SEGMENT_CONFIRMATION_REQUIRED');
  const requestedAgents = new Set(understanding.segments.flatMap(segment => segment.target.agentIds));
  if ((input.snapshot.mentionedAgentIds ?? []).some(id => !requestedAgents.has(id))) errors.push('MENTION_TARGET_DROPPED');
  if (input.snapshot.mentionedAgentIds?.length && [...requestedAgents].some(id => !input.snapshot.mentionedAgentIds!.includes(id))) {
    validation.referencesValid = false; errors.push('MENTION_TARGET_ADDED');
  }
  const agents = new Set([...(input.snapshot.mentionedAgentIds ?? []), ...input.session.participatingAgentIds]);
  for (const segment of understanding.segments) {
    const target = segment.target;
    if (!segment.evidence.length && !['clarify', 'reject_request'].includes(segment.suggestedAction)) {
      validation.referencesValid = false; errors.push('SOURCE_EVIDENCE_REQUIRED');
    }
    if ((target.workItemId && !input.snapshot.candidateWorkItemIds.includes(target.workItemId)) ||
      target.decisionIds.some(id => !input.snapshot.validDecisionIds.includes(id)) ||
      target.artifactIds.some(id => !input.validArtifactIds.includes(id)) || target.agentIds.some(id => !agents.has(id)) ||
      (target.confirmationId && target.confirmationId !== input.snapshot.pendingConfirmationContext?.confirmationId) ||
      (target.correctionOfRoutingId && !input.correctionRoutingIds.includes(target.correctionOfRoutingId))) {
      validation.referencesValid = false; errors.push('REFERENCE_OUTSIDE_SNAPSHOT');
    }
    for (const evidence of segment.evidence) {
      if (evidence.sourceEventId !== input.snapshot.sourceEventId ||
        input.snapshot.currentMessage.slice(evidence.start, evidence.end) !== evidence.quote) {
        validation.referencesValid = false; errors.push('SOURCE_EVIDENCE_INVALID');
      }
    }
    if (!validRelationAction(segment, Boolean(input.snapshot.activeWorkItemId))) {
      validation.relationActionValid = false; errors.push('RELATION_ACTION_CONFLICT');
    }
    const action = segment.suggestedAction;
    if (action === 'clarify' || segment.scopeRelation === 'ambiguous') errors.push('INTENT_AMBIGUOUS');
    if (action === 'reject_request') errors.push('REQUEST_REJECTED');
    const command = matchExactUserCommand(input.snapshot.currentMessage);
    const resolved = command ? resolveExactCommand({ command, sessionStatus: input.session.status,
      pendingConfirmation: input.snapshot.pendingConfirmationContext,
      hasFailedWorkflowRun: Boolean(input.recoverableCheckpointId) }) : undefined;
    if (['pause', 'cancel'].includes(action) && resolved?.action !== `${action}_session`) {
      validation.stateValid = false; errors.push('CONTROL_ACTION_NOT_AUTHORIZED');
    }
    if (action === 'acknowledge' && resolved?.action !== 'acknowledge') {
      validation.stateValid = false; errors.push('STATE_TRANSITION_INVALID');
    }
    if (action === 'resume' && (input.session.status !== 'PAUSED' || !input.stopConfirmed)) {
      validation.stateValid = false; errors.push('RESUME_PRECONDITION_MISSING');
    }
    if (action === 'retry_failed_step' && (!['FAILED', 'INTERRUPTED'].includes(input.session.status) ||
      !input.recoverableCheckpointId || !input.stopConfirmed)) {
      validation.stateValid = false; errors.push('RETRY_CHECKPOINT_REQUIRED');
    }
    if (['pause', 'cancel', 'resume', 'retry_failed_step'].includes(action) && target.workItemId !== input.snapshot.activeWorkItemId) {
      validation.stateValid = false; errors.push('CONTROL_TARGET_NOT_ACTIVE');
    }
    if (action === 'resolve_confirmation') errors.push('STRUCTURED_CONFIRMATION_REQUIRED');
    if (action === 'correct_route' && !target.correctionOfRoutingId && !segment.correction) errors.push('CORRECTION_TARGET_REQUIRED');
    if (segment.correction) {
      const old = input.snapshot.validDecisions.find(item => item.id === segment.correction!.supersedesDecisionId);
      if (!old || old.revision !== segment.correction.expectedDecisionRevision) errors.push('CORRECTION_DECISION_STALE');
    }
    if (segment.dialogueAct === 'question' && segment.requestedEffects.some(effect => !['answer', 'read_workspace'].includes(effect.kind))) {
      validation.authorizationValid = false; errors.push('QUESTION_EFFECT_CONFLICT');
    }
    if (segment.dialogueAct === 'constraint' && ['resume', 'retry_failed_step'].includes(action)) {
      validation.stateValid = false; errors.push('CONSTRAINT_CANNOT_RESUME');
    }
    const effective = resolveIntentEffectScope(segment, input.scopePolicy);
    if (effective.errors.length) validation.authorizationValid = false;
    errors.push(...effective.errors);
    const segmentId = randomUUID();
    // One question may address several agents. These independent answers are not
    // ordered multi-intent execution; retain the original segment and every target.
    const answerTargets = action === 'answer_in_chat' && target.agentIds.length ? target.agentIds.map(id => [id]) : [target.agentIds];
    for (const agentIds of answerTargets) {
      const stepId = randomUUID();
      plan.steps.push({ stepId, segmentId, segmentKey: segment.localKey, action, goal: segment.goal,
        target: { ...structuredClone(target), agentIds: [...agentIds] }, contextPolicy: segment.contextPolicy, correction: structuredClone(segment.correction),
        dependencies: structuredClone(segment.dependencies), evidence: structuredClone(segment.evidence),
        expectedSessionStatus: input.session.status, effectScope: effective.scope,
        executionBinding: { routingId: input.routing.id, intentRevision: input.intentRevision,
          requirementRevision: input.requirementRevision, executionEpoch: input.executionEpoch,
          sessionGeneration: input.sessionGeneration, effectScopeHash: effective.scope.scopeHash,
          decisionSetHash: decisionSetHash(segment.contextPolicy === 'clean_task_context' ? [] :
            segment.contextPolicy === 'inherit_selected' ? input.snapshot.validDecisions.filter(row => target.decisionIds.includes(row.id)) : input.snapshot.validDecisions) },
        idempotencyKey: `${input.session.id}:${input.snapshot.sourceEventId}:${input.intentRevision}:${segmentId}:${stepId}` });
    }
  }
  validation.errorCodes = [...new Set(errors)];
  validation.validationScore = Math.max(0, 1 - validation.errorCodes.length * 0.1);
  plan.outcome = !validation.errorCodes.length ? 'applicable'
    : validation.errorCodes.some(code => ['PROHIBITION_NOT_ENFORCEABLE', 'EFFECT_CAPABILITY_UNAVAILABLE'].includes(code)) ? 'blocked'
    : !validation.referencesValid || errors.includes('ROUTING_BINDING_MISMATCH') || errors.includes('REQUEST_REJECTED') ? 'rejected' : 'needs_clarification';
  return plan;
}

function validRelationAction(segment: IntentSegment, hasActive: boolean) {
  const { scopeRelation: relation, contextPolicy: policy, target, suggestedAction: action } = segment;
  const clean = !target.decisionIds.length && !target.artifactIds.length;
  if (relation === 'initial_requirement') return action === 'create_initial_work_item' && !hasActive && !target.workItemId && clean && policy === 'clean_task_context';
  if (relation === 'session_context') return ['answer_in_chat', 'record_information', 'clarify', 'reject_request'].includes(action) &&
    !target.workItemId && clean && ['clean_task_context', 'ask_user'].includes(policy);
  if (relation === 'independent_new_requirement') return action === 'create_independent_work_item' && !target.workItemId && clean && policy === 'clean_task_context';
  if (relation === 'related_new_requirement') return action === 'create_related_work_item' && Boolean(target.workItemId) && policy === 'inherit_selected';
  if (relation === 'ambiguous') return ['clarify', 'reject_request'].includes(action) && policy === 'ask_user';
  return Boolean(target.workItemId) && !action.startsWith('create_') && ['inherit_confirmed', 'inherit_selected'].includes(policy);
}

@Injectable()
export class RoutePlanCompilerService {
  compile(input: CompileRoutePlanInput) { return compileIntentRoutePlan(input); }
}
