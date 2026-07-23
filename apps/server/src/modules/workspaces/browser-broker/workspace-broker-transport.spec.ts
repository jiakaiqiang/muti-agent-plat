import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { BrokerGateway } from './broker-gateway.js';
import { BrowserBrokerProvider } from './browser-broker-provider.js';
import { HeartbeatTracker } from './heartbeat-tracker.js';
import { PendingRequestRegistry } from './pending-request-registry.js';
import { WorkspaceBrokerTransport } from './workspace-broker-transport.js';

test('WorkspaceBrokerTransport carries a provider read through a real WebSocket', async () => {
  const gateway = new BrokerGateway(() => 'epoch-test');
  const pending = new PendingRequestRegistry();
  const transport = new WorkspaceBrokerTransport(gateway, pending, new HeartbeatTracker(10_000));
  const server = createServer();
  transport.attach(server, new Set(['http://localhost:8089']));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  const socket = new WebSocket(
    `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/workspace-broker?clientId=test-client`,
    { origin: 'http://localhost:8089' }
  );
  await once(socket, 'open');
  socket.send(JSON.stringify({
    kind: 'workspace.register',
    payload: {
      workspaceId: 'browser-workspace',
      providerKind: 'browser_broker',
      capabilities: { read: true, write: false, command: false, test: false },
      displayName: 'Browser workspace'
    }
  }));
  await waitForMessage(socket, 'workspace.registered');

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.kind !== 'workspace.operation.request') return;
    const request = message.payload;
    socket.send(JSON.stringify({
      kind: 'workspace.operation.result',
      payload: {
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        operation: request.operation,
        status: 'ok',
        data: {
          path: request.input.path,
          content: 'export const broker = true;',
          encoding: 'utf-8', byteLength: 27, truncated: false,
          revision: { id: 'rev', observedAt: '2026-07-12T00:00:00.000Z' },
          hash: { algorithm: 'sha256', value: 'a'.repeat(64) }
        }
      }
    }));
  });

  const provider = new BrowserBrokerProvider('browser-workspace', { gateway, pending, timeoutMs: 1_000 });
  const result = await provider.readFile({ path: 'src/main.ts' });
  assert.match(result.content, /broker = true/);

  socket.close();
  await once(socket, 'close');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function waitForMessage(socket: WebSocket, kind: string): Promise<void> {
  for (;;) {
    const [raw] = await once(socket, 'message');
    const message = JSON.parse(raw.toString());
    if (message.kind === kind) return;
  }
}
