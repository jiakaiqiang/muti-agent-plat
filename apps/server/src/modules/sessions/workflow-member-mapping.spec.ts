import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateWorkflowMemberMapping } from './workflow-member-mapping.js';

const catalog = {
  coordinator: { id: 'coordinator', key: 'coordinator', name: 'Coordinator', status: 'active' as const },
  backend: { id: 'backend', key: 'backend', name: 'Backend', status: 'active' as const },
  architect: { id: 'architect', key: 'architect', name: 'Architect', status: 'active' as const },
  retired: { id: 'retired', key: 'retired', name: 'Retired', status: 'disabled' as const }
};
const lookup = (id: string) => catalog[id as keyof typeof catalog];

test('a workflow whose agents are all participating maps cleanly', () => {
  const result = evaluateWorkflowMemberMapping({
    involvedAgentIds: ['coordinator', 'backend'],
    participatingAgentIds: ['coordinator', 'backend'],
    findAgent: lookup
  });
  assert.deepEqual(result, { status: 'ready' });
});

test('an involved agent outside the session needs the user, not a silent merge', () => {
  const result = evaluateWorkflowMemberMapping({
    involvedAgentIds: ['coordinator', 'backend', 'architect'],
    participatingAgentIds: ['coordinator', 'backend'],
    findAgent: lookup
  });
  assert.equal(result.status, 'mapping_required');
  if (result.status !== 'mapping_required') return;
  assert.deepEqual(result.gaps, [{ agentId: 'architect', agentName: 'Architect', reason: 'not_participating' }]);
});

test('a disabled or unknown agent cannot be fixed by adding it and is reported as such', () => {
  const result = evaluateWorkflowMemberMapping({
    involvedAgentIds: ['coordinator', 'retired', 'ghost'],
    participatingAgentIds: ['coordinator'],
    findAgent: lookup
  });
  assert.equal(result.status, 'mapping_required');
  if (result.status !== 'mapping_required') return;
  assert.deepEqual(result.gaps, [
    { agentId: 'retired', agentName: 'Retired', reason: 'disabled' },
    { agentId: 'ghost', agentName: 'ghost', reason: 'unknown' }
  ]);
  assert.equal(result.addable.length, 0, 'nothing here can be resolved by inviting');
});

test('addable gaps are the ones the user can resolve by inviting', () => {
  const result = evaluateWorkflowMemberMapping({
    involvedAgentIds: ['architect', 'retired'],
    participatingAgentIds: [],
    findAgent: lookup
  });
  if (result.status !== 'mapping_required') return;
  assert.deepEqual(result.addable, ['architect']);
});
