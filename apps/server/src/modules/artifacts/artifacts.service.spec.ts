import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { createRuntimeArtifactOutput, createRuntimeArtifactSystemEvidence, type Artifact, type SessionDetail } from '@agent-cluster/shared';
import { ArtifactsService } from './artifacts.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { appendArtifactInDraft } from './artifact-store.js';

function persistence(artifactsById: Record<string, unknown> = {}) {
  const collections = new Map<string, unknown>([
    ['artifacts', { artifactsById, artifactIdsBySession: {} }]
  ]);
  return {
    currentDataEpoch: () => 'epoch-current',
    getCollection<T>(name: string, fallback: T): T {
      return (collections.get(name) as T | undefined) ?? fallback;
    },
    setCollection(name: string, value: unknown) {
      collections.set(name, value);
    },
    async mutateCollections<T>(_keys: string[], mutate: (draft: Record<string, any>) => T) {
      const draft = Object.fromEntries(collections);
      draft.sessions = [{ id: 'session-1', dataEpoch: 'epoch-current' }];
      const result = mutate(draft);
      for (const [key, value] of Object.entries(draft)) collections.set(key, value);
      return result;
    }
  };
}

function persistedArtifact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'artifact-current',
    dataEpoch: 'epoch-current',
    sessionId: 'session-1',
    type: 'json',
    title: 'current artifact',
    metadata: { phase: 'task_execution' },
    runtimeProposals: [],
    platformProjections: [],
    systemEvidence: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    ...overrides
  };
}

test('Artifact persists proposal, platform projection, and system evidence in separate domains with dataEpoch', async () => {
  const service = new ArtifactsService(persistence() as never);
  const proposal = createRuntimeArtifactOutput({ type: 'code_diff', title: 'proposal', content: 'update src/a.ts' });
  const systemEvidence = createRuntimeArtifactSystemEvidence('invocation-1');
  const platformProjections = [{ path: 'agent-output/report.md', operation: 'create' as const, content: '# report' }];
  const artifact = await service.create({
    sessionId: 'session-1',
    type: 'json',
    title: 'execution',
    metadata: { phase: 'task_execution' },
    runtimeProposals: [proposal],
    platformProjections,
    systemEvidence
  });

  assert.equal(artifact.dataEpoch, 'epoch-current');
  assert.deepEqual(artifact.runtimeProposals, [proposal]);
  assert.deepEqual(artifact.platformProjections, platformProjections);
  assert.deepEqual(artifact.systemEvidence, systemEvidence);
  assert.equal('systemEvidence' in artifact.metadata, false);
  assert.equal('runtimeProposals' in artifact.metadata, false);
  assert.equal('platformProjections' in artifact.metadata, false);
});

test('Artifact startup gate rejects persisted records without dataEpoch', () => {
  assert.throws(
    () => new ArtifactsService(persistence({ legacy: { id: 'legacy' } }) as never),
    /CUTOVER_REQUIRED: persisted Artifact has no dataEpoch/
  );
});

test('Artifact startup gate rejects a stale dataEpoch', () => {
  assert.throws(
    () => new ArtifactsService(persistence({ stale: { id: 'stale', dataEpoch: 'epoch-old' } }) as never),
    /STALE_DATA_EPOCH/
  );
});

test('Artifact startup gate rejects records without the platform projection domain', () => {
  assert.throws(
    () => new ArtifactsService(persistence({
      legacy: {
        id: 'legacy',
        dataEpoch: 'epoch-current',
        metadata: { phase: 'task_execution' },
        runtimeProposals: [],
        systemEvidence: null
      }
    }) as never),
    /CUTOVER_REQUIRED: persisted Artifact does not satisfy the v3 contract/
  );
});

test('Artifact startup gate accepts a persisted current three-domain record', () => {
  const artifact = persistedArtifact();
  const service = new ArtifactsService(persistence({ [artifact.id]: artifact }) as never);
  assert.deepEqual(service.get(artifact.id), artifact);
});

test('Artifact startup gate rejects the removed top-level fileChanges field even when all current domains exist', () => {
  assert.throws(
    () => new ArtifactsService(persistence({
      mixed: persistedArtifact({ fileChanges: [] })
    }) as never),
    /CUTOVER_REQUIRED: persisted Artifact does not satisfy the v3 contract/
  );
});

test('Artifact startup gate rejects removed or misplaced metadata trust-domain fields', () => {
  for (const field of [
    'output',
    'fileChanges',
    'validationEvidence',
    'runtimeProposals',
    'platformProjections',
    'systemEvidence'
  ]) {
    assert.throws(
      () => new ArtifactsService(persistence({
        [field]: persistedArtifact({
          metadata: { phase: 'task_execution', [field]: field === 'output' ? {} : [] }
        })
      }) as never),
      /CUTOVER_REQUIRED: persisted Artifact does not satisfy the v3 contract/,
      `persisted Artifact accepted forbidden metadata.${field}`
    );
  }
});

