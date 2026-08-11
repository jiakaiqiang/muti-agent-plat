import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  defaultState,
  loadState,
  removeWorkspace,
  saveState,
  saveWorkspaceIndex
} from './state.js';

const permissions = {
  workspace_read: 'allow',
  workspace_write: 'allow',
  workspace_delete: 'confirm',
  command_execute: 'allow',
  test_execute: 'allow',
  dependency_install: 'confirm'
} as const;

test('removeWorkspace persists removal of an authorized workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-runtime-remove-workspace-'));
  const stateFile = join(directory, 'state.json');
  const previousStateFile = process.env.AGENT_RUNTIME_STATE_FILE;
  process.env.AGENT_RUNTIME_STATE_FILE = stateFile;
  try {
    const state = defaultState();
    state.workspaces.push({
      workspaceId: 'workspace-remove',
      displayName: 'remove-me',
      rootPath: directory,
      permissions,
      permissionPolicyVersion: 2,
      registeredAt: '2026-08-10T00:00:00.000Z'
    });

    const removed = await removeWorkspace(state, 'workspace-remove');

    assert.equal(removed?.workspaceId, 'workspace-remove');
    assert.deepEqual(state.workspaces, []);
    const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as { workspaces: unknown[] };
    assert.deepEqual(persisted.workspaces, []);
  } finally {
    if (previousStateFile === undefined) delete process.env.AGENT_RUNTIME_STATE_FILE;
    else process.env.AGENT_RUNTIME_STATE_FILE = previousStateFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test('workspace indexes persist outside state.json and are restored on load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-runtime-index-state-'));
  const stateFile = join(directory, 'state.json');
  const previousStateFile = process.env.AGENT_RUNTIME_STATE_FILE;
  process.env.AGENT_RUNTIME_STATE_FILE = stateFile;
  try {
    const state = defaultState();
    const revision = { id: 'revision-index', observedAt: '2026-08-10T00:00:00.000Z' };
    const entries = [{
      path: 'src/index.ts',
      kind: 'file' as const,
      size: 42,
      generated: false,
      sensitive: false
    }];
    state.workspaces.push({
      workspaceId: 'workspace-index',
      displayName: 'indexed-workspace',
      rootPath: directory,
      permissions,
      permissionPolicyVersion: 2,
      registeredAt: revision.observedAt,
      index: {
        workspaceId: 'workspace-index',
        revision,
        generation: 3,
        status: 'ready',
        complete: true,
        entries,
        entrypoints: ['src/index.ts'],
        detectedStack: ['node'],
        indexedEntries: 1,
        truncated: false,
        updatedAt: revision.observedAt,
        coverage: {
          visitedEntries: 1,
          indexedEntries: 1,
          excludedGenerated: 0,
          sensitiveEntries: 0,
          skippedSymlinks: 0,
          failedEntries: 0
        }
      }
    });

    await saveWorkspaceIndex('workspace-index', entries);
    await saveState(state);

    const persistedState = JSON.parse(await readFile(stateFile, 'utf8')) as {
      workspaces: Array<{ index?: { entries?: unknown; entrypoints: string[] } }>;
    };
    assert.equal(persistedState.workspaces[0]?.index?.entries, undefined);
    assert.deepEqual(persistedState.workspaces[0]?.index?.entrypoints, ['src/index.ts']);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, 'workspace-index-index.json'), 'utf8')),
      entries
    );
    assert.deepEqual((await loadState()).workspaces[0]?.index?.entries, entries);
  } finally {
    if (previousStateFile === undefined) delete process.env.AGENT_RUNTIME_STATE_FILE;
    else process.env.AGENT_RUNTIME_STATE_FILE = previousStateFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test('loadState falls back to legacy inline index entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-runtime-inline-index-'));
  const stateFile = join(directory, 'state.json');
  const previousStateFile = process.env.AGENT_RUNTIME_STATE_FILE;
  process.env.AGENT_RUNTIME_STATE_FILE = stateFile;
  try {
    const state = defaultState();
    state.workspaces.push({
      workspaceId: 'workspace-inline',
      displayName: 'inline-workspace',
      rootPath: directory,
      permissions,
      permissionPolicyVersion: 2,
      registeredAt: '2026-08-10T00:00:00.000Z',
      index: {
        workspaceId: 'workspace-inline',
        revision: { id: 'revision-inline', observedAt: '2026-08-10T00:00:00.000Z' },
        generation: 1,
        status: 'ready',
        complete: true,
        entries: [{ path: 'README.md', kind: 'file', size: 1, generated: false, sensitive: false }],
        entrypoints: ['README.md'],
        detectedStack: [],
        indexedEntries: 1,
        truncated: false,
        updatedAt: '2026-08-10T00:00:00.000Z',
        coverage: {
          visitedEntries: 1,
          indexedEntries: 1,
          excludedGenerated: 0,
          sensitiveEntries: 0,
          skippedSymlinks: 0,
          failedEntries: 0
        }
      }
    });
    await writeFile(stateFile, JSON.stringify(state), 'utf8');

    assert.equal((await loadState()).workspaces[0]?.index?.entries[0]?.path, 'README.md');
    const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as {
      workspaces: Array<{ index?: { entries?: unknown } }>;
    };
    assert.equal(persisted.workspaces[0]?.index?.entries, undefined);
    assert.equal(
      JSON.parse(await readFile(join(directory, 'workspace-inline-index.json'), 'utf8'))[0]?.path,
      'README.md'
    );
    assert.equal((await loadState()).workspaces[0]?.index?.entries[0]?.path, 'README.md');
  } finally {
    if (previousStateFile === undefined) delete process.env.AGENT_RUNTIME_STATE_FILE;
    else process.env.AGENT_RUNTIME_STATE_FILE = previousStateFile;
    await rm(directory, { recursive: true, force: true });
  }
});
