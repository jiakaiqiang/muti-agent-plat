import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PersistenceService } from '../persistence/persistence.service.js';
import { DISCUSSIONS_COLLECTION, DiscussionStore } from './discussion-store.js';

async function fixture(options: { generation?: number; admission?: 'open' | 'closed' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'discussion-store-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  await persistence.setCollection('sessions', [{ id: 'session-1', decisionLedgerRevision: 0 }]);
  await persistence.setCollection('workItemsBySession', { 'session-1': [{ id: 'work-1', revision: 3 }] });
  await persistence.setCollection('sessionLifecyclesBySession', {
    'session-1': {
      contractVersion: 'main-agent-collaboration/v1', sessionId: 'session-1', dataEpoch: 'epoch',
      generation: options.generation ?? 1, revision: 1, state: 'active',
      admission: options.admission ?? 'open', stopStatus: 'idle'
    }
  });
  let tick = 0;
  return {
    persistence,
    directory,
    store: new DiscussionStore(persistence, () => `2026-09-19T00:00:${String(tick++).padStart(2, '0')}.000Z`),
    async cleanup() {
      await persistence.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

const openRun = {
  sessionId: 'session-1',
  workItemId: 'work-1',
  requirementRevision: 3,
  generation: 1,
  coordinatorAgentId: 'coordinator',
  objective: 'Decide the storage approach.',
  exitCondition: 'Every open question has an owner.',
  roundLimit: 3,
  budgetTokens: 20_000
};

const ask = (targetAgentId: string, overrides: Record<string, unknown> = {}) => ({
  targetAgentId,
  origin: 'coordinator' as const,
  objective: `Assess from the ${targetAgentId} angle.`,
  expectedResult: 'Risks and a recommendation.',
  budgetTokens: 4_000,
  requirementRevision: 3,
  ...overrides
});

test('opening a discussion persists a planning run bound to requirement revision and generation', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(openRun);
    assert.equal(opened.status, 'opened');
    if (opened.status !== 'opened') return;
    assert.equal(opened.run.status, 'planning');
    assert.equal(opened.run.requirementRevision, 3);
    assert.equal(opened.run.generation, 1);
    assert.deepEqual(opened.run.delegations, []);

    const stored = context.persistence.getCollection<Record<string, unknown[]>>(DISCUSSIONS_COLLECTION, {});
    assert.equal(stored['session-1']?.length, 1, 'the run is in the session-keyed collection, not only in memory');
  } finally {
    await context.cleanup();
  }
});

test('the same ask to the same expert on the same revision reserves exactly once under concurrency', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(openRun);
    assert.equal(opened.status, 'opened');
    if (opened.status !== 'opened') return;

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => context.store.reserveDelegation(opened.run.id, ask('expert-1')))
    );
    const reserved = outcomes.filter((item) => item.status === 'reserved');
    const duplicates = outcomes.filter((item) => item.status === 'duplicate');
    assert.equal(reserved.length, 1, 'one reservation wins');
    assert.equal(duplicates.length, 11, 'every other caller sees the winner, not a second run');

    const run = context.store.get('session-1', opened.run.id);
    assert.equal(run?.delegations.length, 1);
    assert.equal(run?.delegations[0]?.status, 'pending');
  } finally {
    await context.cleanup();
  }
});

test('a delegation built against an older requirement revision is refused and not written', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(openRun);
    if (opened.status !== 'opened') return;
    await context.store.reviseRequirement(opened.run.id, { requirementRevision: 4 });

    const late = await context.store.reserveDelegation(opened.run.id, ask('expert-1', { requirementRevision: 3 }));

    assert.equal(late.status, 'rejected');
    if (late.status !== 'rejected') return;
    assert.equal(late.code, 'DELEGATION_STALE_REVISION');
    assert.equal(context.store.get('session-1', opened.run.id)?.delegations.length, 0, 'refusal leaves no row behind');
  } finally {
    await context.cleanup();
  }
});

test('a closed session admission refuses new delegations', async () => {
  const context = await fixture({ admission: 'closed' });
  try {
    const opened = await context.store.open(openRun);
    assert.equal(opened.status, 'rejected');
    if (opened.status !== 'rejected') return;
    assert.equal(opened.code, 'SESSION_ADMISSION_CLOSED');
  } finally {
    await context.cleanup();
  }
});

