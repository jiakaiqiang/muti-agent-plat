import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceIndexEntry, WorkspaceRevision } from '@agent-cluster/shared';
import { buildProjectMap } from './build-project-map.js';

const revision = {
  id: 'revision-72',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

function file(path: string, opts: { generated?: boolean; sensitive?: boolean } = {}): WorkspaceIndexEntry {
  return {
    path,
    kind: 'file',
    size: 100,
    hash: { algorithm: 'sha256', value: 'd'.repeat(64) },
    revision,
    generated: opts.generated ?? false,
    sensitive: opts.sensitive ?? false
  };
}

test('buildProjectMap groups by top-level segment with entrypoints and tests', () => {
  const entries = [
    file('apps/server/src/main.ts'),
    file('apps/server/src/util.ts'),
    file('apps/server/src/util.spec.ts'),
    file('packages/shared/src/index.ts'),
    file('packages/shared/src/index.test.ts')
  ];
  const map = buildProjectMap({
    entries,
    entrypoints: ['apps/server/src/main.ts', 'packages/shared/src/index.ts']
  });

  assert.equal(map.source, 'generated');
  const apps = map.modules.find((m) => m.name === 'apps');
  const packages = map.modules.find((m) => m.name === 'packages');
  assert.ok(apps);
  assert.deepEqual(apps!.entrypoints, ['apps/server/src/main.ts']);
  assert.deepEqual(apps!.tests, ['apps/server/src/util.spec.ts']);
  assert.ok(packages);
  assert.deepEqual(packages!.entrypoints, ['packages/shared/src/index.ts']);
  assert.deepEqual(packages!.tests, ['packages/shared/src/index.test.ts']);
});

test('buildProjectMap ignores generated and sensitive entries', () => {
  const entries = [
    file('dist/output.js', { generated: true }),
    file('.env', { sensitive: true }),
    file('src/index.ts')
  ];
  const map = buildProjectMap({ entries, entrypoints: [] });
  const names = map.modules.map((m) => m.name);
  assert.deepEqual(names, ['src']);
});

test('buildProjectMap records detectedStack when provided', () => {
  const entries = [file('src/main.ts')];
  const map = buildProjectMap({
    entries,
    entrypoints: [],
    detectedStack: ['node', 'typescript']
  });
  assert.deepEqual(map.detectedStack, ['node', 'typescript']);
});

test('buildProjectMap detects tests inside __tests__ folders', () => {
  const entries = [
    file('src/service.ts'),
    file('src/__tests__/service.test.ts')
  ];
  const map = buildProjectMap({ entries, entrypoints: [] });
  const src = map.modules.find((m) => m.name === 'src');
  assert.ok(src);
  assert.deepEqual(src!.tests, ['src/__tests__/service.test.ts']);
});

test('buildProjectMap respects budgetTokens and truncates modules', () => {
  const entries: WorkspaceIndexEntry[] = [];
  for (let i = 0; i < 50; i += 1) {
    entries.push(file(`module-${i}/index.ts`));
  }
  const map = buildProjectMap({ entries, entrypoints: [], budgetTokens: 500 });
  assert.ok(map.modules.length < 50);
  const serialized = JSON.stringify(map.modules);
  const estimatedTokens = Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4);
  assert.ok(estimatedTokens <= 500);
});

test('buildProjectMap produces deterministic output for same input', () => {
  const entries = [
    file('apps/main.ts'),
    file('packages/util.ts'),
    file('src/index.ts')
  ];
  const map1 = buildProjectMap({ entries, entrypoints: [], budgetTokens: 300 });
  const map2 = buildProjectMap({ entries, entrypoints: [], budgetTokens: 300 });
  assert.deepEqual(map1.modules, map2.modules);
});
