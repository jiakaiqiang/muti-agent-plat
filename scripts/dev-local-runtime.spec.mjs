import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { acquireRuntimeLock, canResumeRuntime, canRecoverRuntime, launchDevLocalRuntime, resumeSavedDevice } from './dev-local-runtime.mjs';

const serverUrl = 'http://127.0.0.1:8099';
const saved = { schemaVersion: 2, deviceId: 'existing-device', serverUrl, tokens: { accessToken: 'fixture' }, workspaces: [{ workspaceId: 'existing-workspace' }] };
test('only an authorized saved device for the same backend can auto-connect', () => {
  assert.equal(canResumeRuntime(saved, serverUrl), true);
  assert.equal(canResumeRuntime({ ...saved, tokens: undefined }, serverUrl, {}), false);
  assert.equal(canResumeRuntime(saved, 'http://127.0.0.1:9099'), false);
  assert.equal(canResumeRuntime({ ...saved, serverUrl: 'invalid' }, serverUrl), false);
});

test('credential recovery is restricted to the same saved local development backend', () => {
  const env = { LOCAL_RUNTIME_ALLOW_LOOPBACK_ADMIN_BYPASS: 'true' };
  assert.equal(canResumeRuntime({ ...saved, tokens: undefined }, serverUrl, env), true);
  assert.equal(canResumeRuntime(saved, 'http://localhost:9099', env), false);
  for (const url of ['https://remote.example', 'file:///tmp/local', 'http://user:password@localhost']) {
    assert.equal(canRecoverRuntime(url, env), false);
  }
  assert.equal(canRecoverRuntime(serverUrl, { ...env, NODE_ENV: 'production' }), false);
  assert.equal(canRecoverRuntime(serverUrl, {}), false);
});

test('saved-device recovery preserves all four bindings and never creates or reauthorizes a device', async () => {
  const state = { ...saved, tokens: undefined, workspaces: Array.from({ length: 4 }, (_, i) => ({ workspaceId: `workspace-${i}` })) };
  const bindings = structuredClone(state.workspaces);
  let persisted = false;
  await resumeSavedDevice(state, {
    env: { LOCAL_RUNTIME_ALLOW_LOOPBACK_ADMIN_BYPASS: 'true' },
    saveState: async value => { assert.equal(value, state); persisted = true; },
    request: async (url, init) => {
      assert.equal(url.pathname, '/api/local-runtime/device-tokens/resume');
      assert.deepEqual(JSON.parse(init.body), { deviceId: saved.deviceId });
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal);
      return Response.json({ deviceId: saved.deviceId, accessToken: 'new-access', refreshToken: 'new-refresh' });
    }
  });
  assert.equal(persisted, true);
  assert.deepEqual(state.workspaces, bindings);
});

test('denied recovery preserves saved bindings and credentials', async () => {
  const state = structuredClone(saved);
  for (const status of [401, 403, 409, 503]) {
    await assert.rejects(resumeSavedDevice(state, {
      env: { LOCAL_RUNTIME_ALLOW_LOOPBACK_ADMIN_BYPASS: 'true' },
      saveState: async () => assert.fail('must not save rejected credentials'),
      request: async () => new Response('', { status })
    }), new RegExp(`HTTP ${status}`));
    assert.deepEqual(state, saved);
  }
});

test('missing or foreign state and explicit opt-out do not spawn a process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dev-runtime-policy-'));
  const stateFile = join(dir, 'state.json');
  const options = { serverUrl, env: { AGENT_RUNTIME_STATE_FILE: stateFile }, spawnProcess() { assert.fail('must not spawn'); } };
  assert.equal((await launchDevLocalRuntime(options)).state, 'skipped');
  await writeFile(stateFile, JSON.stringify({ ...saved, serverUrl: 'https://other.example' }));
  assert.equal((await launchDevLocalRuntime(options)).state, 'skipped');
  assert.equal((await launchDevLocalRuntime({ ...options, env: { ...options.env, AGENT_CLUSTER_DEV_AUTO_RUNTIME: 'false' } })).state, 'disabled');
});

test('runtime lock reuses live owner and recovers a dead owner without killing processes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dev-runtime-lock-'));
  const path = join(dir, 'runtime.lock');
  const release = await acquireRuntimeLock(path);
  assert.ok(release);
  assert.equal(await acquireRuntimeLock(path), undefined);
  await release();
  await writeFile(path, JSON.stringify({ pid: 123 }));
  const recovered = await acquireRuntimeLock(path, () => false);
  assert.ok(recovered);
  await recovered();
});

test('launch preserves saved state and keeps runtime out of the service process group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dev-runtime-launch-'));
  const stateFile = join(dir, 'state.json');
  await writeFile(stateFile, JSON.stringify(saved));
  let disconnected = false;
  let detached = false;
  const result = await launchDevLocalRuntime({ serverUrl, env: { AGENT_RUNTIME_STATE_FILE: stateFile, ELECTRON_RUN_AS_NODE: '1' },
    spawnProcess(_command, args, options) {
      assert.equal(args[0], '--import', 'IPC must belong to the worker, not a tsx CLI wrapper');
      assert.ok(args.includes('--worker'));
      assert.equal(options.env.AGENT_RUNTIME_STATE_FILE, stateFile);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(options.detached, true);
      assert.equal(options.windowsHide, true);
      const child = new EventEmitter();
      child.connected = true;
      child.disconnect = () => { disconnected = true; };
      child.unref = () => { detached = true; };
      setImmediate(() => child.emit('message', { state: 'connected', deviceId: saved.deviceId }));
      return child;
    }
  });
  assert.equal(result.deviceId, saved.deviceId);
  assert.equal(disconnected && detached, true);
});
