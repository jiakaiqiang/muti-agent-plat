import assert from 'node:assert/strict';
import test from 'node:test';
import { healthIndicatesCompletedRestart, restartDevServer } from './dev-restart-server.mjs';

const requestedAtMs = Date.parse('2026-08-05T00:00:00.000Z');
const healthy = {
  data: {
    status: 'ok',
    runtimeBuildStale: false,
    buildId: 'build-2',
    processId: 202,
    startedAt: '2026-08-05T00:00:01.000Z'
  }
};

test('manual restart completion requires a new backend process when the old process was healthy', () => {
  assert.equal(healthIndicatesCompletedRestart(healthy, { previousProcessId: 101, requestedAtMs }), true);
  assert.equal(healthIndicatesCompletedRestart(healthy, { previousProcessId: 202, requestedAtMs }), false);
});

test('manual restart completion uses startup time when the old backend was offline', () => {
  assert.equal(healthIndicatesCompletedRestart(healthy, { previousProcessId: undefined, requestedAtMs }), true);
  assert.equal(
    healthIndicatesCompletedRestart(
      { ...healthy, data: { ...healthy.data, startedAt: '2026-08-04T23:59:59.000Z' } },
      { previousProcessId: undefined, requestedAtMs }
    ),
    false
  );
});

test('manual restart completion rejects unhealthy or stale builds', () => {
  assert.equal(
    healthIndicatesCompletedRestart(
      { ...healthy, data: { ...healthy.data, runtimeBuildStale: true } },
      { previousProcessId: 101, requestedAtMs }
    ),
    false
  );
});

function restartFixture(launchRuntime) {
  let probes = 0;
  let requested = false;
  return {
    timeoutMs: 1000, pollIntervalMs: 1,
    readLauncher: () => ({ pid: process.pid }),
    writeRestartRequest: () => { requested = true; },
    fetchHealth: async () => {
      probes++;
      if (probes > 1) assert.equal(requested, true);
      return { data: { ...healthy.data, processId: probes < 3 ? 101 : 202 } };
    },
    launchRuntime: async input => {
      assert.equal(probes, 3, 'old healthy backend must not trigger Runtime startup');
      return launchRuntime(input);
    }
  };
}

test('backend restart automatically starts a stopped saved Runtime after new backend readiness', async () => {
  const calls = [];
  const result = await restartDevServer(restartFixture(async input => {
    calls.push(input);
    assert.equal(new URL(input.serverUrl).hostname, '127.0.0.1');
    return { state: 'connected' };
  }));
  assert.equal(result.processId, 202);
  assert.equal(calls.length, 1);
});

test('backend restart reuses an existing Runtime without failing the restart', async () => {
  const result = await restartDevServer(restartFixture(async () => ({ state: 'existing' })));
  assert.equal(result.processId, 202);
});

test('auto-connect failure is reported separately from successful backend restart', async () => {
  await assert.rejects(restartDevServer(restartFixture(async () => {
    throw new Error('fixture startup failed');
  })), /Backend restarted successfully, but Local Runtime auto-connect failed: fixture startup failed/);
});

test('a restart that never becomes ready must not launch Runtime', async () => {
  const options = restartFixture(async () => assert.fail('must not launch'));
  options.timeoutMs = 5;
  options.fetchHealth = async () => undefined;
  await assert.rejects(restartDevServer(options), /Backend did not become healthy/);
});
