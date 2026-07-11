import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceRevision, WorkspaceSnapshot } from '@agent-cluster/shared';
import { isSensitiveWorkspacePath } from './is-sensitive-workspace-path.js';
import { buildIndexFromSnapshot } from './build-index-from-snapshot.js';

test('isSensitiveWorkspacePath flags credential files', () => {
  assert.equal(isSensitiveWorkspacePath('.env'), true);
  assert.equal(isSensitiveWorkspacePath('apps/server/.env.production'), true);
  assert.equal(isSensitiveWorkspacePath('.npmrc'), true);
  assert.equal(isSensitiveWorkspacePath('.gitconfig'), true);
  assert.equal(isSensitiveWorkspacePath('.netrc'), true);
});

test('isSensitiveWorkspacePath flags SSH and key files', () => {
  assert.equal(isSensitiveWorkspacePath('home/.ssh/id_rsa'), true);
  assert.equal(isSensitiveWorkspacePath('secrets/service-account.pem'), true);
  assert.equal(isSensitiveWorkspacePath('config/db.key'), true);
});

test('isSensitiveWorkspacePath flags known secret name patterns', () => {
  assert.equal(isSensitiveWorkspacePath('config/api-key.json'), true);
  assert.equal(isSensitiveWorkspacePath('secret-config.yml'), true);
  assert.equal(isSensitiveWorkspacePath('tokens/access_token.txt'), true);
});

test('isSensitiveWorkspacePath returns false for regular source files', () => {
  assert.equal(isSensitiveWorkspacePath('src/index.ts'), false);
  assert.equal(isSensitiveWorkspacePath('README.md'), false);
  assert.equal(isSensitiveWorkspacePath('apps/server/tsconfig.json'), false);
});

test('buildIndexFromSnapshot marks sensitive entries end-to-end', () => {
  const revision = {
    id: 'revision-64',
    observedAt: '2026-07-11T00:00:00.000Z'
  } satisfies WorkspaceRevision;
  const snapshot: WorkspaceSnapshot = {
    rootName: 'demo',
    scannedAt: '2026-07-11T00:00:00.000Z',
    fileCount: 3,
    totalBytes: 100,
    tree: [
      { path: '.env', kind: 'file' },
      { path: 'config/api-key.json', kind: 'file' },
      { path: 'src/index.ts', kind: 'file' }
    ],
    files: [
      { path: '.env', size: 32 },
      { path: 'config/api-key.json', size: 50 },
      { path: 'src/index.ts', size: 20, language: 'typescript' }
    ],
    skipped: []
  };
  const entries = buildIndexFromSnapshot(snapshot, revision);
  const envEntry = entries.find((entry) => entry.path === '.env');
  const apiKeyEntry = entries.find((entry) => entry.path === 'config/api-key.json');
  const srcEntry = entries.find((entry) => entry.path === 'src/index.ts');
  assert.ok(envEntry);
  assert.equal(envEntry!.sensitive, true);
  assert.ok(apiKeyEntry);
  assert.equal(apiKeyEntry!.sensitive, true);
  assert.ok(srcEntry);
  assert.equal(srcEntry!.sensitive, false);
});
