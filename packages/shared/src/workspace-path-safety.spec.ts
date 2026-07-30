import assert from 'node:assert/strict';
import test from 'node:test';
import { isSensitiveWorkspacePath } from './workspace-path-safety.js';

test('shared sensitive workspace policy covers environment, credential, and key paths', () => {
  for (const path of [
    '.env',
    'apps/server/.env.production',
    '.docker/config.json',
    '.ssh/id_ed25519',
    '.gitconfig',
    '.netrc',
    'certificates/client.pem',
    'certificates/client.key'
  ]) {
    assert.equal(isSensitiveWorkspacePath(path), true, path);
  }
  assert.equal(isSensitiveWorkspacePath('src/index.ts'), false);
  assert.equal(isSensitiveWorkspacePath('Dockerfile'), false);
});
