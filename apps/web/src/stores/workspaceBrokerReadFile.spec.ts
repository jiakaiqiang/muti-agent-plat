import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import {
  browserReadFile,
  type BrowserDirectoryHandle,
  type BrowserFile,
  type BrowserFileHandle
} from './workspaceBrokerReadFile';

const revision: WorkspaceRevision = {
  id: 'rev-101',
  observedAt: '2026-07-11T00:00:00.000Z'
};

function makeFile(content: string): BrowserFile {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  return {
    size: bytes.byteLength,
    lastModified: 1_700_000_000_000,
    text: async () => content,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

function makeFileHandle(name: string, content: string): BrowserFileHandle {
  return { name, getFile: async () => makeFile(content) };
}

function makeRoot(tree: Record<string, string>): BrowserDirectoryHandle {
  function makeDir(prefix: string): BrowserDirectoryHandle {
    return {
      async getFileHandle(name) {
        const key = prefix ? `${prefix}/${name}` : name;
        if (!(key in tree)) throw new Error(`file not found: ${key}`);
        return makeFileHandle(name, tree[key]);
      },
      async getDirectoryHandle(name) {
        return makeDir(prefix ? `${prefix}/${name}` : name);
      }
    };
  }
  return makeDir('');
}

const digest = async (bytes: ArrayBuffer): Promise<string> => `bytes:${bytes.byteLength}`;

test('browserReadFile returns content, hash and revision for a nested path', async () => {
  const root = makeRoot({ 'src/index.ts': 'export const a = 1;\nexport const b = 2;\n' });
  const result = await browserReadFile({
    root,
    input: { path: 'src/index.ts' },
    revision,
    digest
  });
  assert.equal(result.path, 'src/index.ts');
  assert.equal(result.content, 'export const a = 1;\nexport const b = 2;\n');
  assert.equal(result.hash.algorithm, 'sha256');
  assert.equal(result.hash.value, 'bytes:40');
  assert.equal(result.revision.id, revision.id);
  assert.equal(result.truncated, false);
});

test('browserReadFile slices by startLine and endLine', async () => {
  const root = makeRoot({ 'a.ts': 'one\ntwo\nthree\nfour\n' });
  const result = await browserReadFile({
    root,
    input: { path: 'a.ts', startLine: 2, endLine: 3 },
    revision,
    digest
  });
  assert.equal(result.content, 'two\nthree');
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 3);
});

test('browserReadFile truncates when file exceeds maxBytes', async () => {
  const content = 'x'.repeat(500);
  const root = makeRoot({ 'big.txt': content });
  const result = await browserReadFile({
    root,
    input: { path: 'big.txt', maxBytes: 100 },
    revision,
    digest
  });
  assert.equal(result.truncated, true);
  assert.equal(result.byteLength, 100);
  assert.equal(result.content.length, 100);
});
