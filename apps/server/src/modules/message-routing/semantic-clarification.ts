import { ConflictException } from '@nestjs/common';
import type { ClarifyIntentRoutingInput, CollaborationEvent, IntentContextSnapshot, IntentRoutingRecord,
  IntentUnderstandingOutput, SessionDetail } from '@agent-cluster/shared';

export function semanticClarificationCard(session: SessionDetail, route: IntentRoutingRecord, snapshot: IntentContextSnapshot,
  understanding: IntentUnderstandingOutput): CollaborationEvent | undefined {
  // A relation choice cannot resolve a correction target or collapse multiple goals into one.
  if (understanding.segments.length !== 1 || understanding.segments[0].dialogueAct === 'correction' ||
    !['INTENT_AMBIGUOUS', 'INTENT_MISSING_FIELDS', 'RELATION_ACTION_CONFLICT'].some(code => route.semanticPlan?.validation.errorCodes.includes(code))) return;
  const active = snapshot.activeWorkItemId, now = new Date().toISOString();
  const selected = understanding.segments[0].target;
  const inheritedDecisionIds = active ? selected.decisionIds.filter(id => snapshot.validDecisionIds.includes(id)) : [];
  const inheritedArtifactIds = active ? selected.artifactIds.filter(id => snapshot.validArtifactIds?.includes(id)) : [];
  const inheritanceSummary = inheritedDecisionIds.length || inheritedArtifactIds.length
    ? `相关任务将继承已列出的 ${inheritedDecisionIds.length} 条约束和 ${inheritedArtifactIds.length} 个产物：${[
      ...snapshot.validDecisions.filter(row => inheritedDecisionIds.includes(row.id)).map(row => row.content.slice(0, 160)), ...inheritedArtifactIds].join('；')}`
    : '相关任务不继承旧约束或产物。';
  const options = [...(active ? [{ key: 'continue_current', label: '属于当前任务' }, { key: 'related_new', label: '创建相关任务' }] : []),
    { key: 'independent_new', label: '创建独立任务' }];
  return { id: `semantic-clarification:${route.id}:${route.routingRevision}`, sessionId: session.id,
    type: 'intent_clarification_required', actor: { type: 'system', id: 'intent-plan' }, toAgentIds: [], createdAt: now,
    content: '请确认这条消息与现有任务的关系。选择关系不会授予执行权限。',
    metadata: { schemaVersion: '0.1', renderAs: 'confirmation_card', payload: {
      confirmationId: `semantic-clarification:${route.id}:${route.routingRevision}`, confirmationType: 'intent_routing',
      reason: 'intent_relation_clarification', routingId: route.id, routingRevision: route.routingRevision, status: 'pending', options,
      dataEpoch: session.dataEpoch, sessionGeneration: route.semanticProposal?.sessionGeneration, activeWorkItemId: active,
      inheritedDecisionIds, inheritedArtifactIds, inheritanceSummary,
      title: '确认任务关系', description: `${understanding.segments[0].goal}\n${inheritanceSummary}`, sourceEventId: route.sourceEventId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() } } };
}

export function assertSemanticClarificationChoice(input: ClarifyIntentRoutingInput, card: CollaborationEvent, output: IntentUnderstandingOutput) {
  if (output.segments.length !== 1) throw new ConflictException('CLARIFICATION_MULTIPLE_GOALS_REQUIRE_CONFIRMATION');
  const segment = output.segments[0], payload = card.metadata.payload;
  const equalIds = (values: readonly string[], key: string) => JSON.stringify([...values].sort()) ===
    JSON.stringify(Array.isArray(payload?.[key]) ? [...payload[key] as string[]].sort() : []);
  if (segment.target.agentIds.length || segment.correction || segment.target.correctionOfRoutingId || segment.target.confirmationId) {
    throw new ConflictException('CLARIFICATION_CHOICE_PLAN_MISMATCH');
  }
  if (input.choice === 'continue_current') {
    if (segment.scopeRelation !== 'same_requirement' || segment.contextPolicy !== 'inherit_confirmed' ||
      segment.target.workItemId !== payload?.activeWorkItemId ||
      !['answer_in_chat', 'record_information', 'record_constraint', 'enqueue_follow_up', 'clarify', 'reject_request'].includes(segment.suggestedAction)) {
      throw new ConflictException('CLARIFICATION_CHOICE_PLAN_MISMATCH');
    }
  } else if (input.choice === 'related_new') {
    if (segment.scopeRelation !== 'related_new_requirement' || segment.contextPolicy !== 'inherit_selected' ||
      segment.suggestedAction !== 'create_related_work_item' || segment.target.workItemId !== payload?.activeWorkItemId ||
      !equalIds(segment.target.decisionIds, 'inheritedDecisionIds') || !equalIds(segment.target.artifactIds, 'inheritedArtifactIds')) {
      throw new ConflictException('CLARIFICATION_CHOICE_PLAN_MISMATCH');
    }
  } else if (!['independent_new_requirement', ...(!payload?.activeWorkItemId ? ['initial_requirement'] : [])].includes(segment.scopeRelation) ||
    !['create_independent_work_item', ...(!payload?.activeWorkItemId ? ['create_initial_work_item'] : [])].includes(segment.suggestedAction) ||
    segment.contextPolicy !== 'clean_task_context' || segment.target.workItemId || segment.target.decisionIds.length || segment.target.artifactIds.length) {
    throw new ConflictException('CLARIFICATION_CHOICE_PLAN_MISMATCH');
  }
}
