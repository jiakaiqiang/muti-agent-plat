import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeInvocationPlan } from './invocation-plan.fixture.js';
import {
  buildServerRuntimeWorkerEnv,
  serverRuntimeWorkerExecArgv,
  serverRuntimeWorkerMaxConcurrency,
  serverRuntimeWorkerMaxOldSpaceMb,
  ServerRuntimeWorkerService
} from './server-runtime-worker.service.js';

test('Worker resource ceilings use safe defaults and reject invalid overrides', () => {
  const previousConcurrency = process.env.AGENT_CLUSTER_SERVER_RUNTIME_MAX_CONCURRENCY;
  const previousHeap = process.env.AGENT_CLUSTER_SERVER_RUNTIME_MAX_OLD_SPACE_MB;
  try {
    delete process.env.AGENT_CLUSTER_SERVER_RUNTIME_MAX_CONCURRENCY;
    delete process.env.AGENT_CLUSTER_SERVER_RUNTIME_MAX_OLD_SPACE_MB;
    assert.equal(serverRuntimeWorkerMaxConcurrency(), 4);
    assert.equal(serverRuntimeWorkerMaxOldSpaceMb(), 512);

    process.env.AGENT_CLUSTER_SERVER_RUNTIME_MAX_CONCURRENCY = '8';
    process.env.AGENT_CLUSTER_SERVER_RUNTIME_MAX_OLD_SPACE_MB = '1024';
    assert.equal(serverRuntimeWorkerMaxConcurrency(), 8);
    assert.equal(serverRuntimeWorkerMaxOldSpaceMb(), 1024);
    assert.deepEqual(serverRuntimeWorkerExecArgv(['--import', 'tsx', '--max-old-space-size=256']), [
      '--import',
      'tsx',
      '--max-old-space-size=1024'
    ]);

    process.env.AGENT_CLUSTER_SERVER_RUNTIME_MAX_CONCURRENCY = '0';
    process.env.AGENT_CLUSTER_SERVER_RUNTIME_MAX_OLD_SPACE_MB = 'unbounded';
    assert.equal(serverRuntimeWorkerMaxConcurrency(), 4);
    assert.equal(serverRuntimeWorkerMaxOldSpaceMb(), 512);
  } finally {
    if (previousConcurrency === undefined) delete process.env.AGENT_CLUSTER_SERVER_RUNTIME_MAX_CONCURRENCY;
    else process.env.AGENT_CLUSTER_SERVER_RUNTIME_MAX_CONCURRENCY = previousConcurrency;
    if (previousHeap === undefined) delete process.env.AGENT_CLUSTER_SERVER_RUNTIME_MAX_OLD_SPACE_MB;
    else process.env.AGENT_CLUSTER_SERVER_RUNTIME_MAX_OLD_SPACE_MB = previousHeap;
  }
});

test('Worker environment uses an allowlist and excludes backend credentials', () => {
  const env = buildServerRuntimeWorkerEnv({
    PATH: '/runtime/bin',
    CODEX_RUNTIME_ENABLED: 'true',
    OPENAI_API_KEY: 'runtime-provider-key',
    DATABASE_URL: 'postgresql://secret',
    POSTGRES_PASSWORD: 'database-secret',
    LOCAL_RUNTIME_ADMIN_TOKEN: 'platform-admin-secret',
    AGENT_CLUSTER_SECRET_KEY: 'platform-secret'
  });

  assert.equal(env.PATH, '/runtime/bin');
  assert.equal(env.CODEX_RUNTIME_ENABLED, 'true');
  assert.equal(env.OPENAI_API_KEY, 'runtime-provider-key');
  assert.equal(env.AGENT_CLUSTER_RUNTIME_WORKER, 'true');
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.POSTGRES_PASSWORD, undefined);
  assert.equal(env.LOCAL_RUNTIME_ADMIN_TOKEN, undefined);
  assert.equal(env.AGENT_CLUSTER_SECRET_KEY, undefined);
});

test('a Worker failure returns an invocation result without terminating the control process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server-runtime-worker-'));
  const service = new ServerRuntimeWorkerService();
  const previous = process.env.CODEX_RUNTIME_ENABLED;
  process.env.CODEX_RUNTIME_ENABLED = 'false';
  try {
    const plan = makeInvocationPlan({
      executionTarget: {
        runtimeType: 'codex',
        source: 'global_default',
        reason: 'worker isolation test',
        requiredCapabilities: [],
        requiredToolIds: [],
        writeMode: 'none',
        workspaceProviderKind: 'server_local',
        executionLocation: 'server'
      }
    });
    const parentPid = process.pid;
    const handle = service.start(plan, root);
    const workerPids = service.activeWorkerPids();
    assert.equal(workerPids.length, 1);
    assert.notEqual(workerPids[0], parentPid);
    const result = await handle.result;
    assert.equal(result.status, 'blocked', JSON.stringify(result.error));
    assert.equal(process.pid, parentPid);
    assert.equal(service.activeWorkerCount(), 0);
  } finally {
    if (previous === undefined) delete process.env.CODEX_RUNTIME_ENABLED;
    else process.env.CODEX_RUNTIME_ENABLED = previous;
    await service.onModuleDestroy();
    await rm(root, { recursive: true, force: true });
  }
});

test('a crashed Worker fails the invocation without terminating the control process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server-runtime-worker-crash-'));
  const service = new ServerRuntimeWorkerService();
  const previous = process.env.CODEX_RUNTIME_ENABLED;
  process.env.CODEX_RUNTIME_ENABLED = 'true';
  try {
    const plan = makeInvocationPlan({
      invocationId: 'worker-crash-invocation',
      executionTarget: {
        runtimeType: 'codex',
        source: 'global_default',
        reason: 'worker crash isolation test',
        requiredCapabilities: [],
        requiredToolIds: [],
        writeMode: 'none',
        workspaceProviderKind: 'server_local',
        executionLocation: 'server'
      }
    });
    const parentPid = process.pid;
    const handle = service.start(plan, root);
    const [workerPid] = service.activeWorkerPids();
    assert.ok(workerPid);
    assert.notEqual(workerPid, parentPid);

    process.kill(workerPid);
    const result = await handle.result;

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.details?.workerCode, 'SERVER_RUNTIME_WORKER_EXITED');
    assert.equal(process.pid, parentPid);
    assert.equal(service.activeWorkerCount(), 0);
  } finally {
    if (previous === undefined) delete process.env.CODEX_RUNTIME_ENABLED;
    else process.env.CODEX_RUNTIME_ENABLED = previous;
    await service.onModuleDestroy();
    await rm(root, { recursive: true, force: true });
  }
});

test('Server Runtime Worker fails closed for a local execution target', async () => {
  const service = new ServerRuntimeWorkerService();
  const plan = makeInvocationPlan({
    executionTarget: {
      runtimeType: 'codex',
      source: 'global_default',
      reason: 'route mismatch test',
      requiredCapabilities: [],
      requiredToolIds: [],
      writeMode: 'none',
      workspaceProviderKind: 'local_bridge',
      executionLocation: 'local'
    }
  });
  const result = await service.start(plan, '.').result;
  assert.equal(result.status, 'failed');
  assert.match(result.error?.message ?? '', /SERVER_RUNTIME_ROUTE_MISMATCH/);
});
