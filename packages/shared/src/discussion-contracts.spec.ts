import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCUSSION_CONTRACT_VERSION,
  canTransitionDelegation,
  canTransitionDiscussion,
  delegationLogicalKey,
  delegationsToRun,
  isExpertReport,
  supersedeStaleDelegations,
  type Delegation,
  type DiscussionRun
} from './discussion-contracts.js';

function delegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    id: 'delegation-1',
    discussionId: 'discussion-1',
    sessionId: 'session-a',
    workItemId: 'requirement-a',
    requirementRevision: 3,
    generation: 1,
    targetAgentId: 'expert-1',
    origin: 'coordinator',
    objective: 'Assess the storage design.',
    expectedResult: 'Risks and a recommendation.',
    budgetTokens: 4_000,
    operationId: 'operation-1',
    status: 'pending',
    revision: 1,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...overrides
  };
}

function run(overrides: Partial<DiscussionRun> = {}): DiscussionRun {
  return {
    id: 'discussion-1',
    sessionId: 'session-a',
    workItemId: 'requirement-a',
    requirementRevision: 3,
    generation: 1,
    coordinatorAgentId: 'coordinator',
    objective: 'Decide the storage approach.',
    exitCondition: 'Every open question has an owner or a user decision.',
    roundLimit: 3,
    roundsStarted: 0,
    budgetTokens: 20_000,
    status: 'planning',
    delegations: [],
    revision: 1,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...overrides
  };
}

test('contract version is pinned', () => {
  assert.equal(DISCUSSION_CONTRACT_VERSION, '1.0');
});

test('discussion status only moves along the designed lifecycle', () => {
  assert.equal(canTransitionDiscussion('planning', 'consulting'), true);
  assert.equal(canTransitionDiscussion('consulting', 'synthesizing'), true);
  assert.equal(canTransitionDiscussion('synthesizing', 'waiting_user'), true);
  assert.equal(canTransitionDiscussion('synthesizing', 'ready_for_confirmation'), true);
  assert.equal(canTransitionDiscussion('waiting_user', 'consulting'), true, 'a user answer opens a new bounded round');

  // Pause and failure are reachable from any active state and resumable.
  assert.equal(canTransitionDiscussion('consulting', 'paused'), true);
  assert.equal(canTransitionDiscussion('paused', 'consulting'), true);
  assert.equal(canTransitionDiscussion('consulting', 'failed'), true);

  // What must never happen: skipping synthesis, or reviving a finished run.
  assert.equal(canTransitionDiscussion('consulting', 'ready_for_confirmation'), false, 'no confirmation without a synthesis');
  assert.equal(canTransitionDiscussion('ready_for_confirmation', 'consulting'), false);
  assert.equal(canTransitionDiscussion('planning', 'synthesizing'), false, 'nothing to synthesize before consulting');
});

test('delegation status is a one-way lifecycle with explicit terminal states', () => {
  assert.equal(canTransitionDelegation('pending', 'running'), true);
  assert.equal(canTransitionDelegation('running', 'completed'), true);
  assert.equal(canTransitionDelegation('running', 'failed'), true);
  assert.equal(canTransitionDelegation('running', 'blocked'), true);
  assert.equal(canTransitionDelegation('blocked', 'running'), true, 'a blocked delegation resumes once its input arrives');
  assert.equal(canTransitionDelegation('pending', 'cancelled'), true);
  assert.equal(canTransitionDelegation('pending', 'superseded'), true);
  assert.equal(canTransitionDelegation('running', 'superseded'), true);

  for (const terminal of ['completed', 'failed', 'cancelled', 'superseded'] as const) {
    assert.equal(canTransitionDelegation(terminal, 'running'), false, `${terminal} never runs again`);
    assert.equal(canTransitionDelegation(terminal, 'pending'), false, `${terminal} never re-queues`);
  }
});

test('a delegation is keyed by discussion, target and requirement revision', () => {
  const key = delegationLogicalKey(delegation());
  assert.equal(key, 'discussion-1|expert-1|3');

  // A new requirement revision is a different piece of work, not a duplicate.
  assert.notEqual(delegationLogicalKey(delegation({ requirementRevision: 4 })), key);
  // The same ask to the same expert on the same revision is the same work,
  // whichever call site issued it — that is what makes a restart idempotent.
  assert.equal(delegationLogicalKey(delegation({ id: 'delegation-9', operationId: 'operation-9' })), key);
});

test('a restart only runs delegations that have not finished on the current generation', () => {
  const candidates: Delegation[] = [
    delegation({ id: 'done', status: 'completed' }),
    delegation({ id: 'queued', status: 'pending' }),
    delegation({ id: 'in-flight', status: 'running' }),
    delegation({ id: 'stuck', status: 'blocked' }),
    delegation({ id: 'gone', status: 'cancelled' }),
    delegation({ id: 'old', status: 'superseded' }),
    delegation({ id: 'failed', status: 'failed' }),
    delegation({ id: 'old-generation', status: 'pending', generation: 0 })
  ];

  const ids = delegationsToRun(candidates, { generation: 1 }).map((item) => item.id);

  assert.deepEqual(ids, ['queued', 'in-flight'], 'completed work is not repeated; terminal states stay put');
  assert.equal(ids.includes('old-generation'), false, 'a delegation from before a recovery is not revived');
  assert.equal(ids.includes('stuck'), false, 'blocked waits for its input, it is not re-dispatched blindly');
});

test('a requirement revision supersedes every unfinished delegation on the old revision', () => {
  const before: Delegation[] = [
    delegation({ id: 'a', status: 'completed', requirementRevision: 3 }),
    delegation({ id: 'b', status: 'running', requirementRevision: 3 }),
    delegation({ id: 'c', status: 'pending', requirementRevision: 3 }),
    delegation({ id: 'd', status: 'pending', requirementRevision: 4 })
  ];

  const after = supersedeStaleDelegations(before, { currentRequirementRevision: 4, now: '2026-09-19T01:00:00.000Z' });

  const byId = Object.fromEntries(after.map((item) => [item.id, item]));
  assert.equal(byId.a?.status, 'completed', 'a finished result is kept as history, only its use is decided at synthesis');
  assert.equal(byId.a?.stale, true, 'but it is marked stale so synthesis cannot treat it as current');
  assert.equal(byId.b?.status, 'superseded');
  assert.equal(byId.c?.status, 'superseded');
  assert.equal(byId.d?.status, 'pending', 'work on the current revision is untouched');
  assert.equal(byId.d?.stale, undefined);
  assert.equal(byId.b?.revision, 2, 'superseding is a recorded change');
  assert.equal(byId.d?.revision, 1);
});

test('expert report shape carries conclusions and evidence, never a thinking transcript', () => {
  assert.equal(
    isExpertReport({
      conclusion: 'Use the relational store.',
      evidenceRefs: ['docs/design/x.md'],
      risks: ['Migration cost'],
      openQuestions: [],
      suggestedActions: ['Confirm retention policy']
    }),
    true
  );
  assert.equal(isExpertReport({ conclusion: '', evidenceRefs: [], risks: [], openQuestions: [], suggestedActions: [] }), false);
  assert.equal(
    isExpertReport({
      conclusion: 'x',
      evidenceRefs: [],
      risks: [],
      openQuestions: [],
      suggestedActions: [],
      thinking: 'private chain of thought'
    }),
    false,
    'extra fields are rejected so a private transcript cannot ride along'
  );
});

test('a run with a superseded delegation still reports its own revision', () => {
  const current = run({ delegations: [delegation({ status: 'superseded' })] });
  assert.equal(current.revision, 1);
  assert.equal(current.delegations.length, 1);
});
