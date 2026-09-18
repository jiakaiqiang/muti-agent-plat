import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiscussionPlanOutput } from '@agent-cluster/shared';
import { resolveDiscussionPlan } from './discussion-planner.js';

const plan = (overrides: Partial<DiscussionPlanOutput> = {}): DiscussionPlanOutput => ({
  schemaVersion: '1.0',
  kind: 'discussion_plan',
  objective: '决定存储方案。',
  gaps: ['迁移成本未知'],
  exitCondition: '未决问题都有负责人。',
  consultations: [{ targetAgentKey: 'architect', objective: '评估迁移成本。', expectedResult: '风险与建议。' }],
  questionsForUser: [],
  readyToSummarize: false,
  ...overrides
});

const context = {
  coordinatorAgentId: 'agent-coordinator',
  participants: [
    { id: 'agent-coordinator', key: 'coordinator' },
    { id: 'agent-architect', key: 'architect' },
    { id: 'agent-backend', key: 'backend' }
  ],
  catalog: [
    { id: 'agent-coordinator', key: 'coordinator' },
    { id: 'agent-architect', key: 'architect' },
    { id: 'agent-backend', key: 'backend' },
    { id: 'agent-security', key: 'security' }
  ],
  budgetPerConsultationTokens: 4_000
};

test('a consultation aimed at a current participant becomes a delegation', () => {
  const resolved = resolveDiscussionPlan(plan(), context);
  assert.equal(resolved.status, 'resolved');
  if (resolved.status !== 'resolved') return;
  assert.deepEqual(
    resolved.delegations.map((item) => item.targetAgentId),
    ['agent-architect']
  );
  assert.equal(resolved.delegations[0]?.budgetTokens, 4_000);
  assert.equal(resolved.delegations[0]?.origin, 'coordinator');
});

test('a known agent who is not a participant needs the user, and is not added by the model', () => {
  // AC3: the model may propose a member, the user approves it. Until then no
  // delegation exists for that agent.
  const resolved = resolveDiscussionPlan(
    plan({ consultations: [{ targetAgentKey: 'security', objective: '审查权限模型。', expectedResult: '风险清单。' }] }),
    context
  );
  assert.equal(resolved.status, 'resolved');
  if (resolved.status !== 'resolved') return;
  assert.deepEqual(resolved.delegations, []);
  assert.deepEqual(resolved.memberAdditions, [
    { targetAgentKey: 'security', targetAgentId: 'agent-security', objective: '审查权限模型。', expectedResult: '风险清单。' }
  ]);
});

test('a name that exists nowhere is reported, never invented into a member', () => {
  const resolved = resolveDiscussionPlan(
    plan({ consultations: [{ targetAgentKey: 'data-scientist', objective: 'x', expectedResult: 'y' }] }),
    context
  );
  assert.equal(resolved.status, 'resolved');
  if (resolved.status !== 'resolved') return;
  assert.deepEqual(resolved.unknownTargets, ['data-scientist']);
  assert.deepEqual(resolved.memberAdditions, []);
});

test('the coordinator cannot delegate to itself', () => {
  const resolved = resolveDiscussionPlan(
    plan({ consultations: [{ targetAgentKey: 'coordinator', objective: 'x', expectedResult: 'y' }] }),
    context
  );
  assert.equal(resolved.status, 'resolved');
  if (resolved.status !== 'resolved') return;
  assert.deepEqual(resolved.delegations, []);
  assert.deepEqual(resolved.dropped, [{ targetAgentKey: 'coordinator', reason: 'self_consultation' }]);
});

test('the same expert asked twice in one plan is one delegation', () => {
  const resolved = resolveDiscussionPlan(
    plan({
      consultations: [
        { targetAgentKey: 'architect', objective: 'first', expectedResult: 'a' },
        { targetAgentKey: 'architect', objective: 'second', expectedResult: 'b' }
      ]
    }),
    context
  );
  assert.equal(resolved.status, 'resolved');
  if (resolved.status !== 'resolved') return;
  assert.equal(resolved.delegations.length, 1);
  assert.deepEqual(resolved.dropped, [{ targetAgentKey: 'architect', reason: 'duplicate_target' }]);
});

test('a plan that asks nobody, asks the user nothing and is not ready is not a plan', () => {
  // AC1: the coordinator must state what it needs. An empty round would spin
  // the budget with no way to end.
  const resolved = resolveDiscussionPlan(
    plan({ consultations: [], questionsForUser: [], readyToSummarize: false }),
    context
  );
  assert.equal(resolved.status, 'invalid');
  if (resolved.status !== 'invalid') return;
  assert.equal(resolved.code, 'DISCUSSION_PLAN_EMPTY');
});

test('a plan that only asks the user is valid and yields no delegations', () => {
  const resolved = resolveDiscussionPlan(
    plan({ consultations: [], questionsForUser: ['需要保留多久？'], readyToSummarize: false }),
    context
  );
  assert.equal(resolved.status, 'resolved');
  if (resolved.status !== 'resolved') return;
  assert.deepEqual(resolved.delegations, []);
  assert.deepEqual(resolved.questionsForUser, ['需要保留多久？']);
});

test('a plan whose only targets need approval is still resolved, with nothing to run yet', () => {
  const resolved = resolveDiscussionPlan(
    plan({ consultations: [{ targetAgentKey: 'security', objective: 'x', expectedResult: 'y' }] }),
    context
  );
  assert.equal(resolved.status, 'resolved');
  if (resolved.status !== 'resolved') return;
  assert.equal(resolved.delegations.length, 0);
  assert.equal(resolved.memberAdditions.length, 1);
});
