import assert from 'node:assert/strict';
import test from 'node:test';
import { renameWithRetry } from './atomic-file.js';

test('retries a transient Windows file lock while replacing a state file', async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  let attempts = 0;
  try {
    await renameWithRetry('temporary', 'state.json', {
      renameFile: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error('locked'), { code: 'EPERM' });
        }
      },
      sleep: async () => {}
    });
    assert.equal(attempts, 3);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});

test('does not retry a permanent file-system error', async () => {
  let attempts = 0;
  await assert.rejects(
    renameWithRetry('temporary', 'state.json', {
      renameFile: async () => {
        attempts += 1;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      sleep: async () => {}
    }),
    { code: 'ENOENT' }
  );
  assert.equal(attempts, 1);
});
