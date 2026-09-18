import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SummaryMemory } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { SummaryCheckpointStore, summaryCheckpointLogicalKey } from './summary-checkpoint-store.js';

const summary: SummaryMemory = {
  goal: '实现登录页', currentState: 'EXECUTING / task_execution', confirmedFacts: ['Session status: EXECUTING'],
  completed: [], decisions: ['使用 PostgreSQL'], openQuestions: [], risks: [], nextSteps: ['继续实现']
};

async function fixture(withLifecycle = false) {
  const directory = mkdtempSync(join(tmpdir(), 'summary-checkpoint-store-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  await persistence.setCollection('sessions', [{ id: 'session-1', decisionLedgerRevision: 2 }]);
  await persistence.setCollection('workItemsBySession', {
    'session-1': [{ id: 'work-1', revision: 3 }, { id: 'work-2', revision: 1 }]
  });
  if (withLifecycle) {
    await persistence.setCollection('sessionLifecyclesBySession', {
      'session-1': {
        contractVersion: 'main-agent-collaboration/v1', sessionId: 'session-1', dataEpoch: 'epoch',
        generation: 2, revision: 3, state: 'active', admission: 'open', stopStatus: 'idle'
      }
    });
  }
  return {
    persistence,
    store: new SummaryCheckpointStore(persistence, () => '2026-09-17T00:00:00.000Z'),
    async cleanup() {
      await persistence.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function draft(overrides: Partial<Parameters<SummaryCheckpointStore['commit']>[0]> = {}) {
  return {
    sessionId: 'session-1',
    workItemId: 'work-1',
    phase: 'task_execution' as const,
    coveredEventSeq: 10,
    workItemRevision: 3,
    decisionLedgerRevision: 2,
    policyVersion: 'summary-checkpoint-v2',
    summaryMemory: summary,
    sourceEventIds: ['event-9', 'event-10'],
    sourceArtifactIds: [],
    sourceMemoryIds: [],
    sourceDecisionIds: ['decision-1'],
    ...overrides
  };
}

test('the same coverage and version fingerprint commits exactly once across concurrent writers', async () => {
  const context = await fixture();
  try {
    const [first, second] = await Promise.all([
      context.store.commit(draft()),
      context.store.commit(draft())
    ] as const);
    const outcomes = [first.status, second.status].sort();
    assert.deepEqual(outcomes, ['committed', 'duplicate']);
    const committed = (first.status === 'committed' ? first : second) as Extract<typeof first, { status: 'committed' | 'duplicate' }>;
    const duplicate = (first.status === 'duplicate' ? first : second) as Extract<typeof first, { status: 'committed' | 'duplicate' }>;
    assert.equal(duplicate.record.checkpointId, committed.record.checkpointId, 'the duplicate must return the winner');
    assert.equal(context.store.list('session-1', 'work-1').length, 1);
    assert.equal(
      committed.record.logicalKey,
      summaryCheckpointLogicalKey({ workItemId: 'work-1', coveredEventSeq: 10, workItemRevision: 3, decisionLedgerRevision: 2, policyVersion: 'summary-checkpoint-v2' })
    );
    assert.match(committed.record.contentHash, /^[a-f0-9]{64}$/);
  } finally {
    await context.cleanup();
  }
});

test('a checkpoint built from an older requirement or ledger version is rejected once a newer one exists', async () => {
  const context = await fixture();
  try {
    await context.store.commit(draft({ workItemRevision: 3, decisionLedgerRevision: 2 }));
    const staleWorkItem = await context.store.commit(draft({ coveredEventSeq: 12, workItemRevision: 2, decisionLedgerRevision: 2 }));
    assert.equal(staleWorkItem.status, 'rejected');
    assert.equal(staleWorkItem.code, 'SUMMARY_CHECKPOINT_STALE_VERSION');
    const staleLedger = await context.store.commit(draft({ coveredEventSeq: 12, workItemRevision: 3, decisionLedgerRevision: 1 }));
    assert.equal(staleLedger.status, 'rejected');
    assert.equal(staleLedger.code, 'SUMMARY_CHECKPOINT_STALE_VERSION');
    const regressed = await context.store.commit(draft({ coveredEventSeq: 8, workItemRevision: 3, decisionLedgerRevision: 2 }));
    assert.equal(regressed.status, 'rejected');
    assert.equal(regressed.code, 'SUMMARY_CHECKPOINT_COVERAGE_REGRESSED');
    assert.equal(context.store.list('session-1', 'work-1').length, 1, 'rejected checkpoints must not be persisted');

    await context.persistence.mutateCollections(['sessions', 'workItemsBySession'], (state) => {
      (state.sessions as Array<{ decisionLedgerRevision: number }>)[0].decisionLedgerRevision = 3;
      (state.workItemsBySession as Record<string, Array<{ revision: number }>>)['session-1'][0].revision = 4;
    });
    const advanced = await context.store.commit(draft({ coveredEventSeq: 12, workItemRevision: 4, decisionLedgerRevision: 3 }));
    assert.equal(advanced.status, 'committed');
    assert.equal(context.store.latest('session-1', 'work-1')?.coveredEventSeq, 12);
  } finally {
    await context.cleanup();
  }
});

test('a user revision rejects an in-flight summary even before a replacement checkpoint exists', async () => {
  const context = await fixture();
  try {
    await context.persistence.setCollection('sessions', [{ id: 'session-1', decisionLedgerRevision: 2 }]);
    await context.persistence.setCollection('workItemsBySession', {
      'session-1': [{ id: 'work-1', revision: 3 }]
    });
    const inFlight = draft();
    await context.persistence.mutateCollections(['sessions', 'workItemsBySession'], (state) => {
      (state.sessions as Array<{ decisionLedgerRevision: number }>)[0].decisionLedgerRevision = 3;
      (state.workItemsBySession as Record<string, Array<{ revision: number }>>)['session-1'][0].revision = 4;
    });
    const late = await context.store.commit(inFlight);
    assert.equal(late.status, 'rejected');
    assert.equal(late.status === 'rejected' && late.code, 'SUMMARY_CHECKPOINT_STALE_VERSION');
    assert.equal(context.store.list('session-1').length, 0);

    const current = await context.store.commit(draft({ workItemRevision: 4, decisionLedgerRevision: 3 }));
    assert.equal(current.status, 'committed');
  } finally {
    await context.cleanup();
  }
});

test('a checkpoint from a superseded session generation is rejected', async () => {
  const context = await fixture(true);
  try {
    const stale = await context.store.commit(draft({ generation: 1 }));
    assert.equal(stale.status, 'rejected');
    assert.equal(stale.code, 'SUMMARY_CHECKPOINT_STALE_GENERATION');
    const current = await context.store.commit(draft({ generation: 2 }));
    assert.equal(current.status, 'committed');
    assert.equal(current.record.generation, 2);
  } finally {
    await context.cleanup();
  }
});

test('checkpoints survive a store rebuild and are scoped per WorkItem', async () => {
  const context = await fixture();
  try {
    await context.store.commit(draft());
    await context.store.commit(draft({ workItemId: 'work-2', coveredEventSeq: 4, workItemRevision: 1, decisionLedgerRevision: 2 }));
    const restored = new SummaryCheckpointStore(context.persistence);
    assert.equal(restored.list('session-1', 'work-1').length, 1);
    assert.equal(restored.list('session-1', 'work-2').length, 1);
    assert.equal(restored.latest('session-1', 'work-1')?.workItemId, 'work-1');
    assert.equal(restored.list('session-1', 'work-missing').length, 0);
  } finally {
    await context.cleanup();
  }
});

test('a checkpoint only references its sources; committing it never rewrites or removes the original events', async () => {
  const context = await fixture();
  try {
    const original = [{ id: 'event-9', sessionId: 'session-1', type: 'user_message', content: '原始消息 9，不可篡改', toAgentIds: [], actor: { type: 'user', id: 'u' }, metadata: { schemaVersion: '0.1', payload: {} }, createdAt: '2026-09-17T00:00:00.000Z' }];
    await context.persistence.setCollection('eventsBySession', { 'session-1': original });
    const outcome = await context.store.commit(draft({ sourceEventIds: ['event-9'] }));
    assert.equal(outcome.status, 'committed');
    const events = context.persistence.getCollection<Record<string, Array<{ id: string; content: string }>>>('eventsBySession', {});
    assert.deepEqual(events['session-1']?.map((event) => [event.id, event.content]), [['event-9', '原始消息 9，不可篡改']]);
    assert.deepEqual(outcome.status === 'committed' ? outcome.record.sourceEventIds : [], ['event-9'], 'the checkpoint points back at the raw event');
  } finally {
    await context.cleanup();
  }
});

test('a session whose admission is closed cannot receive new checkpoints', async () => {
  const context = await fixture();
  try {
    await context.persistence.setCollection('sessionLifecyclesBySession', {
      'session-1': {
        contractVersion: 'main-agent-collaboration/v1', sessionId: 'session-1', dataEpoch: 'epoch',
        generation: 1, revision: 2, state: 'deleting', admission: 'closed', stopStatus: 'requested'
      }
    });
    const outcome = await context.store.commit(draft({ generation: 1 }));
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.status === 'rejected' && outcome.code, 'SESSION_ADMISSION_CLOSED');
    assert.equal(context.store.list('session-1').length, 0);
  } finally {
    await context.cleanup();
  }
});
