import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileMetadata, WorkspaceProviderKind, WorkspaceRevision } from '@agent-cluster/shared';
import type { WorkspaceProvider } from './workspace-provider.js';
import { scanWorkspaceProvider } from './workspace-provider-scanner.js';

const revision: WorkspaceRevision = { id: 'revision-1', observedAt: '2026-07-24T00:00:00.000Z' };

test('scanWorkspaceProvider captures grounded Local Runtime evidence without a local absolute path', async () => {
  const provider = fakeProvider([
    file('README.md', 16),
    directory('generated'),
    file('generated/bundle.js', 10),
    file('.env.production', 10),
    directory('src'),
    file('src/main.ts', 24)
  ], {
    'README.md': '# Local project\n',
    'src/main.ts': 'export const local = true;\n'
  });

  const snapshot = await scanWorkspaceProvider(provider, 'local-project');

  assert.equal(snapshot.rootName, 'local-project');
  assert.deepEqual(snapshot.revision, revision);
  assert.deepEqual(snapshot.files.map((entry) => entry.path), ['src/main.ts', 'README.md']);
  assert.deepEqual(snapshot.entrypoints, ['src/main.ts', 'README.md']);
  assert.equal(snapshot.skipped.some((entry) => entry.path === '.env.production' && entry.reason === 'sensitive'), true);
  assert.equal(snapshot.skipped.some((entry) => entry.path === 'generated' && entry.reason === 'ignored_directory'), true);
  assert.equal(JSON.stringify(snapshot).includes('C:\\'), false);
});

test('scanWorkspaceProvider rejects unsafe paths returned by a compromised provider', async () => {
  await assert.rejects(
    scanWorkspaceProvider(fakeProvider([file('../outside.ts', 10)], {}), 'local-project'),
    /WORKSPACE_PATH_INVALID/
  );
});

test('scanWorkspaceProvider rejects a workspace revision change during capture', async () => {
  const provider = fakeProvider(
    [file('README.md', 16)],
    { 'README.md': '# Local project\n' },
    { id: 'revision-2', observedAt: '2026-07-24T00:00:01.000Z' }
  );

  await assert.rejects(
    scanWorkspaceProvider(provider, 'local-project'),
    /WORKSPACE_REVISION_CHANGED_DURING_SNAPSHOT/
  );
});

test('scanWorkspaceProvider rejects a selected file change even when the workspace revision event is delayed', async () => {
  await assert.rejects(
    scanWorkspaceProvider(
      fakeProvider([file('README.md', 16)], { 'README.md': '# Changed project\n' }, revision, {
        'README.md': 'changed-hash'
      }),
      'local-project'
    ),
    /WORKSPACE_FILE_CHANGED_DURING_SNAPSHOT/
  );
});

function fakeProvider(
  entries: FileMetadata[],
  contents: Record<string, string>,
  finalRevision: WorkspaceRevision = revision,
  readHashes: Record<string, string> = {}
): WorkspaceProvider {
  return {
    kind: 'local_bridge' as WorkspaceProviderKind,
    capabilities: () => ({ read: true, write: true, command: false, test: true }),
    getRevision: async () => finalRevision,
    listDirectory: async () => ({ path: '.', entries, revision }),
    statFile: async () => { throw new Error('not used'); },
    readFile: async ({ path }) => {
      const content = contents[path];
      if (content === undefined) throw new Error(`missing fixture content: ${path}`);
      return {
        path,
        content,
        encoding: 'utf-8',
        byteLength: Buffer.byteLength(content),
        truncated: false,
        revision,
        hash: { algorithm: 'sha256', value: readHashes[path] ?? `hash-${path}` },
        startLine: 1,
        endLine: content.split(/\r?\n/).length
      };
    },
    searchText: async () => ({ matches: [], truncated: false, revision }),
    applyChangeSet: async (changeSet) => ({
      ok: true,
      changeSetId: changeSet.id,
      revision,
      appliedCount: 0
    })
  };
}

function file(path: string, size: number): FileMetadata {
  return {
    path,
    kind: 'file',
    size,
    hash: { algorithm: 'sha256', value: `hash-${path}` },
    revision
  };
}

function directory(path: string): FileMetadata {
  return { path, kind: 'directory', revision };
}
