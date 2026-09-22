import assert from 'node:assert/strict';
import test from 'node:test';
import type { Delegation, DiscussionRun } from '@agent-cluster/shared';
import { synthesizeDiscussion } from './discussion-synthesis.js';

function delegation(overrides: Partial<Delegation>): Delegation {
  return {
    id: overrides.id ?? 'd',
    discussionId: 'run-1',
    sessionId: 'session-1',
    workItemId: 'wi-1',
    requirementRevision: 2,
    generation: 1,
    targetAgentId: overrides.targetAgentId ?? 'expert',
    origin: 'coordinator',
    objective: 'assess',
    expectedResult: 'conclusion',
    budgetTokens: 1_000,
    operationId: 'op',
    status: 'completed',
    revision: 1,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...overrides
  };
}

function run(delegations: Delegation[], overrides: Partial<DiscussionRun> = {}): DiscussionRun {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    workItemId: 'wi-1',
    requirementRevision: 2,
    generation: 1,
    coordinatorAgentId: 'coordinator',
    objective: 'Decide storage',
    exitCondition: 'owners assigned',
    roundLimit: 3,
    roundsStarted: 1,
    budgetTokens: 4_000,
    status: 'synthesizing',
    delegations,
    revision: 3,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...overrides
  };
}

const names = { architect: 'Architect', backend: 'Backend', security: 'Security' };

test('synthesis reads the real completed results and attributes each conclusion to its expert', () => {
  const synthesis = synthesizeDiscussion(
    run([
      delegation({ id: 'a', targetAgentId: 'architect', result: { conclusion: 'Use Postgres.', evidenceRefs: ['docs/x.md'], risks: ['migration'], openQuestions: [], suggestedActions: ['plan migration'] } }),
      delegation({ id: 'b', targetAgentId: 'backend', result: { conclusion: 'Keep the file store.', evidenceRefs: [], risks: [], openQuestions: ['retention?'], suggestedActions: [] } })
    ]),
    { agentNames: names }
  );

  assert.deepEqual(synthesis.sourceDelegationIds, ['a', 'b'], 'exactly the delegations that were read');
  assert.match(synthesis.summary, /Architect[\s\S]*Use Postgres\./);
  assert.match(synthesis.summary, /Backend[\s\S]*Keep the file store\./);
  assert.deepEqual(synthesis.unresolved, ['retention?']);
  assert.deepEqual(synthesis.risks, ['migration']);
  assert.deepEqual(synthesis.failed, []);
  assert.equal(synthesis.outcome, 'needs_user', 'an open question means the user decides');
});

test('synthesis never claims agreement the experts did not give', () => {
  const synthesis = synthesizeDiscussion(
    run([
      delegation({ id: 'a', targetAgentId: 'architect', result: { conclusion: 'Use Postgres.', evidenceRefs: [], risks: [], openQuestions: [], suggestedActions: [] } }),
      delegation({ id: 'b', targetAgentId: 'backend', result: { conclusion: 'Keep the file store.', evidenceRefs: [], risks: [], openQuestions: [], suggestedActions: [] } })
    ]),
    { agentNames: names }
  );

  assert.doesNotMatch(synthesis.summary, /一致同意|一致认为|all experts agree|consensus/i);
  // Two different conclusions with nothing else to resolve is still not
  // "ready": the user, not the synthesis, decides between them.
  assert.equal(synthesis.outcome, 'needs_user');
  assert.deepEqual(synthesis.conflicts, ['Use Postgres.', 'Keep the file store.'], 'both positions are surfaced as the choice');
});

test('stale and superseded results are excluded from the current synthesis', () => {
  const synthesis = synthesizeDiscussion(
    run([
      delegation({ id: 'old', targetAgentId: 'architect', requirementRevision: 1, stale: true, result: { conclusion: 'OLD answer', evidenceRefs: [], risks: [], openQuestions: [], suggestedActions: [] } }),
      delegation({ id: 'gone', targetAgentId: 'backend', requirementRevision: 1, status: 'superseded' }),
      delegation({ id: 'new', targetAgentId: 'architect', result: { conclusion: 'NEW answer', evidenceRefs: [], risks: [], openQuestions: [], suggestedActions: [] } })
    ]),
    { agentNames: names }
  );

  assert.deepEqual(synthesis.sourceDelegationIds, ['new']);
  assert.doesNotMatch(synthesis.summary, /OLD answer/);
  assert.match(synthesis.summary, /NEW answer/);
});

test('failed and unanswered experts are listed explicitly, not glossed over', () => {
  const synthesis = synthesizeDiscussion(
    run([
      delegation({ id: 'a', targetAgentId: 'architect', result: { conclusion: 'Use Postgres.', evidenceRefs: [], risks: [], openQuestions: [], suggestedActions: [] } }),
      delegation({ id: 'b', targetAgentId: 'backend', status: 'failed', failure: { code: 'RUNTIME_INVOCATION_ERROR', message: 'provider down', retryable: true } }),
      delegation({ id: 'c', targetAgentId: 'security', status: 'pending' })
    ]),
    { agentNames: names }
  );

  assert.deepEqual(synthesis.failed, [{ delegationId: 'b', agentName: 'Backend', code: 'RUNTIME_INVOCATION_ERROR', retryable: true }]);
  assert.deepEqual(synthesis.unanswered, [{ delegationId: 'c', agentName: 'Security', status: 'pending' }]);
  assert.match(synthesis.summary, /Backend[\s\S]*RUNTIME_INVOCATION_ERROR/);
  assert.equal(synthesis.outcome, 'needs_user');
});

test('blocked experts are attributed with their evidence gap instead of being reported as unanswered', () => {
  const synthesis = synthesizeDiscussion(
    run([
      delegation({
        id: 'b',
        targetAgentId: 'backend',
        status: 'blocked',
        failure: { code: 'CONTEXT_INSUFFICIENT', message: 'Need the migration contract.', retryable: true }
      })
    ]),
    { agentNames: names }
  );

  assert.deepEqual(synthesis.failed, []);
  assert.deepEqual(synthesis.unanswered, []);
  assert.deepEqual(synthesis.blocked, [{
    delegationId: 'b',
    agentName: 'Backend',
    code: 'CONTEXT_INSUFFICIENT',
    message: 'Need the migration contract.',
    retryable: true
  }]);
  assert.match(synthesis.summary, /Backend[\s\S]*CONTEXT_INSUFFICIENT[\s\S]*Need the migration contract/);
  assert.equal(synthesis.outcome, 'needs_user');
});

test('a single clean answer with nothing open is ready for confirmation', () => {
  const synthesis = synthesizeDiscussion(
    run([
      delegation({ id: 'a', targetAgentId: 'architect', result: { conclusion: 'Use Postgres.', evidenceRefs: ['docs/x.md'], risks: [], openQuestions: [], suggestedActions: [] } })
    ]),
    { agentNames: names }
  );

  assert.equal(synthesis.outcome, 'ready');
  assert.deepEqual(synthesis.unresolved, []);
  assert.deepEqual(synthesis.conflicts, []);
});

test('a round with no usable answers is not a synthesis', () => {
  const synthesis = synthesizeDiscussion(run([delegation({ id: 'b', targetAgentId: 'backend', status: 'failed', failure: { code: 'X', message: 'x', retryable: false } })]), { agentNames: names });
  assert.equal(synthesis.outcome, 'needs_user');
  assert.deepEqual(synthesis.sourceDelegationIds, []);
  assert.match(synthesis.summary, /没有可用的专家结论|no usable expert conclusion/i);
});
