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

test('published agent and robot-review nodes become deterministic evidence without requirement claims', () => {
  const result = evaluateWorkflowMemberMapping({
    involvedAgentIds: ['architect'],
    participatingAgentIds: [],
    findAgent: lookup,
    workflowNodes: [
      {
        id: 'design', type: 'agent', agentId: 'architect', order: 0, name: '架构设计',
        stageDescription: '定义接口边界', inputContract: [], outputContract: ['系统设计']
      },
      {
        id: 'review', type: 'robot_approval', reviewerAgentId: 'architect', order: 1, name: '架构审核',
        reviewPrompt: '检查边界是否完整', criteria: ['接口可追踪'], maxRevisionAttempts: 2, fallback: 'human_approval'
      }
    ]
  });
  assert.equal(result.status, 'mapping_required');
  if (result.status !== 'mapping_required') return;
  assert.equal(result.gaps[0].canInvite, true);
  assert.deepEqual(result.gaps[0].nodes?.map((node) => node.nodeType), ['agent', 'robot_approval']);
  assert.deepEqual(result.gaps[0].nodes?.[0].outputContract, ['系统设计']);
  assert.deepEqual(result.gaps[0].nodes?.[1].criteria, ['接口可追踪']);
  assert.match(result.gaps[0].nodes?.[1].impact ?? '', /质量审核节点无法按发布图执行/);
});
