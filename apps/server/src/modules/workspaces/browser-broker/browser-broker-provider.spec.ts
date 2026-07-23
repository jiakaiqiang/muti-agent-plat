import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReadFileResult, WorkspaceOperationRequest } from '@agent-cluster/shared';
import { BrokerGateway, type BrokerClient } from './broker-gateway.js';
import { PendingRequestRegistry } from './pending-request-registry.js';
import {
  BrowserBrokerProvider,
  BrowserBrokerProviderError
} from './browser-broker-provider.js';

function testSetup() {
  const sent: unknown[] = [];
  const client: BrokerClient = { clientId: 'client-104', send: (payload) => sent.push(payload) };
  const gateway = new BrokerGateway(() => 'epoch-test');
  gateway.registerWorkspace(client, {
    clientId: 'client-104',
    workspaceId: 'ws-104',
    providerKind: 'browser_broker',
    capabilities: { read: true, write: false, command: false, test: false },
    displayName: 'demo'
  });
  const pending = new PendingRequestRegistry();
  return { sent, gateway, pending };
}

test('BrowserBrokerProvider.readFile dispatches request and resolves matching response', async () => {
  const { sent, gateway, pending } = testSetup();
  const provider = new BrowserBrokerProvider('ws-104', {
    gateway,
    pending,
    makeRequestId: () => 'req-104'
  });
  const readFileResult: ReadFileResult = {
    path: 'src/index.ts',
    content: 'export {}',
    encoding: 'utf-8',
    byteLength: 9,
    truncated: false,
    revision: { id: 'rev-104', observedAt: '2026-07-11T00:00:00.000Z' },
    hash: { algorithm: 'sha256', value: 'a'.repeat(64) }
  };
  const promise = provider.readFile({ path: 'src/index.ts' });
  const dispatched = sent[0] as { payload: WorkspaceOperationRequest };
  assert.equal(dispatched.payload.operation, 'readFile');
  assert.equal(dispatched.payload.requestId, 'req-104');
  pending.settle({
    requestId: 'req-104',
    workspaceId: 'ws-104',
    operation: 'readFile',
    status: 'ok',
    data: readFileResult
  });
  const result = await promise;
  assert.equal(result.path, 'src/index.ts');
  assert.equal(result.hash.value, 'a'.repeat(64));
});

test('BrowserBrokerProvider.readFile rethrows structured error when broker reports failure', async () => {
  const { gateway, pending } = testSetup();
  const provider = new BrowserBrokerProvider('ws-104', {
    gateway,
    pending,
    makeRequestId: () => 'req-error'
  });
  const promise = provider.readFile({ path: 'missing.ts' });
  pending.settle({
    requestId: 'req-error',
    workspaceId: 'ws-104',
    operation: 'readFile',
    status: 'error',
    error: { code: 'WORKSPACE_FILE_NOT_FOUND', message: 'missing.ts' }
  });
  await assert.rejects(
    () => promise,
    (error: unknown) => {
      assert.ok(error instanceof BrowserBrokerProviderError);
      assert.equal((error as BrowserBrokerProviderError).code, 'WORKSPACE_FILE_NOT_FOUND');
      return true;
    }
  );
});
