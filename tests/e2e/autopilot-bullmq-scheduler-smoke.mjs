import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
let redisUrl = process.env.REDIS_URL;
const prefix = `agent-cluster-autopilot-acceptance-${Date.now()}`;
const dataFile = join(root, '.cache', 'agent-cluster', `autopilot-bullmq-${Date.now()}.json`);
let redisContainerName;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close(() => {
        if (typeof address === 'object' && address?.port) resolve(String(address.port));
        else reject(new Error('Could not allocate a free port'));
      });
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.stdio ?? 'inherit',
      env: { ...process.env, ...(options.env ?? {}) }
    });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
    child.once('error', reject);
  });
}

async function runNpm(args) {
  if (!npmCli) throw new Error('npm_execpath is required; run this script through npm.');
  await run(process.execPath, [npmCli, ...args]);
}

async function canConnectToRedis() {
  if (!redisUrl) return false;
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 2_000 });
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

async function waitForRedis() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await canConnectToRedis()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Redis did not become ready');
}

async function ensureRedis() {
  if (await canConnectToRedis()) return;
  const port = await findFreePort();
  redisContainerName = `agent-cluster-autopilot-acceptance-${Date.now()}`;
  await run('docker', [
    'run', '-d', '--rm', '--name', redisContainerName,
    '-p', `${port}:6379`,
    'redis:7-alpine', 'redis-server', '--appendonly', 'yes'
  ]);
  redisUrl = `redis://localhost:${port}/0`;
  await waitForRedis();
}

async function waitForServer(apiBase) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/health`);
      if (response.ok) return;
    } catch {
      // Continue until the process has bound its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Server did not become ready');
}

async function startServer(mockDelayMs = 750) {
  const port = await findFreePort();
  const apiBase = `http://127.0.0.1:${port}/api`;
  const server = spawn(process.execPath, ['apps/server/dist/apps/server/src/main.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SERVER_PORT: port,
      AGENT_CLUSTER_PERSISTENCE: 'true',
      AGENT_CLUSTER_PERSISTENCE_BACKEND: 'file',
      AGENT_CLUSTER_DATA_FILE: dataFile,
      AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'true',
      LLM_DRY_RUN: 'true',
      LLM_MOCK_FALLBACK: 'true',
      MOCK_RUNTIME_ENABLED: 'true',
      MOCK_RUNTIME_DELAY_MS: String(mockDelayMs),
      DISCUSSION_MAX_ROUNDS: '0',
      REQUIRE_USER_CONFIRMATION: 'false',
      AUTOPILOT_ENABLED: 'true',
      AUTOPILOT_POLL_MS: '50',
      AUTOPILOT_RUN_TIMEOUT_MS: '120000',
      ENABLE_BULLMQ: 'true',
      REDIS_URL: redisUrl,
      BULLMQ_PREFIX: prefix,
      QUEUE_LOCK_DURATION_MS: '4000',
      QUEUE_STALLED_INTERVAL_MS: '1000',
      LOG_FORMAT: 'json'
    }
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForServer(apiBase);
  return { apiBase, server };
}

