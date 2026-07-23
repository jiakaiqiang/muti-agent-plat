import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import { readServerLocalFile } from './workspace-read-file.js';

const revision = {
  id: 'revision-125',
  observedAt: '2026-07-12T00:00:00.000Z'
} satisfies WorkspaceRevision;

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t125-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('readServerLocalFile applies the default cap when caller omits maxBytes and reports truncated:true', async () => {
  await withTempRoot(async (root) => {
    const oneMegabyte = 1024 * 1024;
    const content = 'a'.repeat(oneMegabyte);
    await writeFile(join(root, 'huge.txt'), content);
    const result = await readServerLocalFile({
      rootPath: root,
      revision,
      input: { path: 'huge.txt' }
    });
    assert.equal(result.truncated, true, 'huge file must be flagged truncated even without explicit maxBytes');
    assert.ok(
      result.byteLength <= oneMegabyte,
      'reported byteLength must not exceed the file size'
    );
    assert.ok(result.byteLength < oneMegabyte, 'default cap must be strictly smaller than the huge input');
  });
});

test('readServerLocalFile honors an explicit maxBytes below the default cap', async () => {
  await withTempRoot(async (root) => {
    const content = 'b'.repeat(4096);
    await writeFile(join(root, 'medium.txt'), content);
    const result = await readServerLocalFile({
      rootPath: root,
      revision,
      input: { path: 'medium.txt', maxBytes: 512 }
    });
    assert.equal(result.truncated, true);
    assert.equal(result.byteLength, 512);
    assert.equal(result.content.length, 512);
  });
});

test('readServerLocalFile leaves small files untruncated', async () => {
  await withTempRoot(async (root) => {
    const content = 'small\n';
    await writeFile(join(root, 'small.txt'), content);
    const result = await readServerLocalFile({
      rootPath: root,
      revision,
      input: { path: 'small.txt' }
    });
    assert.equal(result.truncated, false);
    assert.equal(result.byteLength, Buffer.byteLength(content));
  });
});
