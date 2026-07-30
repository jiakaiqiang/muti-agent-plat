import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceRevision, WorkspaceSnapshot } from '@agent-cluster/shared';
import { buildIndexFromSnapshot } from './build-index-from-snapshot.js';

const revision = {
  id: 'revision-62',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

const snapshot: WorkspaceSnapshot = {
  rootName: 'demo-repo',
  scannedAt: '2026-07-11T00:00:00.000Z',
  fileCount: 2,
  totalBytes: 40,
  tree: [
    {
      path: 'src',
      kind: 'directory',
      children: [
        { path: 'src/index.ts', kind: 'file' },
        { path: 'src/utils.ts', kind: 'file' }
      ]
    }
  ],
  files: [
    { path: 'src/index.ts', size: 20, language: 'typescript', content: 'export const a = 1;' },
    { path: 'src/utils.ts', size: 20, language: 'typescript', content: 'export const b = 2;' }
  ],
  skipped: []
};

test('buildIndexFromSnapshot emits directory + file entries with correct kind and language', () => {
  const entries = buildIndexFromSnapshot(snapshot, revision);

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const srcDir = byPath.get('src');
  const indexFile = byPath.get('src/index.ts');
  const utilsFile = byPath.get('src/utils.ts');

  assert.ok(srcDir);
  assert.equal(srcDir!.kind, 'directory');
  assert.equal(srcDir!.revision.id, revision.id);

  assert.ok(indexFile);
  assert.equal(indexFile!.kind, 'file');
  if (indexFile!.kind === 'file') {
    assert.equal(indexFile!.size, 20);
    assert.equal(indexFile!.language, 'typescript');
    assert.equal(indexFile!.hash!.algorithm, 'sha256');
  }

  assert.ok(utilsFile);
});

test('buildIndexFromSnapshot flags known generated paths and sensitive paths', () => {
  const s: WorkspaceSnapshot = {
    ...snapshot,
    tree: [
      { path: 'dist/output.js', kind: 'file' },
      { path: '.env', kind: 'file' }
    ],
    files: [
      { path: 'dist/output.js', size: 10, language: 'javascript' },
      { path: '.env', size: 12 }
    ]
  };
  const entries = buildIndexFromSnapshot(s, revision);
  const generated = entries.find((entry) => entry.path === 'dist/output.js');
  const sensitive = entries.find((entry) => entry.path === '.env');
  assert.ok(generated);
  assert.equal(generated!.generated, true);
  assert.ok(sensitive);
  assert.equal(sensitive!.sensitive, true);
});

test('buildIndexFromSnapshot returns files even when content is absent (fallback hash)', () => {
  const s: WorkspaceSnapshot = {
    ...snapshot,
    tree: [{ path: 'README.md', kind: 'file' }],
    files: [{ path: 'README.md', size: 100, language: 'markdown' }]
  };
  const entries = buildIndexFromSnapshot(s, revision);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.kind, 'file');
  if (entry.kind === 'file') {
    assert.equal(entry.size, 100);
    assert.equal(entry.hash!.algorithm, 'sha256');
    assert.equal(entry.hash!.value.length, 64);
  }
});