async function fileFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'intent-artifact-transaction-'));
  const store = new PersistenceService({ backend: 'file', filePath: join(root, 'state.json') }); await store.initialize();
  t.after(async () => { await store.onModuleDestroy(); const child = relative(resolve(tmpdir()), resolve(root));
    assert.ok(child.startsWith('intent-artifact-transaction-') && !child.includes('..') && !isAbsolute(child)); await rm(root, { force: true, recursive: true }); });
  await store.setCollection('systemDataMetadata', { dataSchemaVersion: 3, dataEpoch: 'artifact-test-epoch', pipelineVersion: 'v2',
    cutoverAt: new Date().toISOString(), cutoverAuditId: 'artifact-test' });
  await store.setCollection('sessions', [{ id: 'session-1', dataEpoch: store.currentDataEpoch(), status: 'PAUSED' }]);
  const input = { sessionId: 'session-1', type: 'test_report' as const, title: '测试报告', metadata: { phase: 'task_execution' as const } };
  return { store, input, service: new ArtifactsService(store) };
}

test('artifact readers observe a transaction-published report and later legacy creation cannot overwrite it', async t => {
  const f = await fileFixture(t), other = new ArtifactsService(f.store);
  const report = { ...persistedArtifact(), dataEpoch: f.store.currentDataEpoch(), id: 'transaction-report' } as Artifact;
  await f.store.mutateCollections(['artifacts', 'sessions', 'sessionLifecyclesBySession'], draft => appendArtifactInDraft(draft, report));
  assert.equal(f.service.get(report.id).id, report.id);
  const created = await Promise.all([f.service.create(f.input), other.create({ ...f.input, title: '并发报告' })]);
  assert.equal(new Set(f.service.listBySession('session-1').map(row => row.id)).size, 3);
  assert.ok(created.every(row => other.get(row.id)));
  await f.store.deleteSessionData('session-1');
  assert.deepEqual(f.service.listBySession('session-1'), []);
  assert.throws(() => other.get(report.id), /Artifact not found/);
  await assert.rejects(other.create(f.input), /ARTIFACT_SESSION_UNAVAILABLE/);
});

test('artifact write failure rejects creation and never exposes an optimistic cached result', async t => {
  const f = await fileFixture(t), write = (f.store as any).writeFileState;
  (f.store as any).writeFileState = () => { throw new Error('injected artifact storage failure'); };
  try { await assert.rejects(f.service.create(f.input), /injected artifact storage failure/); }
  finally { (f.store as any).writeFileState = write; }
  assert.deepEqual(f.service.listBySession('session-1'), []);
  assert.deepEqual(f.store.getCollection('artifacts', { artifactsById: {}, artifactIdsBySession: {} }), { artifactsById: {}, artifactIdsBySession: {} });
});

test('artifact creation checks live lifecycle and session epoch inside the write transaction', async t => {
  for (const change of ['cancel', 'archive', 'epoch', 'deleting']) {
    const f = await fileFixture(t);
    await f.store.mutateCollections(['sessions', 'sessionLifecyclesBySession'], draft => {
      const session = (draft.sessions as SessionDetail[])[0];
      if (change === 'cancel') session.status = 'CANCELLED';
      if (change === 'archive') session.archivedAt = new Date().toISOString();
      if (change === 'epoch') session.dataEpoch = 'other';
      if (change === 'deleting') draft.sessionLifecyclesBySession = { 'session-1': { state: 'deleting', dataEpoch: session.dataEpoch } };
    });
    await assert.rejects(f.service.create(f.input), /ARTIFACT_SESSION_UNAVAILABLE/, change);
    assert.deepEqual(f.service.listBySession('session-1'), []);
  }
});

test('artifact transaction primitive deduplicates an exact receipt and rejects identity replacement', async t => {
  const f = await fileFixture(t), report = { ...persistedArtifact(), dataEpoch: f.store.currentDataEpoch() } as Artifact;
  const append = (value: Artifact) => f.store.mutateCollections(['artifacts', 'sessions', 'sessionLifecyclesBySession'], draft => appendArtifactInDraft(draft, value));
  await append(report); await append(report);
  assert.equal(f.service.listBySession('session-1').length, 1);
  await assert.rejects(append({ ...report, title: '覆盖历史' }), /ARTIFACT_IDENTITY_CONFLICT/);
  assert.equal(f.service.get(report.id).title, report.title);
});
