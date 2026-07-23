import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceRevision, WorkspaceSnapshot } from '@agent-cluster/shared';
import { buildLargeWorkspaceFixture } from './build-large-workspace-fixture.js';
import { buildIndexFromSnapshot } from '../workspace-index/build-index-from-snapshot.js';
import { deriveWorkspaceEntrypoints } from '../workspace-index/derive-workspace-entrypoints.js';
import { isGeneratedWorkspacePath } from '../workspace-index/is-generated-workspace-path.js';

const revision = {
  id: 'revision-t128',
  observedAt: '2026-07-12T00:00:00.000Z'
} satisfies WorkspaceRevision;

function buildScanSnapshot(extraFiles: Array<{ path: string; content: string }>): WorkspaceSnapshot {
  const files = [
    {
      path: 'package.json',
      size: 64,
      content: JSON.stringify({ name: 'large-demo', main: 'src/main.ts' }),
      language: 'json'
    },
    { path: 'src/main.ts', size: 32, content: "export function main() { return 'ok'; }\n", language: 'typescript' },
    { path: 'README.md', size: 16, content: '# demo\n', language: 'markdown' },
    ...extraFiles.map((file) => ({
      path: file.path,
      size: file.content.length,
      content: file.content,
      language: 'typescript'
    }))
  ];
  return {
    rootName: 'large-demo',
    scannedAt: '2026-07-12T00:00:00.000Z',
    fileCount: files.length,
    totalBytes: files.reduce((acc, file) => acc + file.size, 0),
    tree: files.map((file) => ({ path: file.path, kind: 'file' as const })),
    files,
    skipped: []
  };
}

test('generated directory in the 1000-file fixture is classified as generated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-scan-t128-'));
  try {
    const result = await buildLargeWorkspaceFixture(root);
    assert.ok(result.perGroup.generated >= 500, 'generated bucket materialised');
    assert.equal(isGeneratedWorkspacePath('generated/module-0.js'), true);
    assert.equal(isGeneratedWorkspacePath('generated/module-42.d.ts'), true);
    assert.equal(isGeneratedWorkspacePath('src/unit-0.ts'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('core entrypoint src/main.ts is preserved even with 500 generated build outputs alongside', () => {
  const generatedFiles = Array.from({ length: 500 }, (_, i) => ({
    path: `generated/module-${i}.js`,
    content: `export const m${i} = ${i};\n`
  }));
  const snapshot = buildScanSnapshot(generatedFiles);
  const index = buildIndexFromSnapshot(snapshot, revision);
  const entrypoints = deriveWorkspaceEntrypoints(snapshot, index);
  assert.ok(entrypoints.includes('src/main.ts'), 'src/main.ts must not be crowded out by generated files');
  assert.ok(entrypoints.includes('package.json'));
  assert.ok(entrypoints.includes('README.md'));
  for (const path of entrypoints) {
    assert.equal(path.startsWith('generated/'), false, `generated path leaked into entrypoints: ${path}`);
  }
});
