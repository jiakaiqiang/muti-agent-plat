import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReadFileResult, WorkspaceOperationRequest } from '@agent-cluster/shared';
import { selectEvidenceWithinBudget } from '../../apps/server/src/modules/context-v2/select-evidence-within-budget.js';
import { prioritizeRequestedEvidence } from '../../apps/server/src/modules/context-v2/prioritize-requested-evidence.js';
import { BrokerGateway, type BrokerClient } from '../../apps/server/src/modules/workspaces/runtime-broker/broker-gateway.js';
import { BrokerWorkspaceProvider } from '../../apps/server/src/modules/workspaces/runtime-broker/broker-workspace-provider.js';
import { fetchRequestedEvidence } from '../../apps/server/src/modules/workspaces/runtime-broker/fetch-requested-evidence.js';
import { PendingRequestRegistry } from '../../apps/server/src/modules/workspaces/runtime-broker/pending-request-registry.js';

const revision = { id: 'rev-local-runtime-requested-paths', observedAt: '2026-07-12T00:00:00.000Z' };

test('local Runtime requestedPaths are read through the broker and enter retry selected evidence', async () => {
  const dispatched: WorkspaceOperationRequest[] = [];
  const brokerFiles = new Map<string, string>([
    ['src/lazy-route.ts', 'export const lazyRouteMarker = "LOCAL_RUNTIME_REQUESTED_PATH_BODY";'],
    ['docs/architecture.md', '# Architecture\n\nLocal Runtime supplied this missing document.\n']
  ]);
  let requestCounter = 0;
  const pending = new PendingRequestRegistry();
  const client: BrokerClient = {
    clientId: 'local-runtime-client-130',
    send: (payload) => {
      const request = payload.payload as WorkspaceOperationRequest;
      dispatched.push(request);
      queueMicrotask(() => {
        if (request.operation !== 'readFile') return;
        const path = request.input.path;
        const content = brokerFiles.get(path);
        if (content === undefined) {
          pending.settle({
            requestId: request.requestId,
            workspaceId: request.workspaceId,
            operation: 'readFile',
            status: 'error',
            error: { code: 'WORKSPACE_FILE_NOT_FOUND', message: path }
          });
          return;
        }
        pending.settle({
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          operation: 'readFile',
          status: 'ok',
          data: readFileResult(path, content)
        });
      });
    }
  };
  const gateway = new BrokerGateway(() => 'epoch-test');
  gateway.registerWorkspace(client, {
    clientId: client.clientId,
    workspaceId: 'local-runtime-ws-130',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: false, command: false, test: false },
    displayName: 'Local Runtime workspace'
  });
  const provider = new BrokerWorkspaceProvider('local-runtime-ws-130', {
    gateway,
    pending,
    makeRequestId: () => `req-local-runtime-read-${requestCounter += 1}`,
    timeoutMs: 1_000
  });

  const requestedPaths = ['src/lazy-route.ts', 'docs/architecture.md'];
  const fetched = await fetchRequestedEvidence({ provider, requestedPaths });
  assert.equal(fetched.errors.length, 0);
  assert.deepEqual(
    dispatched.map((request) => request.operation),
    ['readFile', 'readFile']
  );
  assert.deepEqual(
    dispatched.map((request) => request.operation === 'readFile' ? request.input.path : ''),
    requestedPaths
  );

  const contents = new Map(fetched.files.map((file) => [file.path, file]));
  const selected = selectEvidenceWithinBudget({
    candidates: prioritizeRequestedEvidence([], requestedPaths),
    contents,
    budgetBytes: 4_000
  });
  assert.deepEqual(
    selected.files.map((file) => file.path).sort(),
    [...requestedPaths].sort()
  );
  assert.equal(selected.totalByteLength > 0, true);
  assert.equal(selected.truncated, false);
  assert.ok(selected.files.some((file) => file.content.includes('LOCAL_RUNTIME_REQUESTED_PATH_BODY')));
});

function readFileResult(path: string, content: string): ReadFileResult {
  return {
    path,
    content,
    encoding: 'utf-8',
    byteLength: Buffer.byteLength(content, 'utf8'),
    truncated: false,
    revision,
    hash: { algorithm: 'sha256', value: 'b'.repeat(64) }
  };
}
