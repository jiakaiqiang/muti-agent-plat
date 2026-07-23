import assert from 'node:assert/strict';
import test from 'node:test';
import { OpsController } from './ops.controller.js';

function setup(current?: Record<string, unknown>) {
  const enterCalls: Array<{ reason: string; requestedBy: string }> = [];
  const persistence = {
    currentDataEpoch: () => 'epoch-current',
    backendName: () => 'file',
    locationSummary: () => 'C:\\data\\state.v3.json',
    isInMaintenanceMode: () => Boolean(current)
  };
  const maintenance = {
    current: () => current,
    async enter(input: { reason: string; requestedBy: string }) {
      enterCalls.push(input);
      return {
        status: 'active',
        dataEpoch: 'epoch-current',
        invalidatedWorkspaceCount: 0,
        rejectedRequestCount: 0,
        ...input
      };
    }
  };
  return {
    controller: new OpsController(persistence as never, maintenance as never),
    enterCalls
  };
}

function withToken(value: string | undefined, action: () => unknown | Promise<unknown>) {
  const previous = process.env.AGENT_CLUSTER_MAINTENANCE_TOKEN;
  if (value === undefined) delete process.env.AGENT_CLUSTER_MAINTENANCE_TOKEN;
  else process.env.AGENT_CLUSTER_MAINTENANCE_TOKEN = value;
  return Promise.resolve()
    .then(action)
    .finally(() => {
      if (previous === undefined) delete process.env.AGENT_CLUSTER_MAINTENANCE_TOKEN;
      else process.env.AGENT_CLUSTER_MAINTENANCE_TOKEN = previous;
    });
}

test('health reports data schema v3', () => {
  const response = setup().controller.health();
  assert.equal(response.data.dataSchemaVersion, 3);
});

test('health reports the active dataEpoch', () => {
  const response = setup().controller.health();
  assert.equal(response.data.dataEpoch, 'epoch-current');
});

test('maintenance status is read-only and reports inactive state', () => {
  assert.deepEqual(setup().controller.maintenanceStatus().data, { active: false, state: null });
});

test('maintenance entry refuses operation when server token is not configured', async () => {
  await withToken(undefined, async () => {
    await assert.rejects(
      () => setup().controller.enterMaintenance(undefined, { reason: 'cutover', requestedBy: 'operator' }),
      /MAINTENANCE_TOKEN_NOT_CONFIGURED/
    );
  });
});

test('maintenance entry rejects a missing caller token', async () => {
  await withToken('maintenance-secret-with-entropy', async () => {
    await assert.rejects(
      () => setup().controller.enterMaintenance(undefined, { reason: 'cutover', requestedBy: 'operator' }),
      /MAINTENANCE_UNAUTHORIZED/
    );
  });
});

test('maintenance entry rejects an incorrect caller token', async () => {
  await withToken('maintenance-secret-with-entropy', async () => {
    await assert.rejects(
      () => setup().controller.enterMaintenance('wrong-token', { reason: 'cutover', requestedBy: 'operator' }),
      /MAINTENANCE_UNAUTHORIZED/
    );
  });
});

test('maintenance entry requires an operational reason and operator identity', async () => {
  await withToken('maintenance-secret-with-entropy', async () => {
    await assert.rejects(
      () => setup().controller.enterMaintenance('maintenance-secret-with-entropy', { reason: '', requestedBy: '' }),
      /MAINTENANCE_REQUEST_INVALID/
    );
  });
});

test('authorized maintenance entry delegates exact operational metadata', async () => {
  await withToken('maintenance-secret-with-entropy', async () => {
    const fixture = setup();
    const response = await fixture.controller.enterMaintenance('maintenance-secret-with-entropy', {
      reason: 'context-v2-cutover',
      requestedBy: 'release-operator'
    });
    assert.deepEqual(fixture.enterCalls, [{ reason: 'context-v2-cutover', requestedBy: 'release-operator' }]);
    assert.equal(response.data.status, 'active');
  });
});

test('maintenance response never includes the authorization token', async () => {
  await withToken('maintenance-secret-with-entropy', async () => {
    const response = await setup().controller.enterMaintenance('maintenance-secret-with-entropy', {
      reason: 'cutover',
      requestedBy: 'operator'
    });
    assert.doesNotMatch(JSON.stringify(response), /maintenance-secret-with-entropy/);
  });
});
