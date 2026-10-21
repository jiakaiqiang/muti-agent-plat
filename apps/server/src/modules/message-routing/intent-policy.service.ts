import { Injectable } from '@nestjs/common';
import type {
  IntentContextSnapshot, IntentRoutingDecisionV2, IntentRoutingValidation, SessionDetail
} from '@agent-cluster/shared';
import { matchExactUserCommand } from '../intent-recognition/deterministic-command-guard.service.js';
import { resolveExactCommand } from './command-state-resolver.service.js';

export type IntentPolicyInput = {
  session: SessionDetail;
  snapshot: IntentContextSnapshot;
  decision: IntentRoutingDecisionV2;
  snapshotCurrent: boolean;
  inheritedArtifactIds: string[];
};

/** Pure policy shared by classification and the durable application boundary. */
export function validateIntentRoutingDecision(input: IntentPolicyInput): IntentRoutingValidation {
  const { session, snapshot, decision } = input;
  const errors: string[] = [];
  const referencesValid =
    (!decision.selectedWorkItemId || snapshot.candidateWorkItemIds.includes(decision.selectedWorkItemId)) &&
    decision.selectedDecisionIds.every(id => snapshot.validDecisionIds.includes(id)) &&
    decision.selectedArtifactIds.every(id => input.inheritedArtifactIds.includes(id));
  if (!referencesValid) errors.push('REFERENCE_OUTSIDE_SNAPSHOT');

  const mentioned = snapshot.mentionedAgentIds ?? [];
  const requested = decision.requestedAgentIds ?? [];
  if (mentioned.some(id => !requested.includes(id))) errors.push('MENTION_TARGET_DROPPED');
  const addressable = new Set([...mentioned, ...session.participatingAgentIds]);
  if (requested.some(id => !addressable.has(id))) errors.push('AGENT_TARGET_OUTSIDE_SNAPSHOT');
  if (snapshot.recall?.needsClarification && decision.selectedWorkItemId &&
    decision.selectedWorkItemId !== snapshot.activeWorkItemId &&
    snapshot.recall.candidates.some(item => item.workItemId === decision.selectedWorkItemId)) {
    errors.push('HISTORICAL_RECALL_AMBIGUOUS');
  }
  if (!input.snapshotCurrent) errors.push('SNAPSHOT_STALE');
  const action = decision.requestedAction;
  let relationActionValid = true;
  if (action !== 'clarify') {
    if (decision.scopeRelation === 'independent_new_requirement') {
      relationActionValid = action === 'create_independent_work_item' &&
        decision.contextPolicy === 'clean_task_context' && !decision.selectedDecisionIds.length &&
        !decision.selectedArtifactIds.length;
    } else if (decision.scopeRelation === 'related_new_requirement') {
      relationActionValid = action === 'create_related_work_item' &&
        decision.contextPolicy === 'inherit_selected' && Boolean(decision.selectedWorkItemId);
    } else if (decision.scopeRelation === 'same_requirement') {
      relationActionValid = !['create_independent_work_item', 'create_related_work_item'].includes(action) &&
        ['inherit_confirmed', 'inherit_selected'].includes(decision.contextPolicy);
    } else relationActionValid = false;
  }
  if (!relationActionValid) errors.push('RELATION_ACTION_CONFLICT');

  const command = matchExactUserCommand(snapshot.currentMessage);
  const resolution = command ? resolveExactCommand({ command, sessionStatus: session.status,
    pendingConfirmation: snapshot.pendingConfirmationContext,
    hasFailedWorkflowRun: Boolean(snapshot.failureCheckpoint) }) : undefined;
  let transitionValid = true;
  if (['continue_active_work_item', 'resume', 'replan', 'pause', 'cancel'].includes(action) &&
    !snapshot.activeWorkItemId) transitionValid = false;
  if (action === 'resume' && !['FAILED', 'INTERRUPTED', 'PAUSED', 'WAIT_USER_DECISION'].includes(session.status)) {
    transitionValid = false;
  }
  if (action === 'pause' || action === 'cancel') {
    const authorized = command?.command === action &&
      resolution?.action === (action === 'pause' ? 'pause_session' : 'cancel_session');
    if (!authorized) errors.push('CONTROL_ACTION_NOT_AUTHORIZED');
    if (command?.command === action && !authorized) transitionValid = false;
  }
  if (command && ['resume', 'retry'].includes(command.command) && action !== 'clarify' &&
    resolution?.action === 'clarify') transitionValid = false;
  if (action === 'confirm' || action === 'reject') errors.push('CONFIRMATION_TARGET_REQUIRED');
  if (!transitionValid) errors.push('STATE_TRANSITION_INVALID');
  if (decision.missingFields.length) errors.push('REQUIRED_FIELDS_MISSING');
  if (decision.scopeRelation === 'ambiguous' || decision.ambiguityReasons.length) errors.push('INTENT_AMBIGUOUS');
  const authorizedExactControl = (action === 'pause' && resolution?.action === 'pause_session') ||
    (action === 'cancel' && resolution?.action === 'cancel_session');
  if (decision.riskLevel === 'high' && !authorizedExactControl) errors.push('HIGH_RISK_REQUIRES_CONFIRMATION');
  const validationScore = Math.max(0, 1 - errors.length * 0.25);
  return {
    schemaValid: true, referencesValid, transitionValid, snapshotCurrent: input.snapshotCurrent,
    safeToApply: errors.length === 0, serverConfidence: validationScore, validationScore,
    errors: [...new Set(errors)]
  };
}

export function deterministicIntentDecision(
  session: SessionDetail, snapshot: IntentContextSnapshot
): IntentRoutingDecisionV2 | undefined {
  const command = matchExactUserCommand(snapshot.currentMessage);
  if (!command) return undefined;
  const resolution = resolveExactCommand({ command, sessionStatus: session.status,
    pendingConfirmation: snapshot.pendingConfirmationContext,
    hasFailedWorkflowRun: Boolean(snapshot.failureCheckpoint) });
  const active = snapshot.activeWorkItemId;
  const needsClarification = resolution.action === 'clarify' || !active;
  const action: IntentRoutingDecisionV2['requestedAction'] = needsClarification ? 'clarify'
    : resolution.action === 'pause_session' ? 'pause'
    : resolution.action === 'cancel_session' ? 'cancel'
    : ['resume_session', 'retry_current'].includes(resolution.action) ? 'resume'
    : 'continue_active_work_item';
  return {
    dialogueAct: 'command', scopeRelation: needsClarification ? 'ambiguous' : 'same_requirement',
    contextPolicy: needsClarification ? 'ask_user' : 'inherit_confirmed', requestedAction: action,
    selectedWorkItemId: active, selectedDecisionIds: snapshot.validDecisionIds, selectedArtifactIds: [],
    requestedAgentIds: snapshot.mentionedAgentIds ?? [], goalSegments: [], missingFields: [],
    ambiguityReasons: needsClarification ? [active ? 'COMMAND_STATE_REQUIRES_CLARIFICATION' : 'NO_ACTIVE_WORK_ITEM'] : [],
    reasonCodes: [command.reasonCode, ...(resolution.action === 'acknowledge' ? ['ACKNOWLEDGE_RUNNING'] : [])],
    riskLevel: action === 'cancel' ? 'high' : 'low'
  };
}

@Injectable()
export class IntentPolicyService {
  validate(input: IntentPolicyInput) { return validateIntentRoutingDecision(input); }
}
