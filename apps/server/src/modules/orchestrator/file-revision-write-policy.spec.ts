import assert from 'node:assert/strict';
import test from 'node:test';
import type { InvocationPlan } from '@agent-cluster/shared';
import { applyRuntimeWriteModeOverride } from './runtime-write-mode-policy.js';

function fixture(): InvocationPlan {
  return {
    executionTarget: { writeMode: 'direct' },
    toolCatalog: {
      tools: [
        { name: 'read_file' },
        { name: 'write_file' },
        { name: 'run_test' }
      ],
      decisions: [
        { toolId: 'read', toolKey: 'read_file', status: 'allowed', reasons: [] },
        { toolId: 'write', toolKey: 'write_file', status: 'allowed', reasons: ['PROFILE_ALLOWED'] },
        { toolId: 'cap-command-run', toolKey: 'tool.command_run', status: 'allowed', reasons: ['PROFILE_ALLOWED'] }
      ],
      catalogHash: 'before'
    },
    contextEnvelope: { L0: { toolCatalogHash: 'before' } }
    ,pendingApprovals: [
      { toolId: 'write', toolKey: 'write_file', approvalId: 'approval-write', reasons: ['USER_APPROVAL_REQUIRED'] },
      { toolId: 'cap-command-run', toolKey: 'tool.command_run', approvalId: 'approval-command', reasons: ['USER_APPROVAL_REQUIRED'] }
    ]
  } as unknown as InvocationPlan;
}

test('proposal_only keeps only read tools and keeps the resolved catalog hash consistent with L0', () => {
  const plan = applyRuntimeWriteModeOverride(fixture(), 'proposal_only');

  assert.equal(plan.executionTarget.writeMode, 'proposal_only');
  assert.deepEqual(plan.toolCatalog.tools.map((tool) => tool.name), ['read_file']);
  assert.equal(plan.toolCatalog.decisions[1]?.status, 'blocked');
  assert.ok(plan.toolCatalog.decisions[1]?.reasons.includes('FILE_REVISION_PROPOSAL_ONLY'));
  assert.equal(plan.toolCatalog.decisions[2]?.status, 'blocked');
  assert.ok(plan.toolCatalog.decisions[2]?.reasons.includes('FILE_REVISION_PROPOSAL_ONLY'));
  assert.notEqual(plan.toolCatalog.catalogHash, 'before');
  assert.equal(plan.contextEnvelope.L0.toolCatalogHash, plan.toolCatalog.catalogHash);
  assert.deepEqual(plan.pendingApprovals, []);
});

test('non-proposal overrides preserve the resolved catalog', () => {
  const original = fixture();
  const plan = applyRuntimeWriteModeOverride(original, 'propose_changes');

  assert.equal(plan.executionTarget.writeMode, 'propose_changes');
  assert.equal(plan.toolCatalog, original.toolCatalog);
  assert.equal(plan.contextEnvelope, original.contextEnvelope);
});