async function stopServer(handle) {
  if (!handle?.server.killed) handle.server.kill();
  await new Promise((resolve) => {
    if (!handle?.server || handle.server.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 3_000);
    handle.server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function api(apiBase, path, init) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitForRun(apiBase, autopilotId, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    const response = await api(apiBase, `/autopilots/${autopilotId}/runs`);
    last = response.data;
    const match = last.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for autopilot run: ${JSON.stringify(last)}`);
}

async function openAutopilotQueue() {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue('agent-autopilot-queue', { connection, prefix });
  return { connection, queue };
}

async function cleanupQueues() {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  try {
    for (const name of ['agent-autopilot-queue', 'agent-task-queue']) {
      const queue = new Queue(name, { connection, prefix });
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  } finally {
    await connection.quit();
  }
}

await ensureRedis();
await cleanupQueues().catch(() => undefined);
await runNpm(['run', 'build', '-w', '@agent-cluster/shared']);
await runNpm(['run', 'build', '-w', '@agent-cluster/server']);

let server;
let queueHandle;
try {
  server = await startServer();
  queueHandle = await openAutopilotQueue();

  const queueOps = await api(server.apiBase, '/ops/queues');
  assert.equal(queueOps.data?.enabled, true);
  const executionQueue = queueOps.data?.queues?.find((item) => item.name === 'agent-task-queue');
  assert.equal(executionQueue?.status, 'connected');
  for (const key of ['waiting', 'active', 'completed', 'failed']) {
    assert.equal(typeof executionQueue?.[key], 'number', `Queue metric ${key} must be numeric.`);
  }

  const scheduled = await api(server.apiBase, '/autopilots', {
    method: 'POST',
    body: JSON.stringify({
      name: 'P0 scheduled acceptance',
      prompt: 'Run a safe scheduled mock delivery.',
      schedule: '*/2 * * * * *',
      enabled: true
    })
  });
  const scheduledId = scheduled.data.id;
  const schedulerId = `autopilot-schedule:${scheduledId}`;
  const schedulers = await queueHandle.queue.getJobSchedulers();
  assert.ok(
    schedulers.some((item) => item.key === schedulerId || item.id === schedulerId),
    `BullMQ scheduler was not registered: ${JSON.stringify(schedulers)}`
  );

  const scheduledRun = await waitForRun(
    server.apiBase,
    scheduledId,
    (run) => run.trigger === 'scheduled' && run.status === 'completed'
  );
  assert.ok(scheduledRun.sessionId);
  const scheduledSession = await api(server.apiBase, `/sessions/${scheduledRun.sessionId}`);
  assert.equal(scheduledSession.data.origin, 'autopilot');
  assert.equal(scheduledSession.data.autopilotRunId, scheduledRun.id);

  await api(server.apiBase, `/autopilots/${scheduledId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false })
  });
  const runCountAfterDisable = (await api(server.apiBase, `/autopilots/${scheduledId}/runs`)).data.length;
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const schedulersAfterDisable = await queueHandle.queue.getJobSchedulers();
  assert.ok(!schedulersAfterDisable.some((item) => item.key === schedulerId || item.id === schedulerId));
  assert.equal(
    (await api(server.apiBase, `/autopilots/${scheduledId}/runs`)).data.length,
    runCountAfterDisable,
    'Disabled scheduler must not create another run.'
  );

  const issueguard = await api(server.apiBase, '/autopilots', {
    method: 'POST',
    body: JSON.stringify({ name: 'P0 issueguard acceptance', prompt: 'Run once only.', enabled: true })
  });
  const first = await api(server.apiBase, `/autopilots/${issueguard.data.id}/trigger`, {
    method: 'POST', body: '{}'
  });
  const duplicate = await api(server.apiBase, `/autopilots/${issueguard.data.id}/trigger`, {
    method: 'POST', body: '{}'
  });
  assert.equal(first.data.duplicate, false);
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(duplicate.data.run.id, first.data.run.id);
  await waitForRun(
    server.apiBase,
    issueguard.data.id,
    (run) => run.id === first.data.run.id && run.status === 'completed'
  );

  const restartable = await api(server.apiBase, '/autopilots', {
    method: 'POST',
    body: JSON.stringify({ name: 'P0 restart acceptance', prompt: 'Survive a worker restart.', enabled: true })
  });
  const beforeRestart = await api(server.apiBase, `/autopilots/${restartable.data.id}/trigger`, {
    method: 'POST', body: '{}'
  });
  const running = await waitForRun(
    server.apiBase,
    restartable.data.id,
    (run) => run.id === beforeRestart.data.run.id && run.status === 'running' && Boolean(run.sessionId)
  );
  const originalSessionId = running.sessionId;

  await stopServer(server);
  server = await startServer(50);
  const recovered = await waitForRun(
    server.apiBase,
    restartable.data.id,
    (run) => run.id === running.id && (run.status === 'completed' || run.status === 'failed'),
    90_000
  );
  assert.equal(recovered.status, 'completed', `Restarted run failed: ${JSON.stringify(recovered)}`);
  assert.equal(recovered.sessionId, originalSessionId, 'Worker restart must reuse the existing session.');
  const recoveredSession = await api(server.apiBase, `/sessions/${recovered.sessionId}`);
  assert.equal(recoveredSession.data.autopilotRunId, recovered.id);

  console.log(
    `autopilot BullMQ acceptance ok: scheduled=${scheduledRun.id}, issueguard=${first.data.run.id}, recovered=${recovered.id}`
  );
} finally {
  if (server) await stopServer(server).catch(() => undefined);
  if (queueHandle) {
    await queueHandle.queue.close().catch(() => undefined);
    await queueHandle.connection.quit().catch(() => undefined);
  }
  await cleanupQueues().catch(() => undefined);
  rmSync(dataFile, { force: true });
  if (redisContainerName) await run('docker', ['stop', redisContainerName]).catch(() => undefined);
}
