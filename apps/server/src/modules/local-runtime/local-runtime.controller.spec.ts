import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import test from 'node:test';
import type { LocalRuntimeAuthService } from './local-runtime-auth.service.js';
import { LocalRuntimeController } from './local-runtime.controller.js';
import type { LocalRuntimeConnectionService } from './local-runtime-connection.service.js';

test('recovery keeps an already connected worker and cannot rotate its credentials', () => {
  const controller = new LocalRuntimeController({
    resumeTrustedDevice: () => assert.fail('must not invalidate an online worker')
  } as unknown as LocalRuntimeAuthService, {
    isDeviceConnected: () => true
  } as unknown as LocalRuntimeConnectionService);
  assert.throws(() => controller.resume({ deviceId: 'online' }), /already connected/);
});

test('browser connection close cancels the exact pending workspace authorization', async () => {
  let rejectAuthorization!: (error: Error) => void;
  const cancellations: string[] = [];
  const connections = {
    authorizeWorkspace: () => new Promise((_, reject) => {
      rejectAuthorization = reject;
    }),
    cancelWorkspaceAuthorization: (requestId: string) => {
      cancellations.push(requestId);
      rejectAuthorization(new Error('browser disconnected'));
      return true;
    }
  } as unknown as LocalRuntimeConnectionService;
  const controller = new LocalRuntimeController({} as LocalRuntimeAuthService, connections);
  const response = new EventEmitter() as unknown as ServerResponse;

  const authorization = controller.authorizeWorkspace(
    { requestId: 'authorization-browser-refresh' },
    response
  );
  const rejected = assert.rejects(authorization, /browser disconnected/);
  response.emit('close');

  await rejected;
  assert.deepEqual(cancellations, ['authorization-browser-refresh']);
});

test('launch config exposes the public web origin used by the browser and Runtime CLI', () => {
  const previousPublicWebUrl = process.env.PUBLIC_WEB_URL;
  process.env.PUBLIC_WEB_URL = 'https://agent.example.test/runtime/path';
  try {
    const controller = new LocalRuntimeController(
      {} as LocalRuntimeAuthService,
      {} as LocalRuntimeConnectionService
    );
    const result = controller.launchConfig('http', '127.0.0.1:8099');
    assert.equal(result.data.serverUrl, 'https://agent.example.test');
    assert.ok(result.requestId);
  } finally {
    if (previousPublicWebUrl === undefined) delete process.env.PUBLIC_WEB_URL;
    else process.env.PUBLIC_WEB_URL = previousPublicWebUrl;
  }
});

test('launch config prefers LOCAL_RUNTIME_CONNECT_URL over PUBLIC_WEB_URL when set', () => {
  const previousPublicWebUrl = process.env.PUBLIC_WEB_URL;
  const previousConnectUrl = process.env.LOCAL_RUNTIME_CONNECT_URL;
  process.env.PUBLIC_WEB_URL = 'http://127.0.0.1:8089';
  process.env.LOCAL_RUNTIME_CONNECT_URL = 'http://127.0.0.1:8099';
  try {
    const controller = new LocalRuntimeController(
      {} as LocalRuntimeAuthService,
      {} as LocalRuntimeConnectionService
    );
    const result = controller.launchConfig('http', '127.0.0.1:8089');
    assert.equal(result.data.serverUrl, 'http://127.0.0.1:8099');
    assert.ok(result.requestId);
  } finally {
    if (previousPublicWebUrl === undefined) delete process.env.PUBLIC_WEB_URL;
    else process.env.PUBLIC_WEB_URL = previousPublicWebUrl;
    if (previousConnectUrl === undefined) delete process.env.LOCAL_RUNTIME_CONNECT_URL;
    else process.env.LOCAL_RUNTIME_CONNECT_URL = previousConnectUrl;
  }
});

test('launch config falls back to PUBLIC_WEB_URL when LOCAL_RUNTIME_CONNECT_URL is absent', () => {
  const previousPublicWebUrl = process.env.PUBLIC_WEB_URL;
  const previousConnectUrl = process.env.LOCAL_RUNTIME_CONNECT_URL;
  process.env.PUBLIC_WEB_URL = 'http://127.0.0.1:8089';
  delete process.env.LOCAL_RUNTIME_CONNECT_URL;
  try {
    const controller = new LocalRuntimeController(
      {} as LocalRuntimeAuthService,
      {} as LocalRuntimeConnectionService
    );
    const result = controller.launchConfig('http', '127.0.0.1:8089');
    assert.equal(result.data.serverUrl, 'http://127.0.0.1:8089');
    assert.ok(result.requestId);
  } finally {
    if (previousPublicWebUrl === undefined) delete process.env.PUBLIC_WEB_URL;
    else process.env.PUBLIC_WEB_URL = previousPublicWebUrl;
    if (previousConnectUrl === undefined) delete process.env.LOCAL_RUNTIME_CONNECT_URL;
    else process.env.LOCAL_RUNTIME_CONNECT_URL = previousConnectUrl;
  }
});

test('workspace delete endpoint unregisters the requested server workspace', () => {
  const requests: string[] = [];
  const connections = {
    unregisterWorkspace: (workspaceId: string) => {
      requests.push(workspaceId);
      return true;
    }
  } as unknown as LocalRuntimeConnectionService;
  const controller = new LocalRuntimeController({} as LocalRuntimeAuthService, connections);

  const result = controller.unregisterWorkspace('workspace-remove');

  assert.deepEqual(requests, ['workspace-remove']);
  assert.deepEqual(result.data, { workspaceId: 'workspace-remove', unregistered: true });
});
