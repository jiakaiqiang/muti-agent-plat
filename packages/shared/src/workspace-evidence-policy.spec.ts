import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceIndexSnapshot } from './contracts.js';
import { deriveWorkspaceIndexEntrypoints, isUsableWorkspaceEvidencePath, isWorkspaceTextContent, queryWorkspaceNavigation } from './workspace-evidence-policy.js';

function fixture(paths: string[]): WorkspaceIndexSnapshot {
  return { workspaceId: 'fixture', revision: { id: 'r1', observedAt: '2026-10-11T00:00:00Z' }, generation: 1,
    status: 'ready', complete: true, truncated: false, updatedAt: '2026-10-11T00:00:00Z',
    indexedEntries: paths.length, entrypoints: [], detectedStack: [],
    coverage: { visitedEntries: paths.length, indexedEntries: paths.length, excludedGenerated: 0, sensitiveEntries: 0, skippedSymlinks: 0, failedEntries: 0 },
    entries: paths.map(path => ({ path, kind: 'file', size: 20, generated: false, sensitive: false })) };
}

test('Chinese architecture requests find nested business entrypoints instead of the analysis dependency', () => {
  const index = fixture(['python/.venv/Lib/site-packages/mypyc/analysis/foo.py',
    'python/.venv/Lib/site-packages/mypyc/analysis/foo.pyd', 'python/pyproject.toml',
    'typescript/package.json', 'typescript/src/main.ts', 'python/app.py', 'docs/specs/analysis.html']);
  const selected = queryWorkspaceNavigation(index, { query: '分析一下当前项目中的架构以及每个功能点之间的关联关系', intent: 'analysis', limit: 4 });
  assert.deepEqual(new Set(selected.entries.map(entry => entry.path)), new Set([
    'python/pyproject.toml', 'typescript/package.json', 'python/app.py', 'typescript/src/main.ts'
  ]));
  assert.deepEqual(selected.entrypoints, ['python/pyproject.toml', 'typescript/package.json']);
  assert.equal(selected.truncated, true);
});

test('Chinese filenames and explicit path hints remain searchable without using intent as a keyword', () => {
  const index = fixture(['src/权限.ts', 'src/analysis.ts', 'src/users.ts']);
  assert.deepEqual(queryWorkspaceNavigation(index, { query: '权限', intent: 'analysis' }).entries.map(e => e.path), ['src/权限.ts']);
  assert.deepEqual(queryWorkspaceNavigation(index, { query: '请检查权限功能', intent: 'analysis' }).entries.map(e => e.path), ['src/权限.ts']);
  assert.deepEqual(queryWorkspaceNavigation(index, { pathHints: ['src/users'], intent: 'analysis' }).entries.map(e => e.path), ['src/users.ts']);
});

test('binary and dependency paths are excluded even when an old index labels them as source', () => {
  for (const path of ['python/.venv/a.py', 'venv/a.py', 'src/__pycache__/a.pyc', 'src/a.pyd', 'lib/a.dll', '.pytest_cache/README.md']) {
    assert.equal(isUsableWorkspaceEvidencePath(path), false, path);
  }
  assert.equal(isUsableWorkspaceEvidencePath('python/src/app.py'), true);
  assert.equal(isWorkspaceTextContent('MZ\0binary'), false);
  assert.equal(isWorkspaceTextContent('   '), false);
  assert.equal(isWorkspaceTextContent('中文源码\nexport {}'), true);
  assert.equal(isWorkspaceTextContent('console.log("\u001b[32mready\u001b[0m");'), true);
  assert.deepEqual(deriveWorkspaceIndexEntrypoints(fixture(['python/.venv/README.md', 'python/pyproject.toml']).entries), ['python/pyproject.toml']);
});
