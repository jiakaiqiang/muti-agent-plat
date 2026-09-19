import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RequirementDocumentSections } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { REQUIREMENT_DOCUMENTS_COLLECTION, RequirementDocumentStore } from './requirement-document-store.js';

const sections: RequirementDocumentSections = {
  goal: '实现导出功能。',
  scope: ['导出 Excel'],
  outOfScope: [],
  acceptanceCriteria: ['文件可打开'],
  risks: [],
  pendingItems: []
};

async function fixture(options: { admission?: 'open' | 'closed' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'requirement-document-store-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  await persistence.setCollection('sessions', [{ id: 'session-1', decisionLedgerRevision: 0 }]);
  await persistence.setCollection('workItemsBySession', { 'session-1': [{ id: 'wi-1', revision: 3 }] });
  await persistence.setCollection('sessionLifecyclesBySession', {
    'session-1': {
      contractVersion: 'main-agent-collaboration/v1', sessionId: 'session-1', dataEpoch: 'epoch',
      generation: 1, revision: 1, state: 'active', admission: options.admission ?? 'open', stopStatus: 'idle'
    }
  });
  let tick = 0;
  return {
    persistence,
    directory,
    store: new RequirementDocumentStore(persistence, () => `2026-09-19T00:00:${String(tick++).padStart(2, '0')}.000Z`),
    async cleanup() {
      await persistence.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

const draft = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'session-1',
  workItemId: 'wi-1',
  workItemRevision: 3,
  publishedByAgentId: 'coordinator',
  sourceBriefId: 'brief-1',
  sourceDecisionIds: ['d-1'],
  sourceDelegationIds: ['del-1'],
  sections,
  ...overrides
});

test('publishing creates an immutable formal version with a server-computed hash', async () => {
  const context = await fixture();
  try {
    const published = await context.store.publish(draft());
    assert.equal(published.status, 'published');
    if (published.status !== 'published') return;
    assert.equal(published.document.documentRevision, 1);
    assert.equal(published.document.status, 'formal');
    assert.match(published.document.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(published.document.sourceBriefId, 'brief-1');

    const stored = context.persistence.getCollection<Record<string, unknown[]>>(REQUIREMENT_DOCUMENTS_COLLECTION, {});
    assert.equal(stored['session-1']?.length, 1);
  } finally {
    await context.cleanup();
  }
});

test('the same content published twice is one version, not two', async () => {
  const context = await fixture();
  try {
    const [a, b] = await Promise.all([context.store.publish(draft()), context.store.publish(draft())]);
    assert.deepEqual([a.status, b.status].sort(), ['duplicate', 'published']);
    assert.equal(context.store.list('session-1', 'wi-1').length, 1);
  } finally {
    await context.cleanup();
  }
});

test('changed content becomes the next revision and supersedes the previous one', async () => {
  const context = await fixture();
  try {
    const v1 = await context.store.publish(draft());
    if (v1.status !== 'published') return;
    const v2 = await context.store.publish(draft({ sections: { ...sections, goal: '实现导出与导入功能。' } }));
    assert.equal(v2.status, 'published');
    if (v2.status !== 'published') return;
    assert.equal(v2.document.documentRevision, 2);
    assert.notEqual(v2.document.contentHash, v1.document.contentHash);

    const docs = context.store.list('session-1', 'wi-1');
    assert.equal(docs.find((item) => item.id === v1.document.id)?.status, 'superseded', 'the old version is history, not deleted');
    assert.equal(context.store.latest('session-1', 'wi-1')?.id, v2.document.id);
  } finally {
    await context.cleanup();
  }
});

test('a document written against an older requirement revision is refused and not stored', async () => {
  const context = await fixture();
  try {
    const stale = await context.store.publish(draft({ workItemRevision: 2 }));
    assert.equal(stale.status, 'rejected');
    if (stale.status !== 'rejected') return;
    assert.equal(stale.code, 'DOCUMENT_STALE_REQUIREMENT');
    assert.equal(context.store.list('session-1', 'wi-1').length, 0);
  } finally {
    await context.cleanup();
  }
});

test('invalid sections are refused before anything is hashed or stored', async () => {
  const context = await fixture();
  try {
    const bad = await context.store.publish(draft({ sections: { ...sections, goal: '' } }));
    assert.equal(bad.status, 'rejected');
    if (bad.status !== 'rejected') return;
    assert.equal(bad.code, 'DOCUMENT_SECTIONS_INVALID');
  } finally {
    await context.cleanup();
  }
});

test('a closed session admission refuses publication', async () => {
  const context = await fixture({ admission: 'closed' });
  try {
    const refused = await context.store.publish(draft());
    assert.equal(refused.status, 'rejected');
    if (refused.status !== 'rejected') return;
    assert.equal(refused.code, 'SESSION_ADMISSION_CLOSED');
  } finally {
    await context.cleanup();
  }
});

test('confirmation moves formal to confirmed once; replay is idempotent; a superseded version cannot be confirmed', async () => {
  const context = await fixture();
  try {
    const v1 = await context.store.publish(draft());
    if (v1.status !== 'published') return;

    const confirmed = await context.store.confirm(v1.document.id, { confirmationId: 'confirm-1' });
    assert.equal(confirmed.status, 'applied');
    assert.equal(context.store.get('session-1', v1.document.id)?.status, 'confirmed');
    assert.equal(context.store.get('session-1', v1.document.id)?.confirmedAt, '2026-09-19T00:00:01.000Z');

    const replay = await context.store.confirm(v1.document.id, { confirmationId: 'confirm-1' });
    assert.equal(replay.status, 'idempotent');

    const v2 = await context.store.publish(draft({ sections: { ...sections, goal: 'v2' } }));
    if (v2.status !== 'published') return;
    assert.equal(context.store.get('session-1', v1.document.id)?.status, 'superseded', 'a new revision supersedes even a confirmed one');
    const late = await context.store.confirm(v1.document.id, { confirmationId: 'confirm-late' });
    assert.equal(late.status, 'rejected');
    if (late.status !== 'rejected') return;
    assert.equal(late.code, 'DOCUMENT_INVALID_TRANSITION');
  } finally {
    await context.cleanup();
  }
});

test('documents survive a restart', async () => {
  const first = await fixture();
  let documentId = '';
  try {
    const v1 = await first.store.publish(draft());
    if (v1.status !== 'published') return;
    documentId = v1.document.id;
    await first.persistence.onModuleDestroy();

    const reopened = new PersistenceService({ enabled: true, backend: 'file', filePath: join(first.directory, 'state.json') });
    await reopened.initialize();
    const store = new RequirementDocumentStore(reopened);
    assert.equal(store.get('session-1', documentId)?.contentHash, v1.document.contentHash);
    await reopened.onModuleDestroy();
  } finally {
    rmSync(first.directory, { recursive: true, force: true });
  }
});
