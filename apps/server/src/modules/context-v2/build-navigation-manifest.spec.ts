import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceIndexEntry, WorkspaceRevision } from '@agent-cluster/shared';
import { buildNavigationManifest } from './build-navigation-manifest.js';

const revision = {
  id: 'revision-71',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

function file(path: string, opts: { generated?: boolean; sensitive?: boolean; language?: string } = {}): WorkspaceIndexEntry {
  return {
    path,
    kind: 'file',
    size: 100,
    hash: { algorithm: 'sha256', value: 'c'.repeat(64) },
    revision,
    generated: opts.generated ?? false,
    sensitive: opts.sensitive ?? false,
    ...(opts.language ? { language: opts.language } : {})
  };
}

function dir(path: string, opts: { generated?: boolean; sensitive?: boolean } = {}): WorkspaceIndexEntry {
  return {
    path,
    kind: 'directory',
    revision,
    generated: opts.generated ?? false,
    sensitive: opts.sensitive ?? false
  };
}

test('buildNavigationManifest includes entrypoints and shallow directories, skipping generated/sensitive', () => {
  const entries = [
    dir('src'),
    dir('src/deep/nested/tree'),
    dir('node_modules', { generated: true }),
    file('src/index.ts', { language: 'typescript' }),
    file('README.md', { language: 'markdown' }),
    file('package.json'),
    file('src/util.ts', { language: 'typescript' }),
    file('.env', { sensitive: true }),
    file('dist/main.js', { generated: true })
  ];
  const entrypoints = ['README.md', 'package.json', 'src/index.ts'];
  const manifest = buildNavigationManifest({ entries, entrypoints, maxEntries: 20 });

  const paths = manifest.entries.map((entry) => entry.path);
  assert.ok(paths.includes('src'));
  assert.ok(paths.includes('src/index.ts'));
  assert.ok(paths.includes('README.md'));
  assert.ok(paths.includes('package.json'));
  assert.equal(paths.includes('.env'), false);
  assert.equal(paths.includes('dist/main.js'), false);
  assert.equal(paths.includes('node_modules'), false);
  assert.equal(manifest.truncated, false);
});

test('buildNavigationManifest truncates when maxEntries exceeded and reports nextCursor', () => {
  const entries: WorkspaceIndexEntry[] = [];
  for (let i = 0; i < 20; i += 1) {
    entries.push(file(`src/file-${i}.ts`, { language: 'typescript' }));
  }
  const manifest = buildNavigationManifest({ entries, entrypoints: [], maxEntries: 5 });
  assert.equal(manifest.entries.length, 5);
  assert.equal(manifest.truncated, true);
  assert.ok(manifest.nextCursor);
});

test('buildNavigationManifest preserves entrypoints even under a tight budget', () => {
  const entries = [
    file('src/a.ts'),
    file('src/b.ts'),
    file('src/c.ts'),
    file('src/entry.ts')
  ];
  const manifest = buildNavigationManifest({
    entries,
    entrypoints: ['src/entry.ts'],
    maxEntries: 1
  });
  const paths = manifest.entries.map((entry) => entry.path);
  assert.ok(paths.includes('src/entry.ts'));
});

test('buildNavigationManifest respects budgetTokens and truncates accordingly', () => {
  const entries: WorkspaceIndexEntry[] = [];
  for (let i = 0; i < 100; i += 1) {
    entries.push(file(`src/file-${i}.ts`, { language: 'typescript' }));
  }
  const manifest = buildNavigationManifest({ entries, entrypoints: [], budgetTokens: 500 });
  assert.ok(manifest.entries.length < 100);
  const serialized = JSON.stringify(manifest.entries);
  const estimatedTokens = Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4);
  assert.ok(estimatedTokens <= 500);
});

test('buildNavigationManifest produces deterministic output for same input', () => {
  const entries = [
    file('src/a.ts'),
    file('src/b.ts'),
    file('src/c.ts')
  ];
  const manifest1 = buildNavigationManifest({ entries, entrypoints: [], budgetTokens: 200 });
  const manifest2 = buildNavigationManifest({ entries, entrypoints: [], budgetTokens: 200 });
  assert.deepEqual(manifest1.entries, manifest2.entries);
  assert.equal(manifest1.truncated, manifest2.truncated);
});
