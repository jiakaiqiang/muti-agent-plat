import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_RUNTIME_PROTOCOL_VERSION } from '@agent-cluster/shared';
import { PersistenceService } from '../persistence/persistence.service.js';
import { LocalRuntimeAuthService } from './local-runtime-auth.service.js';

function setup() {
  const persistence = new PersistenceService({ enabled: false });
  return new LocalRuntimeAuthService(persistence);
}

test('device-code flow requires approval, issues rotatable tokens, and supports revocation', () => {
  const service = setup();
  const code = service.createDeviceCode({
    deviceId: 'device-1',
    displayName: 'developer-pc',
    cliVersion: '0.1.0',
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    runtimes: { codex: 'codex 1.0' }
  }, 'http://localhost:3000');

  assert.deepEqual(service.exchangeDeviceCode(code.deviceCode), {
    status: 'authorization_pending',
    retryAfterSeconds: 3
  });
  const approved = service.approveDeviceCode(code.userCode);
  assert.equal(approved.status, 'active');
  const tokens = service.exchangeDeviceCode(code.deviceCode);
  assert.ok('accessToken' in tokens);
  if (!('accessToken' in tokens)) return;
  assert.equal(service.authenticate(tokens.accessToken).deviceId, 'device-1');

  const rotated = service.refresh(tokens.refreshToken);
  assert.notEqual(rotated.accessToken, tokens.accessToken);
  assert.throws(() => service.authenticate(tokens.accessToken), /invalid or expired/i);

  service.revokeDevice('device-1');
  assert.throws(() => service.authenticate(rotated.accessToken), /invalid or expired/i);
  assert.equal(service.listDevices()[0]?.status, 'revoked');
});

test('incompatible protocol is reported and cannot be approved', () => {
  const service = setup();
  const code = service.createDeviceCode({
    deviceId: 'device-old',
    displayName: 'old-cli',
    cliVersion: '0.1.0',
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION - 1,
    runtimes: {}
  }, 'http://localhost:3000');
  assert.equal(code.compatibility.compatible, false);
  assert.equal(code.compatibility.upgradeRequired, true);
  assert.throws(
    () => service.approveDeviceCode(code.userCode),
    new RegExp(`Protocol ${LOCAL_RUNTIME_PROTOCOL_VERSION - 1} is unsupported`)
  );
});

test('trusted loopback authorization issues tokens without the device-code round trip', () => {
  const service = setup();
  const tokens = service.authorizeTrustedDevice({
    deviceId: 'device-loopback',
    displayName: 'local-developer-pc',
    cliVersion: '0.1.0',
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    runtimes: { codex: 'codex 1.0' }
  });

  assert.equal(tokens.deviceId, 'device-loopback');
  assert.equal(service.authenticate(tokens.accessToken).status, 'active');
});
