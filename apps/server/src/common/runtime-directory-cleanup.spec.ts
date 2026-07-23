import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeRuntimeDirectory, runtimeDirectoryCleanupOptions } from './runtime-directory-cleanup.js';

test('runtime directory cleanup retries transient Windows directory locks', () => {
  assert.equal(runtimeDirectoryCleanupOptions.recursive, true);
  assert.equal(runtimeDirectoryCleanupOptions.force, true);
  assert.equal(runtimeDirectoryCleanupOptions.maxRetries, 10);
  assert.equal(runtimeDirectoryCleanupOptions.retryDelay, 150);
});

test('runtime directory cleanup waits out a transient process working-directory lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cluster-runtime-cleanup-'));
  const target = join(root, 'runtime-workdir');
  await mkdir(target);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 250)'], {
    cwd: target,
    stdio: 'ignore'
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  try {
    await removeRuntimeDirectory(target);
    await assert.rejects(access(target));
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
