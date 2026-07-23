import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import type {
  WorkspaceFileSnapshot,
  WorkspaceRevision,
  WorkspaceSnapshot,
  WorkspaceTreeNode
} from '@agent-cluster/shared';
import { buildNavigationManifest } from '../../apps/server/src/modules/context-v2/build-navigation-manifest.js';
import { buildProjectMap } from '../../apps/server/src/modules/context-v2/build-project-map.js';
import { buildLargeWorkspaceFixture, LARGE_FIXTURE_FILE_COUNT } from '../../apps/server/src/modules/workspaces/fixtures/build-large-workspace-fixture.js';
import { buildIndexFromSnapshot } from '../../apps/server/src/modules/workspaces/workspace-index/build-index-from-snapshot.js';
import { deriveWorkspaceEntrypoints } from '../../apps/server/src/modules/workspaces/workspace-index/derive-workspace-entrypoints.js';

const revision = {
  id: 'revision-large-workspace-core-entry-scan',
  observedAt: '2026-07-12T00:00:00.000Z'
} satisfies WorkspaceRevision;

test('large workspace scan keeps src/main.ts in core entry surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-large-workspace-'));
  try {
    const fixture = await buildLargeWorkspaceFixture(root);
    assert.ok(fixture.totalFiles >= LARGE_FIXTURE_FILE_COUNT);

    const snapshot = await scanWorkspace(root);
    assert.ok(snapshot.fileCount >= LARGE_FIXTURE_FILE_COUNT);

    const index = buildIndexFromSnapshot(snapshot, revision);
    const entrypoints = deriveWorkspaceEntrypoints(snapshot, index);
    assert.ok(entrypoints.includes('src/main.ts'), `expected src/main.ts in entrypoints: ${JSON.stringify(entrypoints)}`);

    const nav = buildNavigationManifest({ entries: index, entrypoints, maxEntries: 8 });
    const navPaths = nav.entries.map((entry) => entry.path);
    assert.ok(nav.truncated, 'fixture should be large enough to force navigation truncation');
    assert.ok(navPaths.includes('src/main.ts'), `expected src/main.ts in truncated navigation: ${JSON.stringify(navPaths)}`);
    assert.equal(navPaths.some((path) => path.startsWith('generated/')), false);

    const projectMap = buildProjectMap({ entries: index, entrypoints, detectedStack: snapshot.detectedStack });
    const srcModule = projectMap.modules.find((module) => module.name === 'src');
    assert.ok(srcModule);
    assert.deepEqual(srcModule.entrypoints, ['src/main.ts']);
    assert.deepEqual(projectMap.detectedStack, ['typescript']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function scanWorkspace(rootPath: string): Promise<WorkspaceSnapshot> {
  const files: WorkspaceFileSnapshot[] = [];
  const tree = await scanChildren(rootPath, rootPath, files);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return {
    rootName: 'large-workspace-core-entry-scan',
    scannedAt: '2026-07-12T00:00:00.000Z',
    fileCount: files.length,
    totalBytes,
    tree,
    files,
    skipped: [],
    detectedStack: ['typescript'],
    entrypoints: ['src/main.ts']
  };
}

async function scanChildren(
  rootPath: string,
  directory: string,
  files: WorkspaceFileSnapshot[]
): Promise<WorkspaceTreeNode[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nodes: WorkspaceTreeNode[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = join(directory, entry.name);
    const relativePath = toWorkspacePath(relative(rootPath, absolutePath));
    if (entry.isDirectory()) {
      nodes.push({
        path: relativePath,
        kind: 'directory',
        children: await scanChildren(rootPath, absolutePath, files)
      });
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = await stat(absolutePath);
    const content = await readFile(absolutePath, 'utf8');
    files.push({
      path: relativePath,
      size: fileStat.size,
      language: languageForPath(relativePath),
      content
    });
    nodes.push({ path: relativePath, kind: 'file' });
  }
  return nodes;
}

function toWorkspacePath(path: string): string {
  return path.split(sep).join('/');
}

function languageForPath(path: string): string {
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.js')) return 'javascript';
  if (path.endsWith('.json') || path.endsWith('.jsonl')) return 'json';
  if (path.endsWith('.md')) return 'markdown';
  return 'text';
}
