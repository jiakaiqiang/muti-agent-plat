import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SystemDataMetadata } from '@agent-cluster/shared';
import { PersistenceService } from './persistence.service.js';
import {
  CUTOVER_METADATA_COLLECTION,
  PersistenceCutoverService,
  assertArtifactPathWithinDataRoot
} from './persistence-cutover.service.js';

function fixtureState() {
  return {
    sessions: [{ id: 'session-old' }],
    eventsBySession: { 'session-old': [{ id: 'event-old' }] },
    artifacts: [{ id: 'artifact-old' }]
  };
}

function setup(
  initialState: Record<string, unknown> = fixtureState(),
  environment = 'test-file',
  executeCleanup?: () => { deletedCount: number; missingCount: number }
) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-cutover-'));
  const archiveDirectory = `${directory}-archive`;
  const filePath = join(directory, 'state.json');
  writeFileSync(filePath, `${JSON.stringify(initialState, null, 2)}\n`, 'utf8');
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath });
  const ids = ['epoch-v2', 'audit-v2'];
  const cutover = new PersistenceCutoverService(persistence, {
    environment,
    tokenSecret: 'test-secret-with-sufficient-entropy',
    now: () => '2026-07-12T12:00:00.000Z',
    randomId: () => ids.shift() ?? 'unused-id',
    archiveDirectory,
    archiveSecret: 'archive-secret-with-sufficient-entropy',
    ...(executeCleanup ? { executeArtifactCleanup: executeCleanup } : {})
  });
  return {
    directory,
    archiveDirectory,
    filePath,
    persistence,
    cutover,
    async initialize() {
      await persistence.initialize();
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
      rmSync(archiveDirectory, { recursive: true, force: true });
    }
  };
}

test('startup gate rejects persisted state without schema-v3 metadata', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    assert.throws(() => fixture.persistence.assertCurrentDataReady(), /CUTOVER_REQUIRED/);
  } finally {
    fixture.cleanup();
  }
});

test('startup gate accepts exact schema-v3 metadata', async () => {
  const metadata: SystemDataMetadata = {
    dataSchemaVersion: 3,
    dataEpoch: 'epoch-ready',
    pipelineVersion: 'v2',
    cutoverAt: '2026-07-12T12:00:00.000Z',
    cutoverAuditId: 'audit-ready'
  };
  const fixture = setup({ [CUTOVER_METADATA_COLLECTION]: metadata });
  try {
    await fixture.initialize();
    assert.deepEqual(fixture.persistence.assertCurrentDataReady(), metadata);
  } finally {
    fixture.cleanup();
  }
});

test('inventory reports collection counts and a deterministic revision', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    const first = fixture.cutover.inventory();
    const second = fixture.cutover.inventory();
    assert.deepEqual(first.collections, [
      { key: 'artifacts', itemCount: 1 },
      { key: 'eventsBySession', itemCount: 1 },
      { key: 'sessions', itemCount: 1 }
    ]);
    assert.equal(first.revision, second.revision);
    assert.match(first.revision, /^[a-f0-9]{64}$/);
  } finally {
    fixture.cleanup();
  }
});

test('dry-run performs zero persistence writes', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    const before = readFileSync(fixture.filePath, 'utf8');
    const report = fixture.cutover.dryRun();
    const after = readFileSync(fixture.filePath, 'utf8');
    assert.equal(after, before);
    assert.equal(report.environment, 'test-file');
    assert.equal(report.backend, 'file');
    assert.ok(report.confirmToken.length > 40);
  } finally {
    fixture.cleanup();
  }
});

test('maintenance mode blocks ordinary collection writes', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    fixture.persistence.enterMaintenanceMode();
    assert.throws(() => fixture.persistence.setCollection('sessions', []), /MAINTENANCE_MODE/);
  } finally {
    fixture.cleanup();
  }
});

test('apply rejects a dry-run token bound to another environment', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    const report = fixture.cutover.dryRun();
    const other = new PersistenceCutoverService(fixture.persistence, {
      environment: 'production',
      tokenSecret: 'test-secret-with-sufficient-entropy',
      archiveDirectory: fixture.archiveDirectory,
      archiveSecret: 'archive-secret-with-sufficient-entropy'
    });
    fixture.persistence.enterMaintenanceMode();
    await assert.rejects(() => other.apply({ confirmToken: report.confirmToken }), /CUTOVER_ENVIRONMENT_MISMATCH/);
  } finally {
    fixture.cleanup();
  }
});

