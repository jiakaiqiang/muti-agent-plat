import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChangeRequestBase } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { ChangeRequestStore } from './change-request-store.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'change-request-store-'));
  const persistence = new PersistenceService({
    enabled: true,
    backend: 'file',
    filePath: join(directory, 'state.json')
  });
  await persistence.initialize();
  await persistence.setCollection('sessionLifecyclesBySession', {
    'session-1': {
      contractVersion: 'main-agent-collaboration/v1',
      sessionId: 'session-1',
      dataEpoch: 'epoch',
      generation: 2,
      revision: 1,
      state: 'active',
      admission: 'open',
      stopStatus: 'idle'
    }
  });
  return {
    persistence,
    store: new ChangeRequestStore(persistence, () => '2026-09-19T00:00:00.000Z'),
    reopen: () => new ChangeRequestStore(persistence, () => '2026-09-19T00:00:00.000Z'),
    async cleanup() {
      await persistence.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function base(overrides: Partial<ChangeRequestBase> = {}): ChangeRequestBase {
  return {
    sessionId: 'session-1',
    workItemId: 'wi-1',
    workItemRevision: 3,
    workflowRunId: 'run-1',
    documentId: 'doc-1',
    documentRevision: 2,
    ...overrides
  };
}

test('one execution-time message opens exactly one change request across concurrent submits', async () => {
  const context = await fixture();
  try {
    // Two clients (web + desktop) forward the same message. The logical key is
    // what keeps this one queued change rather than two competing ones.
    const [a, b] = await Promise.all([
      context.store.open({ base: base(), sourceEventId: 'event-1', summary: '加一个导出按钮', generation: 2 }),
      context.reopen().open({ base: base(), sourceEventId: 'event-1', summary: '加一个导出按钮', generation: 2 })
    ]);

    assert.deepEqual([a.status, b.status].sort(), ['duplicate', 'opened']);
    assert.equal(context.store.list('session-1').length, 1);
  } finally {
    await context.cleanup();
  }
});

test('a closed session cannot open a change request', async () => {
  const context = await fixture();
  try {
    await context.persistence.setCollection('sessionLifecyclesBySession', {
      'session-1': {
        contractVersion: 'main-agent-collaboration/v1',
        sessionId: 'session-1',
        dataEpoch: 'epoch',
        generation: 2,
        revision: 2,
        state: 'active',
        admission: 'closed',
        stopStatus: 'stopping'
      }
    });

    const refused = await context.store.open({
      base: base(),
      sourceEventId: 'event-1',
      summary: 'x',
      generation: 2
    });

    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'SESSION_ADMISSION_CLOSED');
    assert.equal(context.store.list('session-1').length, 0, 'a refused open leaves nothing behind');
  } finally {
    await context.cleanup();
  }
});

test('a compound stop may persist its already-received suffix, but deletion still wins', async () => {
  const context = await fixture();
  try {
    await context.persistence.setCollection('sessionLifecyclesBySession', {
      'session-1': {
        contractVersion: 'main-agent-collaboration/v1',
        sessionId: 'session-1',
        dataEpoch: 'epoch',
        generation: 2,
        revision: 2,
        state: 'active',
        admission: 'closed',
        stopStatus: 'stopping'
      }
    });

    const accepted = await context.store.open({
      base: base(),
      sourceEventId: 'compound-event',
      summary: '另外把接口改成分页',
      generation: 2,
      allowStoppedAdmission: true
    });
    assert.equal(accepted.status, 'opened');

    await context.persistence.setCollection('sessionLifecyclesBySession', {
      'session-1': {
        contractVersion: 'main-agent-collaboration/v1',
        sessionId: 'session-1',
        dataEpoch: 'epoch',
        generation: 2,
        revision: 3,
        state: 'deleting',
        admission: 'closed',
        stopStatus: 'requested'
      }
    });
    const refused = await context.store.open({
      base: base(),
      sourceEventId: 'deleted-event',
      summary: '不应进入删除会话',
      generation: 2,
      allowStoppedAdmission: true
    });
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'SESSION_ADMISSION_CLOSED');
  } finally {
    await context.cleanup();
  }
});

