import assert from 'node:assert/strict';
import test from 'node:test';
import { requiresGroundedRuntimeEvidence } from './grounded-evidence-gate.js';

for (const phase of [
  'discussion',
  'brief_generation',
  'brief_revision',
  'task_acceptance',
  'post_review',
  'final_delivery',
  'user_message_routing'
] as const) {
  test(`${phase} does not require L3 merely because the eventual task changes code`, () => {
    assert.equal(requiresGroundedRuntimeEvidence(phase, true, 'mixed_minimal'), false);
  });
}

test('task_execution code changes require grounded L3 evidence', () => {
  assert.equal(requiresGroundedRuntimeEvidence('task_execution', true, 'mixed_minimal'), true);
});

test('architecture analysis requires grounded evidence in every phase', () => {
  assert.equal(requiresGroundedRuntimeEvidence('brief_generation', false, 'architecture_analysis'), true);
});

test('non-coding task execution does not require L3 evidence by default', () => {
  assert.equal(requiresGroundedRuntimeEvidence('task_execution', false, 'non_coding_minimal'), false);
});
