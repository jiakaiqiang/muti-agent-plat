import type { IntentRoutingRecord } from './contracts.js';

/** Only permissions/capability failures can reuse semantic evidence unchanged. */
export function canRetryIntentAuthorization(route: IntentRoutingRecord): boolean {
  const plan = route.semanticPlan;
  return route.rolloutMode !== 'shadow' && !route.dispatchHold && !route.effectiveIntentRevision &&
    ['CLARIFICATION_REQUIRED', 'BLOCKED'].includes(route.status) && Boolean(route.semanticProposal?.understanding) &&
    Boolean(plan && plan.outcome !== 'applicable' && plan.validation.errorCodes.length &&
      plan.validation.errorCodes.every(code => ['EFFECT_NOT_AUTHORIZED', 'EFFECT_CAPABILITY_UNAVAILABLE'].includes(code)));
}