test('a stale generation cannot open: a restored session must not replay a pre-restore message', async () => {
  const context = await fixture();
  try {
    const refused = await context.store.open({ base: base(), sourceEventId: 'event-1', summary: 'x', generation: 1 });

    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'CHANGE_REQUEST_STALE_GENERATION');
  } finally {
    await context.cleanup();
  }
});

test('an impact analysis is recorded against the versions it was produced for', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open({ base: base(), sourceEventId: 'event-1', summary: 'x', generation: 2 });
    const id = opened.status === 'opened' ? opened.request.id : '';

    const analysed = await context.store.recordAnalysis(id, {
      affectedTaskIds: ['task-1'],
      affectedFilePaths: ['src/export.ts'],
      affectedDocumentRevision: 2,
      explanation: '导出按钮会改动前端与接口层',
      options: ['pause_and_revise', 'defer', 'reject']
    });

    assert.equal(analysed.status, 'applied');
    const stored = context.store.get('session-1', id)!;
    assert.equal(stored.status, 'waiting_user');
    assert.equal(stored.analysis?.analysisRevision, 1);
    assert.deepEqual(stored.analysis?.base, base(), 'the analysis pins the versions it read');
  } finally {
    await context.cleanup();
  }
});

test('an analysis produced against a superseded requirement is refused, not shown to the user', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open({ base: base(), sourceEventId: 'event-1', summary: 'x', generation: 2 });
    const id = opened.status === 'opened' ? opened.request.id : '';

    // The run moved on while the coordinator was analysing.
    const refused = await context.store.recordAnalysis(id, {
      affectedTaskIds: [],
      affectedFilePaths: [],
      affectedDocumentRevision: 2,
      explanation: 'x',
      options: ['defer'],
      current: base({ workItemRevision: 4 })
    });

    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'CHANGE_ANALYSIS_STALE');
    assert.equal(context.store.get('session-1', id)?.status, 'received', 'a refused analysis does not advance the request');
  } finally {
    await context.cleanup();
  }
});

test('the user choice is recorded once and a replayed click returns the same state', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open({ base: base(), sourceEventId: 'event-1', summary: 'x', generation: 2 });
    const id = opened.status === 'opened' ? opened.request.id : '';
    await context.store.recordAnalysis(id, {
      affectedTaskIds: [],
      affectedFilePaths: [],
      affectedDocumentRevision: 2,
      explanation: 'x',
      options: ['pause_and_revise', 'defer', 'reject']
    });

    const chosen = await context.store.recordChoice(id, { choice: 'pause_and_revise', confirmationId: 'confirm-1' });
    assert.equal(chosen.status, 'applied');
    assert.equal(context.store.get('session-1', id)?.status, 'stopping');

    const replay = await context.store.recordChoice(id, { choice: 'pause_and_revise', confirmationId: 'confirm-1' });
    assert.equal(replay.status, 'idempotent', 'a double click is the same decision');

    // A different choice on an already-decided request must not overwrite it.
    const conflicting = await context.store.recordChoice(id, { choice: 'reject', confirmationId: 'confirm-1' });
    assert.equal(conflicting.status, 'rejected');
    assert.equal(context.store.get('session-1', id)?.choice, 'pause_and_revise', 'the first decision stays authoritative');
  } finally {
    await context.cleanup();
  }
});

test('a choice the analysis never offered is refused', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open({ base: base(), sourceEventId: 'event-1', summary: 'x', generation: 2 });
    const id = opened.status === 'opened' ? opened.request.id : '';
    await context.store.recordAnalysis(id, {
      affectedTaskIds: [],
      affectedFilePaths: [],
      affectedDocumentRevision: 2,
      explanation: 'x',
      options: ['defer', 'reject']
    });

    const refused = await context.store.recordChoice(id, { choice: 'pause_and_revise', confirmationId: 'confirm-1' });

    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'CHANGE_CHOICE_NOT_OFFERED');
  } finally {
    await context.cleanup();
  }
});

