import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CUTOVER_AUDIT_COLLECTION,
  PersistenceCutoverService
} from './persistence-cutover.service.js';
import { PersistenceService } from './persistence.service.js';

function setup(artifactUri = 'artifacts/report.md') {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-cutover-audit-'));
  const dataRoot = join(directory, 'data');
  const filePath = join(dataRoot, 'state.json');
  const artifactPath = join(dataRoot, 'artifacts', 'report.md');
  mkdirSync(join(dataRoot, 'artifacts'), { recursive: true });
  writeFileSync(artifactPath, 'artifact content must not enter audit', 'utf8');
  const state = {
    sessions: [{ id: 'session-sensitive', title: 'sensitive title' }],
    eventsBySession: { 'session-sensitive': [{ content: 'sensitive event body' }] },
    artifacts: [{ id: 'artifact-1', uri: artifactUri }]
  };
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath });
  const ids = ['epoch-v2', 'audit-v2'];
  const cutover = new PersistenceCutoverService(persistence, {
    environment: 'integration-test',
    tokenSecret: 'integration-secret-with-entropy',
    dataRoot,
    archiveDirectory: join(directory, 'archive'),
    archiveSecret: 'archive-secret-with-sufficient-entropy',
    operator: 'test-operator',
    commit: 'abc123',
    now: () => '2026-07-12T12:00:00.000Z',
    randomId: () => ids.shift() ?? 'unused'
  });
  return {
    directory,
    dataRoot,
    filePath,
    artifactPath,
    persistence,
    cutover,
    async initialize() { await persistence.initialize(); },
    cleanup() { rmSync(directory, { recursive: true, force: true }); }
  };
}

test('dry-run reports deletable Artifact count without deleting files', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    const report = fixture.cutover.dryRun();
    assert.deepEqual(report.artifactCleanup, { deletableCount: 1, blockedCount: 0 });
    assert.equal(existsSync(fixture.artifactPath), true);
  } finally { fixture.cleanup(); }
});

test('dry-run reports blocked Artifact paths without exposing those paths', async () => {
  const fixture = setup('../workspace/secret.md');
  try {
    await fixture.initialize();
    const report = fixture.cutover.dryRun();
    assert.deepEqual(report.artifactCleanup, { deletableCount: 0, blockedCount: 1 });
    assert.doesNotMatch(JSON.stringify(report), /workspace|secret\.md/);
  } finally { fixture.cleanup(); }
});

test('apply rejects blocked Artifact paths before replacing persistence state', async () => {
  const fixture = setup('../workspace/secret.md');
  try {
    await fixture.initialize();
    const before = readFileSync(fixture.filePath, 'utf8');
    const report = fixture.cutover.dryRun();
    fixture.persistence.enterMaintenanceMode();
    await assert.rejects(() => fixture.cutover.apply({ confirmToken: report.confirmToken }), /ARTIFACT_CLEANUP_BLOCKED/);
    assert.equal(readFileSync(fixture.filePath, 'utf8'), before);
  } finally { fixture.cleanup(); }
});

test('successful apply deletes guarded Artifact files after state replacement', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    const report = fixture.cutover.dryRun();
    fixture.persistence.enterMaintenanceMode();
    const result = await fixture.cutover.apply({ confirmToken: report.confirmToken });
    assert.equal(result.artifactCleanup.deletedCount, 1);
    assert.equal(existsSync(fixture.artifactPath), false);
  } finally { fixture.cleanup(); }
});

test('persisted cutover audit contains only operational metadata', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    const report = fixture.cutover.dryRun();
    fixture.persistence.enterMaintenanceMode();
    await fixture.cutover.apply({ confirmToken: report.confirmToken });
    const state = JSON.parse(readFileSync(fixture.filePath, 'utf8')) as Record<string, unknown>;
    const serializedAudit = JSON.stringify(state[CUTOVER_AUDIT_COLLECTION]);
    assert.match(serializedAudit, /integration-test|test-operator|abc123|epoch-v2|audit-v2/);
    assert.doesNotMatch(serializedAudit, /sensitive|event body|artifact content|report\.md/);
  } finally { fixture.cleanup(); }
});

test('cutover audit records per-collection deletion counts', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    const report = fixture.cutover.dryRun();
    fixture.persistence.enterMaintenanceMode();
    await fixture.cutover.apply({ confirmToken: report.confirmToken });
    const state = JSON.parse(readFileSync(fixture.filePath, 'utf8')) as Record<string, unknown>;
    const audits = state[CUTOVER_AUDIT_COLLECTION] as Array<{ deletedCollections: Array<{ key: string; itemCount: number }> }>;
    assert.deepEqual(audits[0]?.deletedCollections, report.collections);
  } finally { fixture.cleanup(); }
});

test('idempotent apply does not append duplicate cutover audits', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    const report = fixture.cutover.dryRun();
    fixture.persistence.enterMaintenanceMode();
    await fixture.cutover.apply({ confirmToken: report.confirmToken });
    await fixture.cutover.apply({ confirmToken: report.confirmToken });
    const state = fixture.persistence.snapshotState();
    assert.equal((state[CUTOVER_AUDIT_COLLECTION] as unknown[]).length, 1);
  } finally { fixture.cleanup(); }
});

test('atomic state replacement failure leaves old state and Artifact file unchanged', async () => {
  const fixture = setup();
  try {
    await fixture.initialize();
    const before = readFileSync(fixture.filePath, 'utf8');
    const report = fixture.cutover.dryRun();
    fixture.persistence.enterMaintenanceMode();
    (fixture.persistence as unknown as { writeFileState: () => void }).writeFileState = () => {
      throw new Error('forced atomic replace failure');
    };
    await assert.rejects(() => fixture.cutover.apply({ confirmToken: report.confirmToken }), /forced atomic replace failure/);
    assert.equal(readFileSync(fixture.filePath, 'utf8'), before);
    assert.equal(existsSync(fixture.artifactPath), true);
  } finally { fixture.cleanup(); }
});
