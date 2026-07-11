import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileHash, WorkspaceChangeSet, WorkspaceRevision } from '@agent-cluster/shared';
import { validateChangeSetBaseHashes } from './workspace-change-set-validation.js';

const revision = {
  id: 'revision-58',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

function sha256(input: string): FileHash {
  return { algorithm: 'sha256', value: createHash('sha256').update(input).digest('hex') };
}

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t58-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('validateChangeSetBaseHashes returns empty conflicts when hashes match', async () => {
  await withTempRoot(async (root) => {
    const content = 'const a = 1;\n';
    await writeFile(join(root, 'a.ts'), content);
    const expectedHash = sha256(content);
    const changeSet = {
      id: '00000000-0000-4000-8000-000000000058',
      baseRevision: revision,
      changes: [
        { operation: 'update', path: 'a.ts', content: 'const a = 2;\n', encoding: 'utf-8', expectedHash }
      ],
      createdAt: '2026-07-11T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;
    const conflicts = await validateChangeSetBaseHashes({
      rootPath: root,
      currentRevision: revision,
      changeSet
    });
    assert.deepEqual(conflicts, []);
  });
});

test('validateChangeSetBaseHashes returns conflict when file was modified', async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    const staleExpected = sha256('const a = 0;\n');
    const changeSet = {
      id: '00000000-0000-4000-8000-000000000058',
      baseRevision: revision,
      changes: [
        {
          operation: 'update',
          path: 'a.ts',
          content: 'const a = 2;\n',
          encoding: 'utf-8',
          expectedHash: staleExpected
        }
      ],
      createdAt: '2026-07-11T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;
    const conflicts = await validateChangeSetBaseHashes({
      rootPath: root,
      currentRevision: revision,
      changeSet
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].code, 'WORKSPACE_BASE_HASH_MISMATCH');
    assert.equal(conflicts[0].operation, 'update');
    assert.equal(conflicts[0].path, 'a.ts');
    assert.deepEqual(conflicts[0].baseHash, staleExpected);
    assert.ok(conflicts[0].actualHash);
  });
});

test('validateChangeSetBaseHashes ignores create ops (no expectedHash required)', async () => {
  await withTempRoot(async (root) => {
    const changeSet = {
      id: '00000000-0000-4000-8000-000000000058',
      baseRevision: revision,
      changes: [
        { operation: 'create', path: 'new.ts', content: 'export const x = 1;\n', encoding: 'utf-8' }
      ],
      createdAt: '2026-07-11T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;
    const conflicts = await validateChangeSetBaseHashes({
      rootPath: root,
      currentRevision: revision,
      changeSet
    });
    assert.deepEqual(conflicts, []);
  });
});

test('validateChangeSetBaseHashes returns conflict when target file is missing', async () => {
  await withTempRoot(async (root) => {
    const staleExpected = sha256('anything');
    const changeSet = {
      id: '00000000-0000-4000-8000-000000000058',
      baseRevision: revision,
      changes: [
        { operation: 'delete', path: 'missing.ts', expectedHash: staleExpected }
      ],
      createdAt: '2026-07-11T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;
    const conflicts = await validateChangeSetBaseHashes({
      rootPath: root,
      currentRevision: revision,
      changeSet
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].code, 'WORKSPACE_BASE_HASH_MISMATCH');
    assert.equal(conflicts[0].operation, 'delete');
    assert.equal(conflicts[0].actualHash, undefined);
  });
});

test('validateChangeSetBaseHashes handles move ops using fromPath', async () => {
  await withTempRoot(async (root) => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'old.ts'), 'export const v = 1;\n');
    const staleExpected = sha256('different');
    const changeSet = {
      id: '00000000-0000-4000-8000-000000000058',
      baseRevision: revision,
      changes: [
        {
          operation: 'move',
          fromPath: 'src/old.ts',
          toPath: 'src/new.ts',
          expectedHash: staleExpected
        }
      ],
      createdAt: '2026-07-11T00:00:00.000Z'
    } satisfies WorkspaceChangeSet;
    const conflicts = await validateChangeSetBaseHashes({
      rootPath: root,
      currentRevision: revision,
      changeSet
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].path, 'src/old.ts');
    assert.equal(conflicts[0].operation, 'move');
  });
});
