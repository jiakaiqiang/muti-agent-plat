import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalSecretStore } from './local-secret-store.js';

test('Windows credential store protects and restores UTF-8 API keys', {
  skip: process.platform !== 'win32'
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cluster-secrets-'));
  const path = join(directory, 'provider-secrets.json');
  const store = new LocalSecretStore(path);
  const secret = 'sk-local-test-\u4e2d\u6587-!@#$%^&*()';

  try {
    await store.set('model-1', secret);
    assert.equal(await store.get('model-1'), secret);

    const persisted = await readFile(path, 'utf8');
    assert.doesNotMatch(persisted, /sk-local-test/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
