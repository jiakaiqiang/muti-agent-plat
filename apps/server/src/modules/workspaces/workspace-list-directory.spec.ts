import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import { listServerLocalDirectory } from './workspace-list-directory.js';

const revision = {
  id: 'revision-54',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t54-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('listServerLocalDirectory lists regular files and skips generated directories', async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, 'a.ts'), 'export const a = 1;');
    await writeFile(join(root, 'b.ts'), 'export const b = 2;');
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'noop');
    await mkdir(join(root, '.git', 'refs'), { recursive: true });
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'index.ts'), 'ok');

    const result = await listServerLocalDirectory({ rootPath: root, revision, input: {} });

    const names = result.entries.map((entry) => entry.path).sort();
    assert.deepEqual(names, ['a.ts', 'b.ts', 'src']);
    assert.equal(result.path, '');
    assert.equal(result.revision.id, revision.id);
    for (const entry of result.entries) {
      assert.equal(entry.revision.id, revision.id);
    }
  });
});

test('listServerLocalDirectory truncates and provides nextCursor when limit exceeded', async () => {
  await withTempRoot(async (root) => {
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(root, `file-${i}.ts`), `export const n = ${i};`);
    }

    const first = await listServerLocalDirectory({
      rootPath: root,
      revision,
      input: { limit: 2 }
    });

    assert.equal(first.entries.length, 2);
    assert.ok(first.nextCursor, 'expected nextCursor when limit is exceeded');

    const second = await listServerLocalDirectory({
      rootPath: root,
      revision,
      input: { limit: 10, cursor: first.nextCursor }
    });

    assert.ok(second.entries.length >= 1);
  });
});

test('listServerLocalDirectory returns posix-style paths inside a nested directory', async () => {
  await withTempRoot(async (root) => {
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'a', 'b', 'c.ts'), 'ok');

    const result = await listServerLocalDirectory({
      rootPath: root,
      revision,
      input: { path: 'a/b' }
    });

    assert.equal(result.path, 'a/b');
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].path, 'a/b/c.ts');
  });
});

test('listServerLocalDirectory rejects paths that escape the workspace root', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      () => listServerLocalDirectory({ rootPath: root, revision, input: { path: '../other' } }),
      /traversal|outside|workspace/i
    );
  });
});
