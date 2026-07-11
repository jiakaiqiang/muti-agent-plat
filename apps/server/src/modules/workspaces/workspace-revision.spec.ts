import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileHash, WorkspaceChangeSet, WorkspaceRevision } from '@agent-cluster/shared';
import { createWorkspaceRevision } from './workspace-revision.js';
import { applyServerLocalChangeSet } from './workspace-apply-change-set.js';
import { statServerLocalFile } from './workspace-stat-file.js';

const baseRevision = {
  id: 'revision-60-base',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

function sha256(input: string): FileHash {
  return { algorithm: 'sha256', value: createHash('sha256').update(input).digest('hex') };
}

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t60-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('createWorkspaceRevision produces a fresh id and ISO timestamp on each call', () => {
  const a = createWorkspaceRevision();
  const b = createWorkspaceRevision();
  assert.notEqual(a.id, b.id);
  assert.match(a.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
});

test('applyServerLocalChangeSet defaults nextRevision to createWorkspaceRevision output when omitted', async () => {
  await withTempRoot(async (root) => {
    const changeSet = {
      id: '00000000-0000-4000-8000-000000000060',
      baseRevision,
      changes: [
        { operation: 'create', path: 'a.ts', content: 'export const a = 1;\n', encoding: 'utf-8' }
      ],
      createdAt: '2026-07-11T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;

    const result = await applyServerLocalChangeSet({
      rootPath: root,
      currentRevision: baseRevision,
      changeSet
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.notEqual(result.revision.id, baseRevision.id);
    assert.match(result.revision.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  });
});

test('stat after apply reflects the fresh hash and new revision', async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, 'a.ts'), 'const before = 1;\n');
    const changeSet = {
      id: '00000000-0000-4000-8000-000000000060',
      baseRevision,
      changes: [
        {
          operation: 'update',
          path: 'a.ts',
          content: 'const after = 2;\n',
          encoding: 'utf-8',
          expectedHash: sha256('const before = 1;\n')
        }
      ],
      createdAt: '2026-07-11T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;

    const result = await applyServerLocalChangeSet({
      rootPath: root,
      currentRevision: baseRevision,
      changeSet
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const stats = await statServerLocalFile({
      rootPath: root,
      revision: result.revision,
      input: { path: 'a.ts' }
    });
    assert.equal(stats.kind, 'file');
    if (stats.kind !== 'file') return;
    assert.equal(stats.hash.value, sha256('const after = 2;\n').value);
    assert.equal(stats.revision.id, result.revision.id);
  });
});
