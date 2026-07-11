import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileHash, WorkspaceRevision } from '@agent-cluster/shared';
import type { WorkspaceProvider } from './workspace-provider.js';

const revision = {
  id: 'revision-51',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

const hash = {
  algorithm: 'sha256',
  value: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
} satisfies FileHash;

const provider = {
  kind: 'server_local',
  capabilities: () => ({ read: true, write: true, command: true, test: true }),
  getRevision: async () => revision,
  listDirectory: async (input) => ({
    path: input.path ?? '',
    entries: [],
    revision
  }),
  statFile: async (input) => ({
    path: input.path,
    kind: 'file',
    size: 4,
    hash,
    revision
  }),
  readFile: async (input) => ({
    path: input.path,
    content: 'test',
    encoding: 'utf-8',
    byteLength: 4,
    truncated: false,
    hash,
    revision
  }),
  searchText: async () => ({ matches: [], truncated: false, revision }),
  applyChangeSet: async (input) => ({
    ok: true,
    changeSetId: input.id,
    revision,
    appliedCount: input.changes.length
  })
} satisfies WorkspaceProvider;

test('WorkspaceProvider exposes the fixed workspace-plane method signatures', async () => {
  assert.deepEqual(provider.capabilities(), { read: true, write: true, command: true, test: true });
  assert.equal((await provider.getRevision()).id, revision.id);
  assert.equal((await provider.readFile({ path: 'src/index.ts' })).hash.value, hash.value);
});
