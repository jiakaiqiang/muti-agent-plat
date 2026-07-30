import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerLocalWorkspaceProvider } from './server-local-workspace-provider.js';
import {
  getServerLocalWorkspaceState,
  resetServerLocalWorkspaceStateForTests
} from './server-local-workspace-index.js';

test('server-local Provider exposes a non-blocking metadata-only index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-server-index-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'package.json'), '{"name":"server-index"}', 'utf8');
    await writeFile(join(root, 'src', 'main.ts'), 'export const main = true;', 'utf8');
    const provider = new ServerLocalWorkspaceProvider(root);

    const immediate = await provider.getIndexSnapshot({ limit: 100 });
    assert.ok(['empty', 'building', 'ready'].includes(immediate.status));

    let snapshot = immediate;
    for (let attempt = 0; attempt < 100 && snapshot.status !== 'ready'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapshot = await provider.getIndexSnapshot({ limit: 100 });
    }
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.entrypoints, ['package.json']);
    assert.equal(snapshot.entries.some((entry) => entry.path === 'src/main.ts'), true);
    assert.equal(snapshot.entries.every((entry) => entry.kind !== 'file' || !('hash' in entry)), true);

    const generation = snapshot.generation;
    await writeFile(join(root, 'src', 'added.ts'), 'export const added = true;', 'utf8');
    for (let attempt = 0; attempt < 100 && !(snapshot.generation > generation && snapshot.status === 'ready'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapshot = await provider.getIndexSnapshot({ limit: 100 });
    }
    assert.ok(snapshot.generation > generation);
    const added = snapshot.entries.find((entry) => entry.path === 'src/added.ts');
    assert.equal(added?.kind, 'file');
    assert.equal(added?.size, 26);
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.entries.some((entry) => entry.path === 'src/main.ts'), true);

    await writeFile(join(root, 'src', 'added.ts'), 'export const added = "updated content";', 'utf8');
    snapshot = await waitForReady(provider, snapshot.generation);
    const modified = snapshot.entries.find((entry) => entry.path === 'src/added.ts');
    assert.equal(modified?.kind, 'file');
    assert.equal(modified?.size, 39);
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.entries.some((entry) => entry.path === 'src/main.ts'), true);

    const modifiedGeneration = snapshot.generation;
    await rm(join(root, 'src', 'added.ts'));
    snapshot = await waitForReady(provider, modifiedGeneration);
    assert.equal(snapshot.entries.some((entry) => entry.path === 'src/added.ts'), false);
    assert.equal(snapshot.entries.some((entry) => entry.path === 'src/main.ts'), true);
  } finally {
    await resetServerLocalWorkspaceStateForTests(root);
    await rm(root, { recursive: true, force: true });
  }
});

test('server-local index filters generated directories and paginates metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-server-index-page-'));
  try {
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'secret.js'), 'generated', 'utf8');
    await writeFile(join(root, 'a.ts'), 'a', 'utf8');
    await writeFile(join(root, 'b.ts'), 'b', 'utf8');
    const provider = new ServerLocalWorkspaceProvider(root);
    const ready = await waitForReady(provider);

    assert.equal(ready.entries.some((entry) => entry.path.includes('node_modules')), false);
    const first = await provider.getIndexSnapshot({ limit: 1 });
    assert.equal(first.entries.length, 1);
    assert.ok(first.nextCursor);
    const second = await provider.getIndexSnapshot({ limit: 1, cursor: first.nextCursor });
    assert.equal(second.entries.length, 1);
    assert.notEqual(second.entries[0]?.path, first.entries[0]?.path);
  } finally {
    await resetServerLocalWorkspaceStateForTests(root);
    await rm(root, { recursive: true, force: true });
  }
});

test('server-local index query returns only a bounded task-relevant projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-server-index-query-'));
  try {
    await mkdir(join(root, 'src', 'billing'), { recursive: true });
    await mkdir(join(root, 'src', 'users'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"index-query"}', 'utf8');
    await writeFile(join(root, 'src', 'billing', 'invoice.service.ts'), 'invoice', 'utf8');
    await writeFile(join(root, 'src', 'users', 'profile.service.ts'), 'profile', 'utf8');
    const provider = new ServerLocalWorkspaceProvider(root);
    await waitForReady(provider);

    const result = await provider.queryWorkspaceIndex({ pathHints: ['src/billing'], query: 'invoice', limit: 2 });

    assert.deepEqual(result.entries.map((entry) => entry.path), ['package.json', 'src/billing/invoice.service.ts']);
    assert.ok(result.matched >= 1);
    assert.equal(result.entries.every((entry) => entry.kind !== 'file' || !('hash' in entry)), true);
  } finally {
    await resetServerLocalWorkspaceStateForTests(root);
    await rm(root, { recursive: true, force: true });
  }
});

test('watcher failure marks the index stale and rebuilds without blocking reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-server-index-watch-error-'));
  try {
    await writeFile(join(root, 'main.ts'), 'main', 'utf8');
    const provider = new ServerLocalWorkspaceProvider(root);
    const ready = await waitForReady(provider);
    const state = getServerLocalWorkspaceState(root);
    state.watcher?.emit('error', new Error('synthetic watcher overflow'));

    const stale = await provider.getIndexSnapshot({ limit: 100 });
    assert.equal(stale.status, 'stale');
    assert.equal(stale.complete, false);
    const rebuilt = await waitForReady(provider, ready.generation);
    assert.ok(rebuilt.generation > ready.generation);
    assert.equal(rebuilt.entries.some((entry) => entry.path === 'main.ts'), true);
  } finally {
    await resetServerLocalWorkspaceStateForTests(root);
    await rm(root, { recursive: true, force: true });
  }
});

test('server-local index persists a sidecar and restores it after in-memory state reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-server-index-persist-'));
  const cache = await mkdtemp(join(tmpdir(), 'agent-cluster-server-index-cache-'));
  try {
    await writeFile(join(root, 'package.json'), '{"name":"persisted"}', 'utf8');
    const provider = new ServerLocalWorkspaceProvider(root, undefined, true, { indexCacheDirectory: cache });
    await waitForReady(provider);
    for (let attempt = 0; attempt < 100 && (await readdir(cache)).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await readdir(cache)).length, 1);

    await resetServerLocalWorkspaceStateForTests(root);
    const restoredProvider = new ServerLocalWorkspaceProvider(root, undefined, true, { indexCacheDirectory: cache });
    let restored = await restoredProvider.getIndexSnapshot({ limit: 100 });
    for (let attempt = 0; attempt < 100 && restored.entries.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      restored = await restoredProvider.getIndexSnapshot({ limit: 100 });
    }
    assert.equal(restored.entries.some((entry) => entry.path === 'package.json'), true);
  } finally {
    await resetServerLocalWorkspaceStateForTests(root);
    await rm(root, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

async function waitForReady(provider: ServerLocalWorkspaceProvider, afterGeneration = -1) {
  let snapshot = await provider.getIndexSnapshot({ limit: 100 });
  for (let attempt = 0; attempt < 200 && !(snapshot.status === 'ready' && snapshot.generation > afterGeneration); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    snapshot = await provider.getIndexSnapshot({ limit: 100 });
  }
  assert.equal(snapshot.status, 'ready');
  return snapshot;
}
