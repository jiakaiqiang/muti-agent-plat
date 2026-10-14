import type { DeliveryRecord, DeliveryState } from '@agent-cluster/shared';

const allowed: Record<DeliveryState, readonly DeliveryState[]> = {
  idle: ['awaiting_validation_input', 'validating', 'blocked'],
  awaiting_validation_input: ['validating', 'blocked'],
  validating: ['idle', 'awaiting_validation_input', 'needs_fix', 'preparing_push',
    'resolving_conflict', 'blocked'],
  needs_fix: ['validating', 'awaiting_validation_input', 'blocked'],
  preparing_push: ['resolving_conflict', 'pushing', 'validating', 'blocked'],
  resolving_conflict: ['awaiting_validation_input', 'validating', 'blocked'],
  pushing: ['pr_open', 'awaiting_ci', 'awaiting_validation_input', 'merge_ready', 'blocked', 'resolving_conflict'],
  pr_open: ['awaiting_ci', 'merge_ready', 'validating', 'blocked'],
  awaiting_ci: ['merge_ready', 'validating', 'blocked'],
  merge_ready: ['merging', 'awaiting_ci', 'validating', 'blocked'],
  merging: ['merged', 'resolving_conflict', 'awaiting_ci', 'blocked'],
  merged: [],
  blocked: ['awaiting_validation_input', 'validating', 'preparing_push', 'pushing',
    'pr_open', 'awaiting_ci', 'merge_ready', 'merging', 'resolving_conflict']
};

export function transitionDelivery(
  current: DeliveryRecord,
  expectedVersion: number,
  target: DeliveryState,
  now: string,
  operationKey?: string
): DeliveryRecord {
  if (operationKey && current.operationKeys?.includes(operationKey)) {
    if (current.state !== target) throw new Error('GITHUB_DELIVERY_OPERATION_REUSED');
    return current;
  }
  if (current.version !== expectedVersion) throw new Error('GITHUB_DELIVERY_VERSION_CONFLICT');
  if (current.state === target) return current;
  if (!allowed[current.state].includes(target)) throw new Error('GITHUB_DELIVERY_TRANSITION_INVALID');
  return {
    ...current, state: target, version: current.version + 1, updatedAt: now,
    ...(operationKey ? { operationKeys: [...(current.operationKeys ?? []), operationKey] } : {})
  };
}
