import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceRevision } from '@agent-cluster/shared';
import {
  browserListDirectory,
  type BrowserDirectoryEntry,
  type BrowserListDirectoryHandle
} from './workspaceBrokerListDirectory';

const revision: WorkspaceRevision = { id: 'rev-102', observedAt: '2026-07-11T00:00:00.000Z' };

function makeHandle(items: Record<string, BrowserDirectoryEntry[]>, prefix = ''): BrowserListDirectoryHandle {
  return {
    async *entries() {
      const key = prefix || '.';
      for (const item of items[key] ?? []) yield item;
    },
    async getDirectoryHandle(name) {
      const nextKey = prefix ? `${prefix}/${name}` : name;
      if (!(nextKey in items)) throw new Error(`directory not found: ${nextKey}`);
      return makeHandle(items, nextKey);
    }
  };
}

const digestFile = async (path: string) => ({ hashValue: `hash:${path}`, size: 42 });

test('browserListDirectory returns entries with file hashes and directory placeholders', async () => {
  const handle = makeHandle({
    '.': [
      { name: 'src', kind: 'directory' },
      { name: 'README.md', kind: 'file', size: 100 },
      { name: 'node_modules', kind: 'directory' }
    ]
  });
  const result = await browserListDirectory({
    root: handle,
    input: {},
    revision,
    digestFile
  });
  const paths = result.entries.map((entry) => entry.path).sort();
  assert.deepEqual(paths, ['README.md', 'src']);
  assert.equal(result.path, '');
});

test('browserListDirectory truncates and reports nextCursor when limit exceeded', async () => {
  const many: BrowserDirectoryEntry[] = [];
  for (let i = 0; i < 6; i += 1) many.push({ name: `f-${i}.ts`, kind: 'file', size: 1 });
  const handle = makeHandle({ '.': many });
  const first = await browserListDirectory({
    root: handle,
    input: { limit: 2 },
    revision,
    digestFile
  });
  assert.equal(first.entries.length, 2);
  assert.ok(first.nextCursor);
  const second = await browserListDirectory({
    root: handle,
    input: { limit: 10, cursor: first.nextCursor },
    revision,
    digestFile
  });
  assert.ok(second.entries.length >= 1);
});

test('browserListDirectory descends into nested directories via path', async () => {
  const handle = makeHandle({
    '.': [{ name: 'a', kind: 'directory' }],
    'a': [{ name: 'b', kind: 'directory' }],
    'a/b': [{ name: 'c.ts', kind: 'file', size: 10 }]
  });
  const result = await browserListDirectory({
    root: handle,
    input: { path: 'a/b' },
    revision,
    digestFile
  });
  assert.equal(result.path, 'a/b');
  assert.equal(result.entries[0].path, 'a/b/c.ts');
});
