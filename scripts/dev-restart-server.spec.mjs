import assert from 'node:assert/strict';
import test from 'node:test';
import { healthIndicatesCompletedRestart } from './dev-restart-server.mjs';

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
