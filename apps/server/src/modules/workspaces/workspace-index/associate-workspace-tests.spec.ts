import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceIndexEntry, WorkspaceRevision } from '@agent-cluster/shared';
import { associateWorkspaceTests } from './associate-workspace-tests.js';

const revision = {
  id: 'revision-66',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

function fileEntry(path: string): WorkspaceIndexEntry {
  return {
    path,
    kind: 'file',
    size: 32,
    hash: { algorithm: 'sha256', value: 'a'.repeat(64) },
    revision,
    generated: false,
    sensitive: false
  };
}

test('associateWorkspaceTests links a source file to a sibling *.spec.ts test', () => {
  const entries = [fileEntry('src/foo.ts'), fileEntry('src/foo.spec.ts')];
  const associations = associateWorkspaceTests(entries);
  assert.deepEqual(associations.get('src/foo.ts'), ['src/foo.spec.ts']);
});

test('associateWorkspaceTests recognizes .test.ts and multiple tests for one source', () => {
  const entries = [
    fileEntry('src/util.ts'),
    fileEntry('src/util.test.ts'),
    fileEntry('src/util.spec.ts')
  ];
  const associations = associateWorkspaceTests(entries);
  const list = associations.get('src/util.ts') ?? [];
  assert.deepEqual(list.slice().sort(), ['src/util.spec.ts', 'src/util.test.ts']);
});

test('associateWorkspaceTests recognizes __tests__ sibling folder tests', () => {
  const entries = [
    fileEntry('src/service.ts'),
    fileEntry('src/__tests__/service.test.ts')
  ];
  const associations = associateWorkspaceTests(entries);
  assert.deepEqual(associations.get('src/service.ts'), ['src/__tests__/service.test.ts']);
});

test('associateWorkspaceTests supports .tsx source with .test.tsx test', () => {
  const entries = [fileEntry('src/Button.tsx'), fileEntry('src/Button.test.tsx')];
  const associations = associateWorkspaceTests(entries);
  assert.deepEqual(associations.get('src/Button.tsx'), ['src/Button.test.tsx']);
});

test('associateWorkspaceTests returns empty association when no test file exists', () => {
  const entries = [fileEntry('src/lonely.ts')];
  const associations = associateWorkspaceTests(entries);
  assert.equal(associations.get('src/lonely.ts'), undefined);
});

test('associateWorkspaceTests does not associate a spec file to itself', () => {
  const entries = [fileEntry('src/foo.spec.ts')];
  const associations = associateWorkspaceTests(entries);
  assert.equal(associations.get('src/foo.spec.ts'), undefined);
});
