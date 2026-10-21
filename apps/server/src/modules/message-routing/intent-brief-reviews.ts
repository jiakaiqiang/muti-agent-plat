import { isDeepStrictEqual } from 'node:util';
import type { IntentPlanStepRecord, IntentRouteRevision } from '@agent-cluster/shared';

/** A sibling's progress must not hide an unresolved failure in the same version. */
export function hasFailedBriefStep(records: IntentPlanStepRecord[], routingId: string, intentRevision: number) {
  return records.some(row => row.routingId === routingId && row.intentRevision === intentRevision &&
    ['prepare_brief', 'review_brief'].includes(row.step.action) && ['failed', 'invalidated', 'reconciliation_required'].includes(row.status));
}

/** Return all version-bound opinions in user assignment order, never a partial set. */
export function completedBriefReviews(final: IntentPlanStepRecord, records: IntentPlanStepRecord[], version: IntentRouteRevision) {
  const ids = final.step.requiredBriefReviewStepIds ?? [];
  const planned = version.validatedPlan?.steps.filter(step => step.action === 'review_brief' && step.derivedFromStepId === final.step.derivedFromStepId) ?? [];
  if (!ids.length && !planned.length) return [];
  if (ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length || planned.length !== ids.length ||
    planned.some(step => !ids.includes(step.stepId)) || final.step.action !== 'prepare_brief' ||
    version.routingId !== final.routingId || version.intentRevision !== final.intentRevision || version.dataEpoch !== final.dataEpoch ||
    !version.validatedPlan?.steps.some(step => isDeepStrictEqual(step, final.step))) throw new Error('INTENT_BRIEF_REVIEW_DEPENDENCIES_INVALID');
  const agents = new Set<string>();
  return ids.map(id => {
    const record = records.find(row => row.id === id), plan = planned.find(row => row.stepId === id), result = record?.processing?.result;
    if (!record || !plan || !isDeepStrictEqual(record.step, plan) || record.sessionId !== final.sessionId ||
      record.dataEpoch !== final.dataEpoch || record.routingId !== final.routingId || record.intentRevision !== final.intentRevision ||
      record.step.target.workItemId !== final.step.target.workItemId || record.step.target.agentIds.length !== 1 ||
      !isDeepStrictEqual(record.step.executionBinding, final.step.executionBinding) ||
      !isDeepStrictEqual(record.step.replacesBrief, final.step.replacesBrief) || record.step.effectScope.effects.length ||
      record.step.requiredBriefReviewStepIds?.length) throw new Error('INTENT_BRIEF_REVIEW_BINDING_INVALID');
    const agentId = record.step.target.agentIds[0];
    if (agents.has(agentId)) throw new Error('INTENT_BRIEF_REVIEW_DEPENDENCIES_INVALID');
    agents.add(agentId);
    if (record.status !== 'completed' || !record.responseEventId || !result || result.agentId !== agentId ||
      !result.invocationId || result.invocationId !== record.processing?.invocationId ||
      typeof result.content !== 'string' || !result.content.trim() || Buffer.byteLength(result.content, 'utf8') > 32000) {
      throw new Error('INTENT_BRIEF_REVIEWS_INCOMPLETE');
    }
    return { stepId: id, agentId, invocationId: result.invocationId, responseEventId: record.responseEventId, content: result.content };
  });
}
