import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WorkspaceRequestTimeoutError,
  withRequestTimeout
} from './request-timeout.js';

test('withRequestTimeout resolves when the underlying operation settles in time', async () => {
  const result = await withRequestTimeout({
    requestId: 'r1',
    workspaceId: 'ws-99',
    timeoutMs: 100,
    operation: Promise.resolve('ok')
  });
  assert.equal(result, 'ok');
});

test('withRequestTimeout rejects with WorkspaceRequestTimeoutError when operation hangs', async () => {
  const hang = new Promise<string>(() => undefined);
  await assert.rejects(
    () => withRequestTimeout({
      requestId: 'r2',
      workspaceId: 'ws-99',
      timeoutMs: 25,
      operation: hang
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceRequestTimeoutError);
      assert.equal((error as WorkspaceRequestTimeoutError).code, 'WORKSPACE_REQUEST_TIMEOUT');
      assert.equal((error as WorkspaceRequestTimeoutError).requestId, 'r2');
      assert.equal((error as WorkspaceRequestTimeoutError).workspaceId, 'ws-99');
      return true;
    }
  );
});

test('withRequestTimeout calls onTimeout hook exactly once when timeout fires', async () => {
  let hits = 0;
  const hang = new Promise<string>(() => undefined);
  await assert.rejects(() =>
    withRequestTimeout({
      requestId: 'r3',
      workspaceId: 'ws-99',
      timeoutMs: 20,
      operation: hang,
      onTimeout: () => {
        hits += 1;
      }
    })
  );
  assert.equal(hits, 1);
});

test('withRequestTimeout propagates underlying rejection without touching hooks', async () => {
  let hits = 0;
  await assert.rejects(
    () => withRequestTimeout({
      requestId: 'r4',
      workspaceId: 'ws-99',
      timeoutMs: 100,
      operation: Promise.reject(new Error('boom')),
      onTimeout: () => {
        hits += 1;
      }
    }),
    /boom/
  );
  assert.equal(hits, 0);
});