test('a run from a previous generation is not revived on restart', async () => {
  const context = await fixture({ generation: 2 });
  try {
    const opened = await context.store.open({ ...openRun, generation: 1 });
    assert.equal(opened.status, 'rejected');
    if (opened.status !== 'rejected') return;
    assert.equal(opened.code, 'DISCUSSION_STALE_GENERATION');
  } finally {
    await context.cleanup();
  }
});

test('marking a delegation running then completed records the report and is idempotent', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(openRun);
    if (opened.status !== 'opened') return;
    const reserved = await context.store.reserveDelegation(opened.run.id, ask('expert-1'));
    if (reserved.status !== 'reserved') return;
    const delegationId = reserved.delegation.id;

    const started = await context.store.transitionDelegation(opened.run.id, delegationId, {
      status: 'running',
      invocationId: 'invocation-1'
    });
    assert.equal(started.status, 'applied');

    const report = {
      conclusion: 'Use the relational store.',
      evidenceRefs: ['docs/design/x.md'],
      risks: [],
      openQuestions: [],
      suggestedActions: []
    };
    const completed = await context.store.transitionDelegation(opened.run.id, delegationId, { status: 'completed', result: report });
    assert.equal(completed.status, 'applied');

    // A replayed completion (retried callback, duplicated event) is a no-op.
    const replay = await context.store.transitionDelegation(opened.run.id, delegationId, { status: 'completed', result: report });
    assert.equal(replay.status, 'idempotent');

    // A terminal delegation cannot be pushed back to running.
    const revive = await context.store.transitionDelegation(opened.run.id, delegationId, { status: 'running' });
    assert.equal(revive.status, 'rejected');
    if (revive.status !== 'rejected') return;
    assert.equal(revive.code, 'DELEGATION_INVALID_TRANSITION');

    const run = context.store.get('session-1', opened.run.id);
    assert.deepEqual(run?.delegations[0]?.result, report);
    assert.equal(run?.delegations[0]?.invocationId, 'invocation-1');
  } finally {
    await context.cleanup();
  }
});

test('a requirement revision supersedes unfinished delegations and marks finished ones stale', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(openRun);
    if (opened.status !== 'opened') return;
    const a = await context.store.reserveDelegation(opened.run.id, ask('expert-a'));
    const b = await context.store.reserveDelegation(opened.run.id, ask('expert-b'));
    if (a.status !== 'reserved' || b.status !== 'reserved') return;
    await context.store.transitionDelegation(opened.run.id, a.delegation.id, { status: 'running' });
    await context.store.transitionDelegation(opened.run.id, a.delegation.id, {
      status: 'completed',
      result: { conclusion: 'A', evidenceRefs: [], risks: [], openQuestions: [], suggestedActions: [] }
    });

    const revised = await context.store.reviseRequirement(opened.run.id, { requirementRevision: 4 });
    assert.equal(revised.status, 'applied');

    const run = context.store.get('session-1', opened.run.id);
    assert.equal(run?.requirementRevision, 4);
    const byAgent = Object.fromEntries((run?.delegations ?? []).map((item) => [item.targetAgentId, item]));
    assert.equal(byAgent['expert-a']?.status, 'completed');
    assert.equal(byAgent['expert-a']?.stale, true);
    assert.equal(byAgent['expert-b']?.status, 'superseded');

    // The same expert can now be asked again on the new revision.
    const again = await context.store.reserveDelegation(opened.run.id, ask('expert-b', { requirementRevision: 4 }));
    assert.equal(again.status, 'reserved');
  } finally {
    await context.cleanup();
  }
});

test('state survives a process restart and only unfinished current-generation work is runnable', async () => {
  const first = await fixture();
  let runId = '';
  try {
    const opened = await first.store.open(openRun);
    if (opened.status !== 'opened') return;
    runId = opened.run.id;
    const done = await first.store.reserveDelegation(runId, ask('expert-done'));
    const queued = await first.store.reserveDelegation(runId, ask('expert-queued'));
    if (done.status !== 'reserved' || queued.status !== 'reserved') return;
    await first.store.transitionDelegation(runId, done.delegation.id, { status: 'running' });
    await first.store.transitionDelegation(runId, done.delegation.id, {
      status: 'completed',
      result: { conclusion: 'ok', evidenceRefs: [], risks: [], openQuestions: [], suggestedActions: [] }
    });
    await first.persistence.onModuleDestroy();

    const reopened = new PersistenceService({ enabled: true, backend: 'file', filePath: join(first.directory, 'state.json') });
    await reopened.initialize();
    const store = new DiscussionStore(reopened);
    const run = store.get('session-1', runId);
    assert.ok(run, 'the run is readable after restart');
    const runnable = store.runnableDelegations('session-1', runId, { generation: 1 });
    assert.deepEqual(runnable.map((item) => item.targetAgentId), ['expert-queued']);
    await reopened.onModuleDestroy();
  } finally {
    rmSync(first.directory, { recursive: true, force: true });
  }
});

