import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import type { BrowserDirectoryHandle, BrowserFileHandle } from './workspaceBrokerReadFile';
import {
  BrowserWorkspaceFileNotFoundError,
  browserStatFile
} from './workspaceBrokerStatFile';

const revision: WorkspaceRevision = { id: 'rev-103', observedAt: '2026-07-11T00:00:00.000Z' };

function fileHandle(name: string, content: string): BrowserFileHandle {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  return {
    name,
    async getFile() {
      return {
        size: bytes.byteLength,
        lastModified: 1_700_000_000_000,
        text: async () => content,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      };
    }
  };
}

function root(config: {
  files?: Record<string, string>;
  directories?: string[];
}): BrowserDirectoryHandle {
  const files = new Map(Object.entries(config.files ?? {}));
  const directories = new Set(config.directories ?? []);
  return {
    async getFileHandle(name) {
      if (!files.has(name)) throw new Error(`file not found: ${name}`);
      return fileHandle(name, files.get(name) as string);
    },
    async getDirectoryHandle(name) {
      if (!directories.has(name)) throw new Error(`directory not found: ${name}`);
      return root({});
    }
  };
}

const digest = async (bytes: ArrayBuffer) => `bytes:${bytes.byteLength}`;

test('browserStatFile returns kind:file with size, hash, mtime and revision', async () => {
  const handle = root({ files: { 'a.ts': 'hello' } });
  const result = await browserStatFile({
    root: handle,
    input: { path: 'a.ts' },
    revision,
    digest
  });
  assert.equal(result.kind, 'file');
  if (result.kind !== 'file') return;
  assert.equal(result.size, 5);
  assert.equal(result.hash.value, 'bytes:5');
  assert.ok(result.modifiedAt);
});

test('browserStatFile returns kind:directory for a directory path', async () => {
  const handle = root({ directories: ['src'] });
  const result = await browserStatFile({
    root: handle,
    input: { path: 'src' },
    revision,
    digest
  });
  assert.equal(result.kind, 'directory');
});

test('browserStatFile throws BrowserWorkspaceFileNotFoundError for missing path', async () => {
  const handle = root({ files: { 'a.ts': 'x' } });
  await assert.rejects(
    () => browserStatFile({ root: handle, input: { path: 'missing.ts' }, revision, digest }),
    (error: unknown) => {
      assert.ok(error instanceof BrowserWorkspaceFileNotFoundError);
      assert.equal((error as BrowserWorkspaceFileNotFoundError).code, 'WORKSPACE_FILE_NOT_FOUND');
      return true;
    }
  );
});
