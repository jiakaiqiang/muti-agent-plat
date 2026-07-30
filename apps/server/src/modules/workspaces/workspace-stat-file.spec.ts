import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import { statServerLocalFile } from './workspace-stat-file.js';

const revision = {
  id: 'revision-55',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t55-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('statServerLocalFile returns size, hash, mtime and revision for a file', async () => {
  await withTempRoot(async (root) => {
    const filePath = join(root, 'src', 'index.ts');
    const content = 'export const x = 1;\n';
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(filePath, content);

    const result = await statServerLocalFile({
      rootPath: root,
      revision,
      input: { path: 'src/index.ts' }
    });

    assert.equal(result.kind, 'file');
    assert.equal(result.path, 'src/index.ts');
    if (result.kind !== 'file') return;
    assert.equal(result.size, Buffer.byteLength(content, 'utf8'));
    const expected = createHash('sha256').update(content).digest('hex');
    assert.equal(result.hash!.value, expected);
    assert.equal(result.hash!.algorithm, 'sha256');
    assert.ok(result.modifiedAt, 'expected modifiedAt to be populated');
    assert.equal(result.revision.id, revision.id);
  });
});

test('statServerLocalFile returns kind=directory for a directory path', async () => {
  await withTempRoot(async (root) => {
    await mkdir(join(root, 'src'), { recursive: true });
    const result = await statServerLocalFile({
      rootPath: root,
      revision,
      input: { path: 'src' }
    });
    assert.equal(result.kind, 'directory');
    assert.equal(result.path, 'src');
  });
});

test('statServerLocalFile rejects paths escaping the workspace root', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      () => statServerLocalFile({ rootPath: root, revision, input: { path: '../secret.ts' } }),
      /traversal|outside|workspace/i
    );
  });
});

test('statServerLocalFile propagates ENOENT for a missing file', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      () => statServerLocalFile({ rootPath: root, revision, input: { path: 'nope.ts' } }),
      /ENOENT|not exist|no such/i
    );
  });
});
