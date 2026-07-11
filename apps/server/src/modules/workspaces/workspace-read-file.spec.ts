import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import { readServerLocalFile } from './workspace-read-file.js';

const revision = {
  id: 'revision-56',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

async function withTempRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-t56-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('readServerLocalFile returns text content, byte length, hash and revision', async () => {
  await withTempRoot(async (root) => {
    const content = 'line 1\nline 2\nline 3\n';
    await writeFile(join(root, 'a.txt'), content);
    const result = await readServerLocalFile({
      rootPath: root,
      revision,
      input: { path: 'a.txt' }
    });
    assert.equal(result.path, 'a.txt');
    assert.equal(result.content, content);
    assert.equal(result.encoding, 'utf-8');
    assert.equal(result.byteLength, Buffer.byteLength(content));
    assert.equal(result.truncated, false);
    assert.equal(result.revision.id, revision.id);
    assert.equal(result.hash.algorithm, 'sha256');
    assert.ok(result.hash.value.length > 0);
  });
});

test('readServerLocalFile marks truncated=true when maxBytes exceeded', async () => {
  await withTempRoot(async (root) => {
    const content = 'a'.repeat(1000);
    await writeFile(join(root, 'big.txt'), content);
    const result = await readServerLocalFile({
      rootPath: root,
      revision,
      input: { path: 'big.txt', maxBytes: 100 }
    });
    assert.equal(result.truncated, true);
    assert.equal(result.byteLength, 100);
    assert.equal(result.content.length, 100);
  });
});

test('readServerLocalFile rejects sensitive files', async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, '.env'), 'SECRET=1');
    await assert.rejects(
      () => readServerLocalFile({ rootPath: root, revision, input: { path: '.env' } }),
      /sensitive|denied|forbidden/i
    );
  });
});

test('readServerLocalFile rejects binary content', async () => {
  await withTempRoot(async (root) => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x00]);
    await writeFile(join(root, 'blob.bin'), bytes);
    await assert.rejects(
      () => readServerLocalFile({ rootPath: root, revision, input: { path: 'blob.bin' } }),
      /binary/i
    );
  });
});

test('readServerLocalFile slices by startLine and endLine', async () => {
  await withTempRoot(async (root) => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\nfive\n');
    const result = await readServerLocalFile({
      rootPath: root,
      revision,
      input: { path: 'src/a.ts', startLine: 2, endLine: 4 }
    });
    assert.equal(result.content, 'two\nthree\nfour');
    assert.equal(result.startLine, 2);
    assert.equal(result.endLine, 4);
  });
});
