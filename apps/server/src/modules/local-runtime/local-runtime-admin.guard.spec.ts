import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  assertLocalRuntimeAdminConfiguration,
  LocalRuntimeAdminGuard
} from './local-runtime-admin.guard.js';
import { LocalRuntimeController } from './local-runtime.controller.js';

const ADMIN_TOKEN = 'single-user-admin-token-with-32-characters';

function context(authorization?: string, remoteAddress = '203.0.113.10') {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization }, socket: { remoteAddress } })
    })
  } as unknown as ExecutionContext;
}

async function withEnvironment(
  values: Partial<Record<'NODE_ENV' | 'LOCAL_RUNTIME_ADMIN_TOKEN' | 'LOCAL_RUNTIME_ALLOW_LOOPBACK_ADMIN_BYPASS', string | undefined>>,
  run: () => void | Promise<void>
) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('accepts the configured single-user administrator bearer token', async () => {
  await withEnvironment({ NODE_ENV: 'production', LOCAL_RUNTIME_ADMIN_TOKEN: ADMIN_TOKEN }, () => {
    assert.equal(new LocalRuntimeAdminGuard().canActivate(context(`Bearer ${ADMIN_TOKEN}`)), true);
  });
});

test('rejects missing and invalid administrator credentials', async () => {
  await withEnvironment({ NODE_ENV: 'production', LOCAL_RUNTIME_ADMIN_TOKEN: ADMIN_TOKEN }, () => {
    assert.throws(() => new LocalRuntimeAdminGuard().canActivate(context()), /credentials are required/i);
    assert.throws(
      () => new LocalRuntimeAdminGuard().canActivate(context('Bearer wrong-token')),
      /credentials are required/i
    );
  });
});

test('allows only an explicit non-production loopback bypass', async () => {
  await withEnvironment({
    NODE_ENV: 'development',
    LOCAL_RUNTIME_ADMIN_TOKEN: undefined,
    LOCAL_RUNTIME_ALLOW_LOOPBACK_ADMIN_BYPASS: 'true'
  }, () => {
    assert.equal(new LocalRuntimeAdminGuard().canActivate(context(undefined, '::1')), true);
    assert.throws(
      () => new LocalRuntimeAdminGuard().canActivate(context(undefined, '203.0.113.10')),
      /credential is not configured/i
    );
  });
});

test('production configuration fails closed without a strong token or with loopback bypass', () => {
  assert.throws(
    () => assertLocalRuntimeAdminConfiguration({ NODE_ENV: 'production' }),
    /required in production/i
  );
  assert.throws(
    () => assertLocalRuntimeAdminConfiguration({ NODE_ENV: 'production', LOCAL_RUNTIME_ADMIN_TOKEN: 'short' }),
    /at least 32/i
  );
  assert.throws(
    () => assertLocalRuntimeAdminConfiguration({
      NODE_ENV: 'production',
      LOCAL_RUNTIME_ADMIN_TOKEN: ADMIN_TOKEN,
      LOCAL_RUNTIME_ALLOW_LOOPBACK_ADMIN_BYPASS: 'true'
    }),
    /cannot be enabled in production/i
  );
});

test('administrator guard protects approval and management endpoints but not CLI token exchange', () => {
  for (const method of ['approve', 'devices', 'revoke', 'workspaces'] as const) {
    const guards = Reflect.getMetadata(GUARDS_METADATA, LocalRuntimeController.prototype[method]) as unknown[];
    assert.equal(guards.includes(LocalRuntimeAdminGuard), true, `${method} must require administrator authentication`);
  }
  for (const method of ['createDeviceCode', 'exchange', 'refresh', 'currentDevice', 'revokeCurrentDevice'] as const) {
    const guards = Reflect.getMetadata(GUARDS_METADATA, LocalRuntimeController.prototype[method]) as unknown[] | undefined;
    assert.equal(guards?.includes(LocalRuntimeAdminGuard) ?? false, false, `${method} must remain available to the CLI`);
  }
});

test('administrator endpoints use the standard browser API response envelope', () => {
  const auth = {
    approveDeviceCode: (userCode: string) => ({ deviceId: `approved-${userCode}` }),
    listDevices: () => [{ deviceId: 'device-1' }],
    revokeDevice: (deviceId: string) => ({ deviceId, status: 'revoked' })
  };
  const connections = {
    isDeviceConnected: () => true,
    disconnectDevice: () => undefined,
    listWorkspaces: () => [{ workspaceId: 'workspace-1' }]
  };
  const controller = new LocalRuntimeController(auth as never, connections as never);

  assert.deepEqual(controller.approve({ userCode: 'ABCD-EFGH' }).data, { deviceId: 'approved-ABCD-EFGH' });
  assert.deepEqual(controller.devices().data, [{ deviceId: 'device-1', connected: true }]);
  assert.deepEqual(controller.revoke('device-1').data, { deviceId: 'device-1', status: 'revoked' });
  assert.deepEqual(controller.workspaces().data, [{ workspaceId: 'workspace-1' }]);
});
