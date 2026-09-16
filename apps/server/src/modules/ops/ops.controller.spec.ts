import test from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { OpsController } from './ops.controller.js';
import { SKIP_PERSISTENCE_COMMIT } from '../persistence/skip-persistence-commit.js';

function withEnv(values: Record<string, string | undefined>, fn: () => void) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('health exposes build time, commit and effective pipeline version', () => {
  withEnv(
    {
      AGENT_CLUSTER_BUILD_TIME: '2026-07-11T02:00:00.000Z',
      AGENT_CLUSTER_COMMIT: 'abc1234'
    },
    () => {
      const response = new OpsController(
        {
          currentDataEpoch: () => 'epoch-test',
          backendName: () => 'file',
          locationSummary: () => 'C:\\data\\state.v3.json',
          isInMaintenanceMode: () => false
        } as never,
        { current: () => undefined } as never
      ).health();

      assert.equal(response.data.buildTime, '2026-07-11T02:00:00.000Z');
      assert.equal(response.data.buildId, 'abc1234:2026-07-11T02:00:00.000Z');
      assert.equal(response.data.runtimeBuildStale, false);
      assert.equal(response.data.commit, 'abc1234');
      assert.equal(response.data.pipelineVersion, 'v2');
      assert.equal(response.data.dataSchemaVersion, 3);
      assert.equal(response.data.dataEpoch, 'epoch-test');
      assert.equal(response.data.processId, process.pid);
      assert.match(response.data.startedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(response.data.persistenceBackend, 'file');
      assert.equal(response.data.persistenceLocation, 'C:\\data\\state.v3.json');
    }
  );
});

test('probes skip the global persistence commit so a write backlog cannot make them time out', () => {
  // 全局 PersistenceCommitInterceptor 会在响应前 await flush()，也就是等整条
  // pendingPostgresWrites 队列排空。工作流启动时那一批整块 setCollection 能把
  // 队列堆到数秒，探活一旦排在队尾就会超过前端 5s 超时，前端随即清空会话，
  // 症状是「选完工作流后整页访问不到后端」。探活不写库，必须豁免。
  for (const handler of [OpsController.prototype.health, OpsController.prototype.live]) {
    assert.equal(
      Reflect.getMetadata(SKIP_PERSISTENCE_COMMIT, handler),
      true,
      `${handler.name} must be marked @SkipPersistenceCommit()`
    );
  }
});

test('live reports process liveness without reading readiness dependencies', () => {
  const response = new OpsController(
    new Proxy({}, { get() { throw new Error('liveness must not read persistence'); } }) as never,
    { current: () => undefined } as never
  ).live();

  assert.equal(response.data.status, 'ok');
  assert.equal(response.data.service, 'agent-cluster-server');
  assert.equal(response.data.processId, process.pid);
  assert.match(response.data.startedAt, /^\d{4}-\d{2}-\d{2}T/);
});
