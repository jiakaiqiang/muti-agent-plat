import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileHash, WorkspaceRevision } from '@agent-cluster/shared';
import type { WorkspaceProvider } from '../workspaces/workspace-provider.js';
import { createWorkspaceToolAdapter } from './workspace-tool-adapter.js';

const revision: WorkspaceRevision = { id: 'rev-86', observedAt: '2026-07-11T00:00:00.000Z' };
const hash: FileHash = { algorithm: 'sha256', value: 'f'.repeat(64) };

function makeProvider() {
  const calls: string[] = [];
  const provider: WorkspaceProvider = {
    kind: 'server_local',
    capabilities: () => ({ read: true, write: true, command: true, test: true }),
    getRevision: async () => revision,
    listDirectory: async (input) => {
      calls.push(`listDirectory:${input.path ?? ''}`);
      return { path: input.path ?? '', entries: [], revision };
    },
    statFile: async (input) => {
      calls.push(`statFile:${input.path}`);
      return { path: input.path, kind: 'file', size: 1, hash, revision };
    },
    readFile: async (input) => {
      calls.push(`readFile:${input.path}`);
      return {
        path: input.path,
        content: 'x',
        encoding: 'utf-8',
        byteLength: 1,
        truncated: false,
        revision,
        hash
      };
    },
    searchText: async (input) => {
      calls.push(`searchText:${input.query}`);
      return { matches: [], truncated: false, revision };
    },
    applyChangeSet: async (input) => ({ ok: true, changeSetId: input.id, revision, appliedCount: 0 })
  };
  return { provider, calls };
}

test('workspace tool adapter delegates read to provider.readFile', async () => {
  const { provider, calls } = makeProvider();
  const tool = createWorkspaceToolAdapter(provider);
  const result = await tool.read({ path: 'src/index.ts' });
  assert.equal(result.path, 'src/index.ts');
  assert.deepEqual(calls, ['readFile:src/index.ts']);
});

test('workspace tool adapter delegates list, stat, search to matching provider methods', async () => {
  const { provider, calls } = makeProvider();
  const tool = createWorkspaceToolAdapter(provider);
  await tool.list({ path: 'src' });
  await tool.stat({ path: 'src/index.ts' });
  await tool.search({ query: 'needle' });
  assert.deepEqual(calls, ['listDirectory:src', 'statFile:src/index.ts', 'searchText:needle']);
});