test('apply rejects a stale dry-run revision', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    const report = fixture.cutover.dryRun();
    fixture.persistence.setCollection('sessions', [{ id: 'session-newer' }]);
    fixture.persistence.enterMaintenanceMode();
    await assert.rejects(() => fixture.cutover.apply({ confirmToken: report.confirmToken }), /CUTOVER_STALE_DRY_RUN/);
  } finally {
    fixture.cleanup();
  }
});

test('file apply atomically replaces old state with schema-v3 seeds and audit metadata', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    const report = fixture.cutover.dryRun();
    fixture.persistence.enterMaintenanceMode();
    const result = await fixture.cutover.apply({
      confirmToken: report.confirmToken,
      seedState: { agents: [{ id: 'agent-v2' }] }
    });
    const persisted = JSON.parse(readFileSync(fixture.filePath, 'utf8')) as Record<string, unknown>;
    assert.equal(result.status, 'applied');
    assert.deepEqual(
      Object.keys(persisted).sort(),
      ['agents', 'cutoverAudits', CUTOVER_METADATA_COLLECTION].sort()
    );
    assert.deepEqual(persisted.agents, [{ id: 'agent-v2' }]);
    assert.equal(persisted.sessions, undefined);
    assert.equal(persisted.eventsBySession, undefined);
    assert.equal(persisted.artifacts, undefined);
    assert.deepEqual(persisted[CUTOVER_METADATA_COLLECTION], result.metadata);
    assert.ok(result.archive);
    assert.match(result.archive.manifest.encryptedSha256, /^[a-f0-9]{64}$/);
  } finally {
    fixture.cleanup();
  }
});

test('reusing a successfully applied token is idempotent', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    const report = fixture.cutover.dryRun();
    fixture.persistence.enterMaintenanceMode();
    const first = await fixture.cutover.apply({ confirmToken: report.confirmToken });
    const second = await fixture.cutover.apply({ confirmToken: report.confirmToken });
    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'already_applied');
    assert.deepEqual(second.metadata, first.metadata);
  } finally {
    fixture.cleanup();
  }
});

test('reusing a partially applied token retries pending Artifact cleanup', async () => {
  let failCleanup = true;
  const fixture = setup(fixtureState(), 'test-cleanup-retry', () => {
    if (failCleanup) throw new Error('injected cleanup failure');
    return { deletedCount: 0, missingCount: 0 };
  });
  try {
    await fixture.initialize();
    const report = fixture.cutover.dryRun();
    fixture.persistence.enterMaintenanceMode();
    await assert.rejects(() => fixture.cutover.apply({ confirmToken: report.confirmToken }), /injected cleanup failure/);
    const pending = fixture.persistence.getCollection<Array<{ result: string }>>('cutoverAudits', []);
    assert.equal(pending[0]?.result, 'cleanup_pending');

    failCleanup = false;
    const retried = await fixture.cutover.apply({ confirmToken: report.confirmToken });
    assert.equal(retried.status, 'already_applied');
    const completed = fixture.persistence.getCollection<Array<{ result: string }>>('cutoverAudits', []);
    assert.equal(completed[0]?.result, 'applied');
  } finally {
    fixture.cleanup();
  }
});

test('artifact deletion guard accepts only paths inside the platform data root', () => {
  const root = join(tmpdir(), 'agent-cluster-data-root');
  assert.equal(assertArtifactPathWithinDataRoot(root, join(root, 'artifacts', 'report.md')), join(root, 'artifacts', 'report.md'));
  assert.throws(() => assertArtifactPathWithinDataRoot(root, join(root, '..', 'workspace', 'source.ts')), /ARTIFACT_PATH_OUTSIDE_DATA_ROOT/);
  assert.throws(() => assertArtifactPathWithinDataRoot(root, 'https://example.com/report.md'), /ARTIFACT_PATH_EXTERNAL_URI/);
});
