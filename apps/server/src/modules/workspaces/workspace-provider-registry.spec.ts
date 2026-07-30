import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileHash, WorkspaceProviderKind, WorkspaceRevision } from '@agent-cluster/shared';
import type { WorkspaceProvider } from './workspace-provider.js';
import { WorkspaceProviderRegistry } from './workspace-provider-registry.js';

const revision = {
  id: 'revision-52',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

const hash = {
  algorithm: 'sha256',
  value: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
} satisfies FileHash;

function createProvider(kind: WorkspaceProviderKind): WorkspaceProvider {
  return {
    kind,
    capabilities: () => ({ read: true, write: false, command: false, test: false }),
    getRevision: async () => revision,
    listDirectory: async (input) => ({
      path: input.path ?? '',
      entries: [],
      revision
    }),
    statFile: async (input) => ({
      path: input.path,
      kind: 'file',
      size: 0,
      hash,
      revision
    }),
    readFile: async (input) => ({
      path: input.path,
      content: '',
      encoding: 'utf-8',
      byteLength: 0,
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
  };
}

test('WorkspaceProviderRegistry resolves a registered provider by kind', () => {
  const registry = new WorkspaceProviderRegistry();
  const provider = createProvider('server_local');
  registry.register(provider);
  assert.equal(registry.has('server_local'), true);
  assert.strictEqual(registry.resolve('server_local'), provider);
});

test('WorkspaceProviderRegistry throws when resolving an unregistered kind', () => {
  const registry = new WorkspaceProviderRegistry();
  assert.throws(() => registry.resolve('local_bridge'), /local_bridge/);
});

test('WorkspaceProviderRegistry rejects duplicate registrations for the same kind', () => {
  const registry = new WorkspaceProviderRegistry();
  registry.register(createProvider('local_bridge'));
  assert.throws(() => registry.register(createProvider('local_bridge')), /local_bridge/);
});
