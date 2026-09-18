import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SummaryMemory } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { WorkItemBudgetStore } from '../runtimes/work-item-budget-store.js';
import { SummaryCheckpointStore } from './summary-checkpoint-store.js';
import {
  SUMMARY_CHECKPOINT_EVENT_THRESHOLD,
  SummaryCheckpointService,
  type SummaryCheckpointSnapshot
} from './summary-checkpoint.service.js';

const summary: SummaryMemory = {
  goal: '实现登录页', currentState: 'EXECUTING / task_execution', confirmedFacts: [], completed: [],
  decisions: ['使用 PostgreSQL'], openQuestions: [], risks: [], nextSteps: ['继续实现']
};

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'summary-checkpoint-service-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  await persistence.setCollection('sessions', [{ id: 'session-1', decisionLedgerRevision: 1 }]);
  await persistence.setCollection('workItemsBySession', { 'session-1': [{ id: 'work-1', revision: 2 }] });
  const store = new SummaryCheckpointStore(persistence);
  const budgets = new WorkItemBudgetStore(persistence);
  return {
    persistence,
    store,
    budgets,
    service: new SummaryCheckpointService(store, budgets),
    async cleanup() {
      await persistence.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function snapshot(overrides: Partial<SummaryCheckpointSnapshot> = {}): SummaryCheckpointSnapshot {
  return {
    sessionId: 'session-1', workItemId: 'work-1', phase: 'task_execution',
    coveredEventSeq: 10, workItemRevision: 2, decisionLedgerRevision: 1,
    sourceEventIds: ['event-10'], sourceArtifactIds: [], sourceMemoryIds: [], sourceDecisionIds: [],
    ...overrides
  };
}

test('the same coverage is summarized once; a phase boundary with nothing new is skipped', async () => {
  const context = await fixture();
  try {
    let generated = 0;
    const generate = () => { generated += 1; return summary; };
    const first = await context.service.checkpoint({ trigger: 'phase_end', snapshot: snapshot(), generate });
    assert.equal(first.status, 'committed');
    const again = await context.service.checkpoint({ trigger: 'phase_end', snapshot: snapshot(), generate });
    assert.equal(again.status, 'skipped');
    assert.equal(again.status === 'skipped' && again.reason, 'already_covered');
    assert.equal(generated, 1, 'no second generation for identical coverage');
  } finally {
    await context.cleanup();
  }
});

test('budget-threshold trigger waits for enough new events unless a version moved', async () => {
  const context = await fixture();
  try {
    await context.service.checkpoint({ trigger: 'phase_end', snapshot: snapshot({ coveredEventSeq: 10 }), generate: () => summary });
    const tooEarly = await context.service.checkpoint({
      trigger: 'budget_threshold',
      snapshot: snapshot({ coveredEventSeq: 10 + SUMMARY_CHECKPOINT_EVENT_THRESHOLD - 1 }),
      generate: () => summary
    });
    assert.equal(tooEarly.status, 'skipped');
    assert.equal(tooEarly.status === 'skipped' && tooEarly.reason, 'below_threshold');
    await context.persistence.mutateCollections(['sessions'], (state) => {
      (state.sessions as Array<{ decisionLedgerRevision: number }>)[0].decisionLedgerRevision = 2;
    });
    const versionMoved = await context.service.checkpoint({
      trigger: 'budget_threshold',
      snapshot: snapshot({ coveredEventSeq: 12, decisionLedgerRevision: 2 }),
      generate: () => summary
    });
    assert.equal(versionMoved.status, 'committed', 'a new decision must be summarized even below the event threshold');
    const enough = await context.service.checkpoint({
      trigger: 'budget_threshold',
      snapshot: snapshot({ coveredEventSeq: 12 + SUMMARY_CHECKPOINT_EVENT_THRESHOLD, decisionLedgerRevision: 2 }),
      generate: () => summary
    });
    assert.equal(enough.status, 'committed');
  } finally {
    await context.cleanup();
  }
});

test('budget-threshold trigger does not create an eager baseline before the first threshold', async () => {
  const context = await fixture();
  try {
    let generated = 0;
    const below = await context.service.checkpoint({
      trigger: 'budget_threshold',
      snapshot: snapshot({ coveredEventSeq: SUMMARY_CHECKPOINT_EVENT_THRESHOLD - 1 }),
      generate: () => {
        generated += 1;
        return summary;
      }
    });
    assert.equal(below.status, 'skipped');
    assert.equal(below.status === 'skipped' && below.reason, 'below_threshold');
    assert.equal(generated, 0);
    assert.equal(context.store.list('session-1', 'work-1').length, 0);

    const atThreshold = await context.service.checkpoint({
      trigger: 'budget_threshold',
      snapshot: snapshot({ coveredEventSeq: SUMMARY_CHECKPOINT_EVENT_THRESHOLD }),
      generate: () => {
        generated += 1;
        return summary;
      }
    });
    assert.equal(atThreshold.status, 'committed');
    assert.equal(generated, 1);
  } finally {
    await context.cleanup();
  }
});

test('summary generation reserves the summary budget category and settles by reported size', async () => {
  const context = await fixture();
  try {
    const outcome = await context.service.checkpoint({
      trigger: 'phase_end',
      snapshot: snapshot(),
      generate: () => summary,
      budget: { requestedTokens: 500, limitTokens: 1_000, operationId: 'op-summary-1' }
    });
    assert.equal(outcome.status, 'committed');
    const ledger = context.budgets.get('session-1', 'work-1');
    assert.ok(ledger);
    assert.equal(ledger.reservedTokens, 0, 'the reservation is settled after commit');
    assert.equal(ledger.settlements[0]?.outcome, 'reported');
    assert.ok(ledger.actualTokens > 0 && ledger.actualTokens < 500, 'settled by the actual summary size, not the cap');

    const starved = await context.service.checkpoint({
      trigger: 'phase_end',
      snapshot: snapshot({ coveredEventSeq: 30 }),
      generate: () => summary,
      budget: { requestedTokens: 5_000, limitTokens: 1_000, operationId: 'op-summary-2' }
    });
    assert.equal(starved.status, 'skipped');
    assert.equal(starved.status === 'skipped' && starved.reason, 'budget_insufficient');
    assert.equal(context.store.list('session-1', 'work-1').length, 1, 'no checkpoint without budget');
  } finally {
    await context.cleanup();
  }
});

test('a generation built from a stale ledger version is rejected and leaves the newer checkpoint in place', async () => {
  const context = await fixture();
  try {
    await context.persistence.mutateCollections(['sessions'], (state) => {
      (state.sessions as Array<{ decisionLedgerRevision: number }>)[0].decisionLedgerRevision = 3;
    });
    await context.service.checkpoint({ trigger: 'phase_end', snapshot: snapshot({ decisionLedgerRevision: 3 }), generate: () => summary });
    const late = await context.service.checkpoint({
      trigger: 'phase_end',
      snapshot: snapshot({ coveredEventSeq: 20, decisionLedgerRevision: 2 }),
      generate: () => ({ ...summary, decisions: ['旧决定：支持 CSV'] })
    });
    assert.equal(late.status, 'rejected');
    assert.equal(late.status === 'rejected' && late.code, 'SUMMARY_CHECKPOINT_STALE_VERSION');
    const latest = context.service.latest('session-1', 'work-1');
    assert.equal(latest?.decisionLedgerRevision, 3);
    assert.deepEqual(latest?.summaryMemory.decisions, ['使用 PostgreSQL'], 'the late summary must not overwrite newer facts');
  } finally {
    await context.cleanup();
  }
});

test('a failing generator settles the budget as unavailable and reports failure without throwing', async () => {
  const context = await fixture();
  try {
    const outcome = await context.service.checkpoint({
      trigger: 'phase_end',
      snapshot: snapshot(),
      generate: () => { throw new Error('model unavailable'); },
      budget: { requestedTokens: 400, limitTokens: 1_000, operationId: 'op-summary-3' }
    });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.status === 'failed' ? outcome.error : '', /model unavailable/);
    const ledger = context.budgets.get('session-1', 'work-1');
    assert.equal(ledger?.reservedTokens, 0);
    assert.equal(ledger?.unknownTokens, 400, 'a possibly-billed failed call keeps its cap as unknown usage');
    assert.equal(context.store.list('session-1', 'work-1').length, 0);
  } finally {
    await context.cleanup();
  }
});
