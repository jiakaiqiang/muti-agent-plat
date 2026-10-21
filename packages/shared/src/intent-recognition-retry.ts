import type { IntentRoutingRecord } from './contracts.js';

export function canRetryIntentRecognition(route: IntentRoutingRecord): boolean {
  return route.semanticContractVersion === 'intent-understanding-v1' && route.rolloutMode !== 'shadow' &&
    route.status === 'BLOCKED' && !route.semanticPlan && !route.semanticProposal?.understanding &&
    !route.dispatchHold && !route.leaseOwner && !route.effectiveIntentRevision && !route.correctionId &&
    ['auth', 'config', 'transient', 'schema', 'budget'].includes(route.failureClass ?? '');
}
