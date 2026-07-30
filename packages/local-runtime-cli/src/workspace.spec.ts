import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadState } from './state.js';
import { createWorkspaceState, LocalWorkspace, normalizeRelative } from './workspace.js';

async function withWorkspace(run: (workspace: LocalWorkspace, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-workspace-'));
  let workspace: LocalWorkspace | undefined;
  try {
    await writeFile(join(root, 'README.md'), '# Local\n', 'utf8');
    workspace = new LocalWorkspace(await createWorkspaceState(root, 'test-workspace'));
    await run(workspace, root);
  } finally {
    workspace?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('default workspace policy allows normal local execution and keeps destructive changes behind confirmation', async () => {
  await withWorkspace(async (workspace) => {
    assert.deepEqual(workspace.capabilities(), { read: true, write: true, command: true, test: true });
    const listing = await workspace.listDirectory({});
    assert.equal(listing.entries.some((entry) => entry.path === 'README.md'), true);
    const file = await workspace.readFile({ path: 'README.md' });
    assert.equal(file.content, '# Local\n');
    assert.equal(workspace.permissionPolicy().workspace_delete, 'confirm');
    assert.equal(workspace.permissionPolicy().dependency_install, 'confirm');
  });
});

test('legacy workspace state migrates command execution from confirmation to normal allow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-runtime-state-migration-'));
  const stateFile = join(directory, 'state.json');
  const previousStateFile = process.env.AGENT_RUNTIME_STATE_FILE;
  process.env.AGENT_RUNTIME_STATE_FILE = stateFile;
  try {
    await writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      deviceId: 'device-legacy',
      displayName: 'legacy',
      serverUrl: 'http://127.0.0.1:8099',
      workspaces: [{
        workspaceId: 'workspace-legacy',
        displayName: 'legacy-workspace',
        rootPath: directory,
        permissions: {
          workspace_read: 'allow',
          workspace_write: 'allow',
          workspace_delete: 'confirm',
          command_execute: 'confirm',
          test_execute: 'allow',
          dependency_install: 'confirm'
        },
        registeredAt: '2026-07-24T00:00:00.000Z'
      }]
    }), 'utf8');
    const state = await loadState();
    assert.equal(state.workspaces[0]?.permissions.command_execute, 'allow');
    assert.equal(state.workspaces[0]?.permissionPolicyVersion, 2);
    assert.match(await readFile(stateFile, 'utf8'), /"permissionPolicyVersion": 2/);
  } finally {
    if (previousStateFile === undefined) delete process.env.AGENT_RUNTIME_STATE_FILE;
    else process.env.AGENT_RUNTIME_STATE_FILE = previousStateFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test('one-time permissions elevate a dangerous action without becoming persistent', async () => {
  await withWorkspace(async (workspace) => {
    workspace.state.oneTimePermissions = { workspace_delete: true };
    assert.equal(workspace.permissionPolicy().workspace_delete, 'allow');
    assert.deepEqual(workspace.consumeOneTimePermissions(), ['workspace_delete']);
    assert.equal(workspace.permissionPolicy().workspace_delete, 'confirm');
    assert.equal(workspace.state.permissions.workspace_delete, 'confirm');
  });
});

test('change sets are revision-bound and apply writes only inside the workspace', async () => {
  await withWorkspace(async (workspace, root) => {
    const baseRevision = await workspace.revision();
    const applied = await workspace.applyChangeSet({
      id: randomUUID(),
      baseRevision,
      createdAt: new Date().toISOString(),
      changes: [{ operation: 'create', path: 'src/new.ts', content: 'export const value = 1;\n', encoding: 'utf-8' }]
    });
    assert.equal(applied.ok, true);
    assert.equal(await (await import('node:fs/promises')).readFile(join(root, 'src', 'new.ts'), 'utf8'), 'export const value = 1;\n');

    const stale = await workspace.applyChangeSet({
      id: randomUUID(),
      baseRevision,
      createdAt: new Date().toISOString(),
      changes: [{ operation: 'create', path: 'stale.txt', content: 'stale', encoding: 'utf-8' }]
    });
    assert.equal(stale.ok, false);
  });
});

test('delete remains blocked until explicitly granted', async () => {
  await withWorkspace(async (workspace) => {
    const content = '# Local\n';
    await assert.rejects(
      workspace.applyChangeSet({
        id: randomUUID(),
        baseRevision: await workspace.revision(),
        createdAt: new Date().toISOString(),
        changes: [{
          operation: 'delete',
          path: 'README.md',
          expectedHash: { algorithm: 'sha256', value: createHash('sha256').update(content).digest('hex') }
        }]
      }),
      /LOCAL_CONFIRMATION_REQUIRED/
    );
  });
});

test('concurrent ChangeSets with the same base revision are serialized', async () => {
  await withWorkspace(async (workspace, root) => {
    const baseRevision = await workspace.revision();
    const [first, second] = await Promise.all([
      workspace.applyChangeSet({
        id: randomUUID(),
        baseRevision,
        createdAt: new Date().toISOString(),
        changes: [{ operation: 'create', path: 'first.txt', content: 'first', encoding: 'utf-8' }]
      }),
      workspace.applyChangeSet({
        id: randomUUID(),
        baseRevision,
        createdAt: new Date().toISOString(),
        changes: [{ operation: 'create', path: 'second.txt', content: 'second', encoding: 'utf-8' }]
      })
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(await (await import('node:fs/promises')).readFile(join(root, 'first.txt'), 'utf8'), 'first');
    assert.equal(existsSync(join(root, 'second.txt')), false);
  });
});

test('workspace revision is a lightweight generation token and advances after a visible external change', async () => {
  await withWorkspace(async (workspace, root) => {
    const initial = await workspace.revision();
    assert.deepEqual(await workspace.revision(), initial);

    await writeFile(join(root, 'README.md'), '# Changed outside LocalWorkspace\n', 'utf8');
    const changed = await waitForRevisionChange(workspace, initial.id);
    assert.notEqual(changed.id, initial.id);
  });
});

test('listDirectory is metadata-only and never hashes file content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-bounded-list-'));
  let hashedFiles = 0;
  try {
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(root, `${String(index).padStart(2, '0')}.txt`), String(index), 'utf8');
    }
    const workspace = new LocalWorkspace(await createWorkspaceState(root, 'bounded-list'), {
      watch: false,
      index: false,
      hashFile: async () => {
        hashedFiles += 1;
        return { algorithm: 'sha256', value: `hash-${hashedFiles}` };
      }
    });

    const listed = await workspace.listDirectory({ path: '.', limit: 3 });

    assert.equal(listed.entries.length, 3);
    assert.equal(listed.nextCursor, '3');
    assert.equal(hashedFiles, 0);
    assert.equal(listed.entries.every((entry) => entry.kind !== 'file' || entry.hash === undefined), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('background index builds metadata without reading or hashing file content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-index-'));
  let hashedFiles = 0;
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'package.json'), '{"name":"indexed"}', 'utf8');
    await writeFile(join(root, 'src', 'main.ts'), 'export const main = true;', 'utf8');
    const workspace = new LocalWorkspace(await createWorkspaceState(root, 'indexed'), {
      watch: false,
      hashFile: async () => {
        hashedFiles += 1;
        return { algorithm: 'sha256', value: 'unexpected' };
      }
    });

    let snapshot = await workspace.getIndexSnapshot({ limit: 100 });
    for (let attempt = 0; attempt < 100 && snapshot.status !== 'ready'; attempt += 1) {
      await delay(10);
      snapshot = await workspace.getIndexSnapshot({ limit: 100 });
    }

    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.entrypoints, ['package.json']);
    assert.equal(snapshot.entries.some((entry) => entry.path === 'src/main.ts'), true);
    assert.equal(snapshot.entries.every((entry) => entry.kind !== 'file' || !('hash' in entry)), true);
    assert.equal(hashedFiles, 0);
    workspace.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('index query returns a bounded relevant projection without hashing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-index-query-'));
  let hashedFiles = 0;
  try {
    await mkdir(join(root, 'src', 'billing'), { recursive: true });
    await mkdir(join(root, 'src', 'users'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"index-query"}', 'utf8');
    await writeFile(join(root, 'src', 'billing', 'invoice.ts'), 'invoice', 'utf8');
    await writeFile(join(root, 'src', 'users', 'profile.ts'), 'profile', 'utf8');
    const workspace = new LocalWorkspace(await createWorkspaceState(root, 'index-query'), {
      watch: false,
      hashFile: async () => {
        hashedFiles += 1;
        return { algorithm: 'sha256', value: 'unexpected' };
      }
    });
    await waitForReadyIndex(workspace, 0);

    const result = await workspace.queryWorkspaceIndex({ pathHints: ['src/billing'], query: 'invoice', limit: 2 });

    assert.deepEqual(result.entries.map((entry) => entry.path), ['package.json', 'src/billing/invoice.ts']);
    assert.ok(result.matched >= 1);
    assert.equal(hashedFiles, 0);
    workspace.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('partial large-file reads return a range hash without calculating the full-file hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-range-read-'));
  let hashedFiles = 0;
  try {
    await writeFile(join(root, 'large.txt'), 'x'.repeat(1024 * 1024), 'utf8');
    const workspace = new LocalWorkspace(await createWorkspaceState(root, 'range-read'), {
      watch: false,
      index: false,
      hashFile: async () => {
        hashedFiles += 1;
        return { algorithm: 'sha256', value: 'unexpected' };
      }
    });

    const result = await workspace.readFile({ path: 'large.txt', maxBytes: 128 });

    assert.equal(result.byteLength, 128);
    assert.equal(result.truncated, true);
    assert.equal(result.hash, undefined);
    assert.ok(result.rangeHash);
    assert.equal(result.fileSize, 1024 * 1024);
    assert.equal(hashedFiles, 0);
    workspace.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace watcher incrementally updates index entries after add, modify and delete changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-index-watch-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'main.ts'), 'export const main = true;', 'utf8');
    const workspace = new LocalWorkspace(await createWorkspaceState(root, 'index-watch'));
    const initial = await waitForReadyIndex(workspace, 0);

    await writeFile(join(root, 'src', 'added.ts'), 'export const added = true;', 'utf8');
    const added = await waitForReadyIndex(workspace, initial.generation);
    const addedEntry = added.entries.find((entry) => entry.path === 'src/added.ts');
    assert.equal(addedEntry?.kind, 'file');
    assert.equal(addedEntry?.size, 26);
    assert.equal(added.complete, true, JSON.stringify({ initial, added }));
    assert.equal(added.entries.some((entry) => entry.path === 'src/main.ts'), true);

    await writeFile(join(root, 'src', 'added.ts'), 'export const added = "updated content";', 'utf8');
    const modified = await waitForReadyIndex(workspace, added.generation);
    const modifiedEntry = modified.entries.find((entry) => entry.path === 'src/added.ts');
    assert.equal(modifiedEntry?.kind, 'file');
    assert.equal(modifiedEntry?.size, 39);
    assert.equal(modified.complete, true);
    assert.equal(modified.entries.some((entry) => entry.path === 'src/main.ts'), true);

    await rm(join(root, 'src', 'added.ts'));
    const removed = await waitForReadyIndex(workspace, modified.generation);
    assert.equal(removed.entries.some((entry) => entry.path === 'src/added.ts'), false);
    assert.equal(removed.entries.some((entry) => entry.path === 'src/main.ts'), true);
    workspace.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('absolute, traversal, sensitive, home and platform repository paths are rejected', async () => {
  assert.throws(() => normalizeRelative('../outside.txt'), /traversal/i);
  assert.throws(() => normalizeRelative('C:\\outside.txt'), /absolute/i);
  await withWorkspace(async (workspace, root) => {
    await writeFile(join(root, '.env'), 'SECRET=value', 'utf8');
    await assert.rejects(workspace.readFile({ path: '.env' }), /Sensitive path access denied/);
  });

  const platform = await mkdtemp(join(tmpdir(), 'agent-runtime-platform-'));
  try {
    await mkdir(join(platform, 'apps', 'server', 'src'), { recursive: true });
    await mkdir(join(platform, 'packages', 'shared', 'src'), { recursive: true });
    await assert.rejects(createWorkspaceState(platform), /platform repository/i);
    await assert.rejects(createWorkspaceState(join(platform, 'apps', 'server')), /platform repository/i);

    const aliasRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-platform-alias-'));
    try {
      const alias = join(aliasRoot, 'server-alias');
      await symlink(join(platform, 'apps', 'server'), alias, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(createWorkspaceState(alias), /platform repository/i);
    } finally {
      await rm(aliasRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(platform, { recursive: true, force: true });
  }
});

async function waitForRevisionChange(workspace: LocalWorkspace, initialId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const revision = await workspace.revision();
    if (revision.id !== initialId) return revision;
    await delay(10);
  }
  throw new Error('Workspace revision watcher did not observe the external change.');
}

async function waitForReadyIndex(workspace: LocalWorkspace, generation: number) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = await workspace.getIndexSnapshot({ limit: 1_000 });
    if (snapshot.status === 'ready' && snapshot.generation > generation) return snapshot;
    await delay(10);
  }
  throw new Error(`Workspace index did not advance beyond generation ${generation}.`);
}