test('a deferred change is picked up again only through a fresh analysis', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open({ base: base(), sourceEventId: 'event-1', summary: 'x', generation: 2 });
    const id = opened.status === 'opened' ? opened.request.id : '';
    await context.store.recordAnalysis(id, {
      affectedTaskIds: [], affectedFilePaths: [], affectedDocumentRevision: 2, explanation: 'x',
      options: ['defer', 'pause_and_revise']
    });
    await context.store.recordChoice(id, { choice: 'defer', confirmationId: 'confirm-1' });
    assert.equal(context.store.get('session-1', id)?.status, 'deferred');

    // The run finished; the deferred change is analysed again against the new
    // state rather than executing on its old analysis.
    assert.deepEqual(context.store.deferred('session-1').map((item) => item.id), [id]);
    const reopened = await context.store.recordAnalysis(id, {
      affectedTaskIds: [], affectedFilePaths: [], affectedDocumentRevision: 3, explanation: 'y',
      options: ['pause_and_revise'],
      current: base({ workItemRevision: 3, documentRevision: 2 })
    });
    assert.equal(reopened.status, 'applied');
    assert.equal(context.store.get('session-1', id)?.analysis?.analysisRevision, 2, 'the second analysis is its own revision');
  } finally {
    await context.cleanup();
  }
});

test('a pending change survives a restart with its analysis and choice intact', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open({ base: base(), sourceEventId: 'event-1', summary: 'x', generation: 2 });
    const id = opened.status === 'opened' ? opened.request.id : '';
    await context.store.recordAnalysis(id, {
      affectedTaskIds: ['task-1'], affectedFilePaths: [], affectedDocumentRevision: 2, explanation: 'x',
      options: ['pause_and_revise', 'defer']
    });
    await context.store.recordChoice(id, { choice: 'pause_and_revise', confirmationId: 'confirm-1' });

    const afterRestart = context.reopen();
    const restored = afterRestart.get('session-1', id)!;
    assert.equal(restored.status, 'stopping');
    assert.equal(restored.choice, 'pause_and_revise');
    assert.deepEqual(restored.analysis?.affectedTaskIds, ['task-1']);
    // Nothing re-runs a model on restart: the open work is what is still unresolved.
    assert.deepEqual(afterRestart.unresolved('session-1').map((item) => item.id), [id]);
  } finally {
    await context.cleanup();
  }
});

test('stored requests carry versions and a summary, never a model transcript', async () => {
  const context = await fixture();
  try {
    await context.store.open({
      base: base(),
      sourceEventId: 'event-1',
      summary: '加一个导出按钮',
      generation: 2
    });

    const serialized = JSON.stringify(context.store.list('session-1'));
    assert.equal(serialized.includes('加一个导出按钮'), true, 'the user summary is the record');
    assert.equal(/reasoning|chain of thought|prompt/i.test(serialized), false, 'no model transcript is stored');
  } finally {
    await context.cleanup();
  }
});

/** Moves the session's lifecycle to a state the fencing must respect. */
async function setLifecycle(
  context: Awaited<ReturnType<typeof fixture>>,
  overrides: { state?: string; admission?: string; generation?: number }
) {
  await context.persistence.setCollection('sessionLifecyclesBySession', {
    'session-1': {
      contractVersion: 'main-agent-collaboration/v1',
      sessionId: 'session-1',
      dataEpoch: 'epoch',
      generation: overrides.generation ?? 2,
      revision: 3,
      state: overrides.state ?? 'active',
      admission: overrides.admission ?? 'open',
      stopStatus: 'idle'
    }
  });
}

