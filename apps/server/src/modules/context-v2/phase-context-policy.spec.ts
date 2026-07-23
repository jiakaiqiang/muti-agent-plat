import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedLayersForPhase, isLayerAllowedInPhase } from './phase-context-policy.js';

test('discussion phase keeps grounded Evidence but omits Tool Results and Delivery layers', () => {
  const layers = allowedLayersForPhase('discussion');
  assert.deepEqual([...layers], ['L0', 'L1', 'L2', 'L3', 'L5']);
  assert.equal(isLayerAllowedInPhase('discussion', 'L3'), true);
  assert.equal(isLayerAllowedInPhase('discussion', 'L4'), false);
  assert.equal(isLayerAllowedInPhase('discussion', 'L6'), false);
});

test('execution phase adds Evidence and Tool Results but not Delivery yet', () => {
  const layers = allowedLayersForPhase('execution');
  assert.deepEqual([...layers], ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
  assert.equal(isLayerAllowedInPhase('execution', 'L3'), true);
  assert.equal(isLayerAllowedInPhase('execution', 'L4'), true);
  assert.equal(isLayerAllowedInPhase('execution', 'L6'), false);
});

test('post_review phase unlocks Delivery Artifacts on top of execution layers', () => {
  const layers = allowedLayersForPhase('post_review');
  assert.deepEqual([...layers], ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
  assert.equal(isLayerAllowedInPhase('post_review', 'L6'), true);
});

test('delivery phase keeps grounded Evidence with Identity and Delivery Artifacts', () => {
  const layers = allowedLayersForPhase('delivery');
  assert.deepEqual([...layers], ['L0', 'L1', 'L3', 'L6']);
  assert.equal(isLayerAllowedInPhase('delivery', 'L1'), true);
  assert.equal(isLayerAllowedInPhase('delivery', 'L3'), true);
});
