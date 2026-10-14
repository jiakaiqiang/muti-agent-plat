import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeliveryRecord } from '@agent-cluster/shared';
import { transitionDelivery } from './delivery-state.js';

const current: DeliveryRecord = {
  sessionId: 'session-a', round: 1, state: 'awaiting_validation_input', version: 3,
  baseBranch: 'main', createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z'
};

test('delivery transitions require the current version and a legal edge', () => {
  const validating = transitionDelivery(current, 3, 'validating', '2026-09-28T00:01:00.000Z');
  assert.equal(validating.version, 4);
  assert.equal(validating.state, 'validating');
  assert.throws(() => transitionDelivery(validating, 3, 'needs_fix', '2026-09-28T00:02:00.000Z'),
    /GITHUB_DELIVERY_VERSION_CONFLICT/);
  assert.throws(() => transitionDelivery(current, 3, 'merged', '2026-09-28T00:02:00.000Z'),
    /GITHUB_DELIVERY_TRANSITION_INVALID/);
});

test('operation keys make retries idempotent without accepting a changed target', () => {
  const validating = transitionDelivery(current, 3, 'validating',
    '2026-09-28T00:01:00.000Z', 'validate:one');
  assert.deepEqual(transitionDelivery(validating, 3, 'validating',
    '2026-09-28T00:02:00.000Z', 'validate:one'), validating);
  assert.throws(() => transitionDelivery(validating, 4, 'pushing',
    '2026-09-28T00:02:00.000Z', 'validate:one'), /GITHUB_DELIVERY_OPERATION_REUSED/);
});

test('conflict resolution must validate again before pushing', () => {
  const conflict = { ...current, state: 'resolving_conflict' as const };
  assert.throws(() => transitionDelivery(conflict, 3, 'pushing', '2026-09-28T00:01:00.000Z'),
    /GITHUB_DELIVERY_TRANSITION_INVALID/);
  assert.equal(transitionDelivery(conflict, 3, 'validating', '2026-09-28T00:01:00.000Z').state,
    'validating');
});
