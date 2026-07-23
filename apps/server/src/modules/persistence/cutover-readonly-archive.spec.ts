import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeSecret } from '../../common/secret-cipher.js';
import { archiveCutoverState, assertArchiveOutsideDataRoot } from './cutover-readonly-archive.js';

test('cutover archive is encrypted, hashed, readable only, and outside active data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-archive-'));
  const dataRoot = join(directory, 'active');
  const archiveDirectory = join(directory, 'archive');
  const state = { sessions: [{ id: 'old-session', title: 'sensitive title' }] };
  try {
    const result = archiveCutoverState({
      state,
      sourceRevision: 'revision-1',
      dataRoot,
      archiveDirectory,
      archiveSecret: 'archive-test-secret-with-entropy',
      archiveId: 'audit-1',
      environment: 'test',
      createdAt: '2026-07-13T00:00:00.000Z',
      collectionCounts: [{ key: 'sessions', itemCount: 1 }]
    });
    const envelope = readFileSync(result.archiveFile, 'utf8').trim();
    assert.equal(envelope.includes('sensitive title'), false);
    assert.deepEqual(JSON.parse(decodeSecret(envelope, 'archive-test-secret-with-entropy')), state);
    assert.match(result.manifest.encryptedSha256, /^[a-f0-9]{64}$/);
    assert.equal(statSync(result.archiveFile).mode & 0o222, 0);
    assert.equal(statSync(result.manifestFile).mode & 0o222, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('archive directory cannot live inside active data root', () => {
  const root = join(tmpdir(), 'agent-cluster-active');
  assert.throws(() => assertArchiveOutsideDataRoot(root, join(root, 'archive')), /INSIDE_ACTIVE_DATA_ROOT/);
});

test('existing archive is revalidated before it can be reused', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-archive-integrity-'));
  const input = {
    state: { sessions: [{ id: 'old' }] },
    sourceRevision: 'revision-integrity',
    dataRoot: join(directory, 'active'),
    archiveDirectory: join(directory, 'archive'),
    archiveSecret: 'archive-test-secret-with-entropy',
    archiveId: 'audit-integrity',
    environment: 'test',
    createdAt: '2026-07-13T00:00:00.000Z',
    collectionCounts: [{ key: 'sessions', itemCount: 1 }]
  };
  try {
    const first = archiveCutoverState(input);
    chmodSync(first.archiveFile, 0o600);
    writeFileSync(first.archiveFile, 'tampered-envelope\n', 'utf8');
    assert.throws(() => archiveCutoverState(input), /CUTOVER_ARCHIVE_INTEGRITY_FAILED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