test('discussion status transitions are validated and versioned', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(openRun);
    if (opened.status !== 'opened') return;

    const consulting = await context.store.transitionRun(opened.run.id, { status: 'consulting' });
    assert.equal(consulting.status, 'applied');
    if (consulting.status !== 'applied') return;
    assert.equal(consulting.run.revision, 2);
    assert.equal(consulting.run.roundsStarted, 1, 'entering consulting starts a round');

    const skip = await context.store.transitionRun(opened.run.id, { status: 'ready_for_confirmation' });
    assert.equal(skip.status, 'rejected', 'confirmation without synthesis is refused');

    const overRounds = await (async () => {
      await context.store.transitionRun(opened.run.id, { status: 'synthesizing' });
      await context.store.transitionRun(opened.run.id, { status: 'waiting_user' });
      await context.store.transitionRun(opened.run.id, { status: 'consulting' });
      await context.store.transitionRun(opened.run.id, { status: 'synthesizing' });
      await context.store.transitionRun(opened.run.id, { status: 'waiting_user' });
      await context.store.transitionRun(opened.run.id, { status: 'consulting' });
      await context.store.transitionRun(opened.run.id, { status: 'synthesizing' });
      await context.store.transitionRun(opened.run.id, { status: 'waiting_user' });
      return context.store.transitionRun(opened.run.id, { status: 'consulting' });
    })();
    assert.equal(overRounds.status, 'rejected', 'a fourth round exceeds roundLimit=3');
    if (overRounds.status !== 'rejected') return;
    assert.equal(overRounds.code, 'DISCUSSION_ROUND_LIMIT');
  } finally {
    await context.cleanup();
  }
});

test('records never carry a thinking transcript', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(openRun);
    if (opened.status !== 'opened') return;
    const reserved = await context.store.reserveDelegation(opened.run.id, ask('expert-1'));
    if (reserved.status !== 'reserved') return;
    await context.store.transitionDelegation(opened.run.id, reserved.delegation.id, { status: 'running' });
    const outcome = await context.store.transitionDelegation(opened.run.id, reserved.delegation.id, {
      status: 'completed',
      result: { conclusion: 'x', evidenceRefs: [], risks: [], openQuestions: [], suggestedActions: [], thinking: 'secret' } as never
    });
    assert.equal(outcome.status, 'rejected');
    if (outcome.status !== 'rejected') return;
    assert.equal(outcome.code, 'EXPERT_REPORT_INVALID');
  } finally {
    await context.cleanup();
  }
});

test('findResumable returns only a run that still has a round to continue on the same scope', async () => {
  const context = await fixture();
  try {
    const scope = { workItemId: 'work-1', requirementRevision: 3, generation: 1 };
    const opened = await context.store.open(openRun);
    if (opened.status !== 'opened') return;

    assert.equal(context.store.findResumable('session-1', scope)?.id, opened.run.id, 'planning is resumable');
    await context.store.transitionRun(opened.run.id, { status: 'consulting' });
    assert.equal(context.store.findResumable('session-1', scope)?.id, opened.run.id, 'consulting is resumable');
    await context.store.transitionRun(opened.run.id, { status: 'paused' });
    assert.equal(context.store.findResumable('session-1', scope)?.id, opened.run.id, 'paused is resumable');

    assert.equal(context.store.findResumable('session-1', { ...scope, requirementRevision: 4 }), undefined, 'another revision is other work');
    assert.equal(context.store.findResumable('session-1', { ...scope, generation: 2 }), undefined, 'a recovered session does not resume old work');

    await context.store.transitionRun(opened.run.id, { status: 'consulting' });
    await context.store.transitionRun(opened.run.id, { status: 'synthesizing' });
    assert.equal(context.store.findResumable('session-1', scope), undefined, 'nothing left to dispatch once synthesizing');
    await context.store.transitionRun(opened.run.id, { status: 'failed' });
    assert.equal(context.store.findResumable('session-1', scope), undefined, 'a failed run is re-planned, not silently resumed');
  } finally {
    await context.cleanup();
  }
});

