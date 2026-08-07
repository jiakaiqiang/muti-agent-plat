import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  consumeDevServerRestartRequest,
  devServerRestartRequestPath,
  writeDevServerRestartRequest
} from './dev-restart-control.mjs';

test('backend restart request is delivered exactly once', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-cluster-restart-'));
  try {
    const requestPath = devServerRestartRequestPath(root, 8099);
    const request = {
      requestId: 'request-1',
      requestedAt: '2026-08-05T00:00:00.000Z',
      launcherPid: 101
    };

    writeDevServerRestartRequest(requestPath, request);
    assert.deepEqual(consumeDevServerRestartRequest(requestPath), { version: 1, ...request });
    assert.equal(consumeDevServerRestartRequest(requestPath), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backend restart request rejects concurrent pending requests', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-cluster-restart-'));
  try {
    const requestPath = devServerRestartRequestPath(root, 8099);
    writeDevServerRestartRequest(requestPath, {
      requestId: 'request-1',
      requestedAt: '2026-08-05T00:00:00.000Z',
      launcherPid: 101
    });

    assert.throws(
      () => writeDevServerRestartRequest(requestPath, {
        requestId: 'request-2',
        requestedAt: '2026-08-05T00:00:01.000Z',
        launcherPid: 101
      }),
      (error) => error?.code === 'DEV_SERVER_RESTART_PENDING'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
