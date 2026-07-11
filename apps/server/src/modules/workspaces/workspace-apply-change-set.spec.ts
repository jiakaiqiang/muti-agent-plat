import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileHash, WorkspaceChangeSet, WorkspaceRevision } from '@agent-cluster/shared';
import { applyServerLocalChangeSet } from './workspace-apply-change-set.js';

const baseRevision = {
  id: 'revision-59-base',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

const nextRevision = {
  id: 'revision-59-next',
  observedAt: '2026-07-11T00:00:01.000Z'
} satisfies WorkspaceRevision;

function sha256(input: string): FileHash {
  return { algorithm: 'sha256', value: createHash('sha256').update(input).digest('hex') };
}

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t59-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test('applyServerLocalChangeSet creates, updates, deletes and moves files', async () => {
  await withTempRoot(async (root) => {
    const initialUpdate = 'const before = 1;\n';
    const initialDelete = 'stale content';
    const initialMove = 'moved payload\n';
    await writeFile(join(root, 'update.ts'), initialUpdate);
    await writeFile(join(root, 'delete.ts'), initialDelete);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'old.ts'), initialMove);

    const changeSet = {
      id: '00000000-0000-4000-8000-000000000059',
      baseRevision,
      changes: [
        { operation: 'create', path: 'new.ts', content: 'export const n = 1;\n', encoding: 'utf-8' },
        {
          operation: 'update',
          path: 'update.ts',
          content: 'const after = 2;\n',
          encoding: 'utf-8',
          expectedHash: sha256(initialUpdate)
        },
        { operation: 'delete', path: 'delete.ts', expectedHash: sha256(initialDelete) },
        {
          operation: 'move',
          fromPath: 'src/old.ts',
          toPath: 'src/renamed.ts',
          expectedHash: sha256(initialMove)
        }
      ],
      createdAt: '2026-07-11T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;

    const result = await applyServerLocalChangeSet({
      rootPath: root,
      currentRevision: baseRevision,
      nextRevision,
      changeSet
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.appliedCount, 4);
    assert.equal(result.changeSetId, changeSet.id);
    assert.equal(result.revision.id, nextRevision.id);

    assert.equal(await readFile(join(root, 'new.ts'), 'utf8'), 'export const n = 1;\n');
    assert.equal(await readFile(join(root, 'update.ts'), 'utf8'), 'const after = 2;\n');
    assert.equal(await fileExists(join(root, 'delete.ts')), false);
    assert.equal(await fileExists(join(root, 'src', 'old.ts')), false);
    assert.equal(await readFile(join(root, 'src', 'renamed.ts'), 'utf8'), initialMove);
  });
});

test('applyServerLocalChangeSet returns ok:false with conflicts when baseHash mismatches', async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, 'a.ts'), 'const current = 1;\n');
    const changeSet = {
      id: '00000000-0000-4000-8000-000000000059',
      baseRevision,
      changes: [
        {
          operation: 'update',
          path: 'a.ts',
          content: 'const after = 2;\n',
          encoding: 'utf-8',
          expectedHash: sha256('const stale = 0;\n')
        }
      ],
      createdAt: '2026-07-11T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;

    const result = await applyServerLocalChangeSet({
      rootPath: root,
      currentRevision: baseRevision,
      nextRevision,
      changeSet
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].path, 'a.ts');
    assert.equal(result.changeSetId, changeSet.id);
    assert.equal(result.revision.id, baseRevision.id);
    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'const current = 1;\n');
  });
});

test('applyServerLocalChangeSet creates nested parent directories on create/move', async () => {
  await withTempRoot(async (root) => {
    const changeSet = {
      id: '00000000-0000-4000-8000-000000000059',
      baseRevision,
      changes: [
        { operation: 'create', path: 'a/b/c/nested.ts', content: 'nested', encoding: 'utf-8' }
      ],
      createdAt: '2026-07-11T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;
    const result = await applyServerLocalChangeSet({
      rootPath: root,
      currentRevision: baseRevision,
      nextRevision,
      changeSet
    });
    assert.equal(result.ok, true);
    assert.equal(await readFile(join(root, 'a/b/c/nested.ts'), 'utf8'), 'nested');
  });
});