test('a late analysis arriving after the session was deleted is refused, not recorded', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open({ base: base(), sourceEventId: 'event-1', summary: 'x', generation: 2 });
    const id = opened.status === 'opened' ? opened.request.id : '';

    // The coordinator was analysing while the user deleted the session. The
    // callback must not resurrect work on a deleted session (AC7).
    await setLifecycle(context, { state: 'deleting', admission: 'closed' });
    const refused = await context.store.recordAnalysis(id, {
      affectedTaskIds: [], affectedFilePaths: [], affectedDocumentRevision: 2,
      explanation: 'x', options: ['pause_and_revise']
    });

    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'SESSION_ADMISSION_CLOSED');
    assert.equal(context.store.get('session-1', id)?.status, 'received', 'the request is untouched');
    assert.equal(context.store.get('session-1', id)?.analysis, undefined, 'no analysis is stored for a deleted session');
  } finally {
    await context.cleanup();
  }
});

test('a choice submitted after the session was deleted is refused', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open({ base: base(), sourceEventId: 'event-1', summary: 'x', generation: 2 });
    const id = opened.status === 'opened' ? opened.request.id : '';
    await context.store.recordAnalysis(id, {
      affectedTaskIds: [], affectedFilePaths: [], affectedDocumentRevision: 2,
      explanation: 'x', options: ['pause_and_revise', 'defer']
    });
    await setLifecycle(context, { state: 'deleting', admission: 'closed' });

    const refused = await context.store.recordChoice(id, { choice: 'pause_and_revise', confirmationId: 'confirm-1' });

    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'SESSION_ADMISSION_CLOSED');
    assert.equal(context.store.get('session-1', id)?.choice, undefined, 'no decision is recorded after deletion');
  } finally {
    await context.cleanup();
  }
});

test('an analysis from a pre-restore generation cannot land on a restored session', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open({ base: base(), sourceEventId: 'event-1', summary: 'x', generation: 2 });
    const id = opened.status === 'opened' ? opened.request.id : '';

    // A restore bumps the generation. The in-flight analysis belongs to the run
    // that no longer exists, so it must not be presented as current.
    await setLifecycle(context, { generation: 3 });
    const refused = await context.store.recordAnalysis(id, {
      affectedTaskIds: [], affectedFilePaths: [], affectedDocumentRevision: 2,
      explanation: 'x', options: ['pause_and_revise']
    });

    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'CHANGE_REQUEST_STALE_GENERATION');
  } finally {
    await context.cleanup();
  }
});

test('a restart keeps the user choice and the finished analysis without replaying a model', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open({ base: base(), sourceEventId: 'event-1', summary: 'x', generation: 2 });
    const id = opened.status === 'opened' ? opened.request.id : '';
    await context.store.recordAnalysis(id, {
      affectedTaskIds: ['task-1'], affectedFilePaths: ['src/export.ts'], affectedDocumentRevision: 2,
      explanation: '导出按钮会改动前端与接口层', options: ['pause_and_revise', 'defer']
    });
    await context.store.recordChoice(id, { choice: 'defer', confirmationId: 'confirm-1' });

    const afterRestart = context.reopen();
    const restored = afterRestart.get('session-1', id)!;

    // The analysis is evidence already produced: a restart reads it, it does not
    // recompute it (AC7).
    assert.equal(restored.choice, 'defer');
    assert.equal(restored.status, 'deferred');
    assert.equal(restored.analysis?.explanation, '导出按钮会改动前端与接口层');
    assert.deepEqual(restored.analysis?.affectedFilePaths, ['src/export.ts']);
    assert.equal(restored.analysis?.analysisRevision, 1, 'the stored revision is reused, not bumped by a restart');
    assert.deepEqual(afterRestart.deferred('session-1').map((item) => item.id), [id]);
  } finally {
    await context.cleanup();
  }
});

test('a deleted session keeps its queue readable for audit but offers nothing to act on', async () => {
  const context = await fixture();
  try {
    const opened = await context.store.open({ base: base(), sourceEventId: 'event-1', summary: 'x', generation: 2 });
    const id = opened.status === 'opened' ? opened.request.id : '';
    await setLifecycle(context, { state: 'deleted', admission: 'closed' });

    // The record stays for audit; every mutation is closed.
    assert.equal(context.store.get('session-1', id)?.id, id, 'the record remains readable');
    const refused = await context.store.transition(id, 'analyzing');
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'SESSION_ADMISSION_CLOSED');
  } finally {
    await context.cleanup();
  }
});