test('resuming from paused does not count as a new round, a fresh consulting entry does', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(openRun);
    if (opened.status !== 'opened') return;
    await context.store.transitionRun(opened.run.id, { status: 'consulting' });
    await context.store.transitionRun(opened.run.id, { status: 'paused' });
    const resumed = await context.store.transitionRun(opened.run.id, { status: 'consulting' });
    assert.equal(resumed.status === 'applied' && resumed.run.roundsStarted, 1, 'the same round continues');

    await context.store.transitionRun(opened.run.id, { status: 'synthesizing' });
    const next = await context.store.transitionRun(opened.run.id, { status: 'consulting' });
    assert.equal(next.status === 'applied' && next.run.roundsStarted, 2, 'a round after synthesis is a new round');
  } finally {
    await context.cleanup();
  }
});

test('findOpenRun finds the requirement\'s live run whatever its revision, but never a finished one', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(openRun);
    if (opened.status !== 'opened') return;
    await context.store.transitionRun(opened.run.id, { status: 'consulting' });
    await context.store.transitionRun(opened.run.id, { status: 'synthesizing' });

    // The user changed the requirement; the run still belongs to it.
    assert.equal(context.store.findOpenRun('session-1', { workItemId: 'work-1', generation: 1 })?.id, opened.run.id);
    assert.equal(context.store.findOpenRun('session-1', { workItemId: 'work-1', generation: 2 }), undefined);

    await context.store.transitionRun(opened.run.id, { status: 'ready_for_confirmation' });
    assert.equal(context.store.findOpenRun('session-1', { workItemId: 'work-1', generation: 1 }), undefined, 'ready_for_confirmation is closed for new rounds');
  } finally {
    await context.cleanup();
  }
});

test('recordSynthesis persists the synthesis and moves the run to the outcome state', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(openRun);
    if (opened.status !== 'opened') return;
    const premature = await context.store.recordSynthesis(opened.run.id, {
      summary: 'x', conflicts: [], unresolved: [], sourceDelegationIds: [], outcome: 'ready'
    });
    assert.equal(premature.status, 'rejected', 'nothing to synthesize before a round ran');

    await context.store.transitionRun(opened.run.id, { status: 'consulting' });
    await context.store.transitionRun(opened.run.id, { status: 'synthesizing' });
    const needsUser = await context.store.recordSynthesis(opened.run.id, {
      summary: '【A】x', conflicts: [], unresolved: ['retention?'], sourceDelegationIds: ['d-1'], outcome: 'needs_user',
      pendingConfirmationId: 'confirm-1'
    });
    assert.equal(needsUser.status, 'applied');
    const run = context.store.get('session-1', opened.run.id);
    assert.equal(run?.status, 'waiting_user');
    assert.equal(run?.pendingConfirmationId, 'confirm-1');
    assert.deepEqual(run?.synthesis?.sourceDelegationIds, ['d-1']);
    assert.equal(run?.synthesis?.summary, '【A】x');

    // The user answered; a new round runs and closes clean.
    await context.store.transitionRun(opened.run.id, { status: 'consulting' });
    await context.store.transitionRun(opened.run.id, { status: 'synthesizing' });
    const ready = await context.store.recordSynthesis(opened.run.id, {
      summary: '【A】y', conflicts: [], unresolved: [], sourceDelegationIds: ['d-2'], outcome: 'ready'
    });
    assert.equal(ready.status, 'applied');
    assert.equal(context.store.get('session-1', opened.run.id)?.status, 'ready_for_confirmation');
    assert.equal(context.store.get('session-1', opened.run.id)?.pendingConfirmationId, undefined, 'a clean close clears the pending card');
  } finally {
    await context.cleanup();
  }
});

test('the user can accept a synthesis as-is: waiting_user closes to ready_for_confirmation', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open(openRun);
    if (opened.status !== 'opened') return;
    await context.store.transitionRun(opened.run.id, { status: 'consulting' });
    await context.store.transitionRun(opened.run.id, { status: 'synthesizing' });
    await context.store.recordSynthesis(opened.run.id, {
      summary: 'x', conflicts: [], unresolved: ['q'], sourceDelegationIds: [], outcome: 'needs_user', pendingConfirmationId: 'c-1'
    });
    const accepted = await context.store.transitionRun(opened.run.id, { status: 'ready_for_confirmation' });
    assert.equal(accepted.status, 'applied');
    assert.equal(context.store.get('session-1', opened.run.id)?.pendingConfirmationId, undefined, 'the answered card is cleared');
  } finally {
    await context.cleanup();
  }
});
