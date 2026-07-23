import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceChangeSet, WorkspaceRevision } from '@agent-cluster/shared';
import {
  browserApplyChangeSet,
  type BrowserWritableDirectoryHandle,
  type BrowserWritableFile,
  type BrowserWritableFileHandle
} from './workspaceBrokerApplyChangeSet';

interface FakeStore {
  files: Map<string, string>;
  removed: string[];
}

function makeRoot(store: FakeStore, prefix = ''): BrowserWritableDirectoryHandle {
  function fullPath(name: string) {
    return prefix ? `${prefix}/${name}` : name;
  }
  return {
    async getFileHandle(name, options) {
      const path = fullPath(name);
      if (!store.files.has(path)) {
        if (!options?.create) throw new Error(`file not found: ${path}`);
        store.files.set(path, '');
      }
      const handle: BrowserWritableFileHandle & {
        getFile: () => Promise<{ text: () => Promise<string> }>;
      } = {
        async createWritable(): Promise<BrowserWritableFile> {
          let buffer = '';
          return {
            async write(contents) {
              buffer = contents;
            },
            async close() {
              store.files.set(path, buffer);
            }
          };
        },
        async getFile() {
          return { text: async () => store.files.get(path) ?? '' };
        }
      };
      return handle;
    },
    async getDirectoryHandle(name, options) {
      void options;
      return makeRoot(store, fullPath(name));
    },
    async removeEntry(name) {
      const path = fullPath(name);
      store.files.delete(path);
      store.removed.push(path);
    }
  };
}

const baseRevision: WorkspaceRevision = { id: 'rev-115-a', observedAt: '2026-07-11T00:00:00.000Z' };
const nextRevision: WorkspaceRevision = { id: 'rev-115-b', observedAt: '2026-07-11T00:00:01.000Z' };

test('browserApplyChangeSet creates a nested markdown file end-to-end', async () => {
  const store: FakeStore = { files: new Map(), removed: [] };
  const root = makeRoot(store);
  const changeSet: WorkspaceChangeSet = {
    id: '00000000-0000-4000-8000-000000000115',
    baseRevision,
    changes: [
      {
        operation: 'create',
        path: 'agent-output/project-architecture-analysis.md',
        content: '# demo report',
        encoding: 'utf-8'
      }
    ],
    createdAt: '2026-07-11T00:00:00.000Z'
  };
  const result = await browserApplyChangeSet({ root, changeSet, nextRevision });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.appliedCount, 1);
  assert.equal(store.files.get('agent-output/project-architecture-analysis.md'), '# demo report');
  assert.equal(result.revision.id, nextRevision.id);
});

test('browserApplyChangeSet updates an existing file and deletes another in the same batch', async () => {
  const store: FakeStore = {
    files: new Map([
      ['README.md', 'old'],
      ['old.md', 'stale']
    ]),
    removed: []
  };
  const root = makeRoot(store);
  const changeSet: WorkspaceChangeSet = {
    id: '00000000-0000-4000-8000-000000000116',
    baseRevision,
    changes: [
      {
        operation: 'update',
        path: 'README.md',
        content: 'new',
        encoding: 'utf-8',
        expectedHash: { algorithm: 'sha256', value: 'a'.repeat(64) }
      },
      { operation: 'delete', path: 'old.md', expectedHash: { algorithm: 'sha256', value: 'b'.repeat(64) } }
    ],
    createdAt: '2026-07-11T00:00:00.000Z'
  };
  const result = await browserApplyChangeSet({ root, changeSet, nextRevision });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.appliedCount, 2);
  assert.equal(store.files.get('README.md'), 'new');
  assert.equal(store.files.has('old.md'), false);
  assert.deepEqual(store.removed, ['old.md']);
});

test('browserApplyChangeSet rejects traversal and sensitive paths before writing', async () => {
  const store: FakeStore = { files: new Map(), removed: [] };
  const root = makeRoot(store);
  const base = {
    id: '00000000-0000-4000-8000-000000000117',
    baseRevision,
    createdAt: '2026-07-11T00:00:00.000Z'
  };
  await assert.rejects(
    browserApplyChangeSet({
      root,
      nextRevision,
      changeSet: {
        ...base,
        changes: [{ operation: 'create', path: '../escape.txt', content: 'x', encoding: 'utf-8' }]
      }
    }),
    /traversal/i
  );
  await assert.rejects(
    browserApplyChangeSet({
      root,
      nextRevision,
      changeSet: {
        ...base,
        changes: [{ operation: 'create', path: '.env', content: 'SECRET=x', encoding: 'utf-8' }]
      }
    }),
    /sensitive/i
  );
  assert.equal(store.files.size, 0);
});
