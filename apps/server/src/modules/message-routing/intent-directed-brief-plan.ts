import { randomUUID } from 'node:crypto';
import type { TaskBrief, ValidatedRoutePlan, ValidatedRouteStep, WorkItem } from '@agent-cluster/shared';
import { deriveCorrectedBriefStep } from './intent-brief-store.service.js';

/** IDs must already be resolved from the user's exact structured assignment. */
export function deriveDirectedBriefSteps(plan: ValidatedRoutePlan, brief: TaskBrief, work: WorkItem,
  reviewerIds: readonly string[]): ValidatedRouteStep[] {
  if (!reviewerIds.length || reviewerIds.length > 8 || new Set(reviewerIds).size !== reviewerIds.length ||
    reviewerIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)) throw new Error('INTENT_BRIEF_REVIEW_TARGETS_INVALID');
  const final = deriveCorrectedBriefStep(plan, brief, work), parent = plan.steps[0];
  const reviews = reviewerIds.map((agentId, index): ValidatedRouteStep => {
    const stepId = randomUUID();
    return { ...structuredClone(final), stepId, action: 'review_brief',
      segmentKey: `${parent.segmentKey}:brief-review:${index}`, target: { ...structuredClone(final.target), agentIds: [agentId] },
      idempotencyKey: `${parent.idempotencyKey}:brief-review:${stepId}` };
  });
  // Keep server-derived physical dependencies separate from semantic segment dependencies.
  // This does not enable arbitrary multi-segment ordered_plan execution.
  final.requiredBriefReviewStepIds = reviews.map(step => step.stepId);
  return [...reviews, final];
}
