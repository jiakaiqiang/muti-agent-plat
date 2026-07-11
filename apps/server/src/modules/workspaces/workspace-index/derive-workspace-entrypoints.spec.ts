import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceRevision, WorkspaceSnapshot } from '@agent-cluster/shared';
import { buildIndexFromSnapshot } from './build-index-from-snapshot.js';
import { deriveWorkspaceEntrypoints } from './derive-workspace-entrypoints.js';

const revision = {
  id: 'revision-65',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

function snap(files: Array<{ path: string; content?: string; language?: string }>): WorkspaceSnapshot {
  return {
    rootName: 'demo',
    scannedAt: '2026-07-11T00:00:00.000Z',
    fileCount: files.length,
    totalBytes: 100,
    tree: files.map((file) => ({ path: file.path, kind: 'file' })),
    files: files.map((file) => ({
      path: file.path,
      size: file.content ? file.content.length : 32,
      ...(file.content ? { content: file.content } : {}),
      ...(file.language ? { language: file.language } : {})
    })),
    skipped: []
  };
}

test('deriveWorkspaceEntrypoints identifies README, package.json and package.json main field', () => {
  const packageJson = JSON.stringify({
    name: 'demo',
    main: 'src/entry.ts',
    bin: { demo: 'bin/demo.js' }
  });
  const snapshot = snap([
    { path: 'README.md', content: '# demo', language: 'markdown' },
    { path: 'package.json', content: packageJson, language: 'json' },
    { path: 'src/entry.ts', content: 'export {}', language: 'typescript' },
    { path: 'bin/demo.js', content: '#!/usr/bin/env node', language: 'javascript' },
    { path: 'src/util.ts', content: 'export const a = 1;', language: 'typescript' }
  ]);
  const index = buildIndexFromSnapshot(snapshot, revision);
  const entrypoints = deriveWorkspaceEntrypoints(snapshot, index);
  assert.ok(entrypoints.includes('README.md'));
  assert.ok(entrypoints.includes('package.json'));
  assert.ok(entrypoints.includes('src/entry.ts'));
  assert.ok(entrypoints.includes('bin/demo.js'));
  assert.equal(entrypoints.includes('src/util.ts'), false);
});

test('deriveWorkspaceEntrypoints falls back to conventional index paths when no package.json exists', () => {
  const snapshot = snap([
    { path: 'src/index.ts', content: 'export {}', language: 'typescript' },
    { path: 'src/main.ts', content: 'export {}', language: 'typescript' }
  ]);
  const index = buildIndexFromSnapshot(snapshot, revision);
  const entrypoints = deriveWorkspaceEntrypoints(snapshot, index);
  assert.ok(entrypoints.includes('src/index.ts'));
  assert.ok(entrypoints.includes('src/main.ts'));
});

test('deriveWorkspaceEntrypoints ignores generated and sensitive files even if they match patterns', () => {
  const snapshot = snap([
    { path: 'dist/index.js', content: 'ok', language: 'javascript' },
    { path: '.env', content: 'SECRET=x' }
  ]);
  const index = buildIndexFromSnapshot(snapshot, revision);
  const entrypoints = deriveWorkspaceEntrypoints(snapshot, index);
  assert.equal(entrypoints.includes('dist/index.js'), false);
  assert.equal(entrypoints.includes('.env'), false);
});

test('deriveWorkspaceEntrypoints tolerates malformed package.json without crashing', () => {
  const snapshot = snap([
    { path: 'package.json', content: '{ not valid json' },
    { path: 'src/index.ts', content: 'ok', language: 'typescript' }
  ]);
  const index = buildIndexFromSnapshot(snapshot, revision);
  const entrypoints = deriveWorkspaceEntrypoints(snapshot, index);
  assert.ok(entrypoints.includes('package.json'));
  assert.ok(entrypoints.includes('src/index.ts'));
});
