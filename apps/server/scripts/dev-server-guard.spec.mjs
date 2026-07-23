import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  acquireDevServerLock,
  applyEnvFile,
  isPortListening,
  positivePort
} from './dev-server-guard.mjs';

test('applyEnvFile preserves explicit environment values', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-cluster-env-'));
  try {
    const envPath = join(root, '.env');
    writeFileSync(envPath, 'SERVER_PORT=8099\nQUOTED="value"\n', 'utf8');
    const env = { SERVER_PORT: '9000' };
    applyEnvFile(envPath, env);
    assert.deepEqual(env, { SERVER_PORT: '9000', QUOTED: 'value' });
    assert.equal(positivePort(env.SERVER_PORT), 9000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acquireDevServerLock rejects a second live owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-cluster-lock-'));
  const lockPath = join(root, 'server.lock');
  try {
    const lock = acquireDevServerLock({ lockPath, pid: 101, processAlive: (pid) => pid === 101 });
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 101);
    assert.throws(
      () => acquireDevServerLock({ lockPath, pid: 202, processAlive: (pid) => pid === 101 }),
      (error) => error?.code === 'DEV_SERVER_ALREADY_RUNNING' && error.ownerPid === 101
    );
    lock.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acquireDevServerLock replaces a stale owner and only its owner can release it', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-cluster-lock-'));
  const lockPath = join(root, 'server.lock');
  try {
    writeFileSync(lockPath, '{"pid":101}\n', 'utf8');
    const lock = acquireDevServerLock({ lockPath, pid: 202, processAlive: () => false });
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 202);
    lock.release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isPortListening detects an active listener', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let port;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    port = address.port;
    assert.equal(await isPortListening(port), true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.equal(await isPortListening(port), false);
});
