import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
let redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379/0';
const prefix = `agent-cluster-smoke-${Date.now()}`;
const dataFile = join(root, '.cache', 'agent-cluster', `bullmq-ops-${Date.now()}.json`);
let redisContainerName;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address?.port) {
          resolve(String(address.port));
        } else {
          reject(new Error('Could not allocate a free port'));
        }
      });
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.stdio ?? 'inherit',
      env: {
        ...process.env,
        ...(options.env ?? {})
      }
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
      }
    });
    child.on('error', reject);
  });
}

function runNpm(args) {
  if (!npmCli) {
    throw new Error('npm_execpath is required; run this script through npm.');
  }
  return run(process.execPath, [npmCli, ...args]);
}

async function waitForRedis() {
  const deadline = Date.now() + 30_000;
  let lastError;

  while (Date.now() < deadline) {
    const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    try {
      const pong = await redis.ping();
      await redis.quit();
      if (pong === 'PONG') {
        return;
      }
    } catch (error) {
      lastError = error;
      redis.disconnect();
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  throw lastError ?? new Error('Redis did not become ready');
}

async function canConnectToRedis() {
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 2_000 });
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

async function ensureRedis() {
  if (await canConnectToRedis()) {
    return;
  }

  const port = await findFreePort();
  redisContainerName = `agent-cluster-redis-smoke-${Date.now()}`;
  await run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    redisContainerName,
    '-p',
    `${port}:6379`,
    'redis:7-alpine',
    'redis-server',
    '--appendonly',
    'yes'
  ]);
  redisUrl = `redis://localhost:${port}/0`;
  process.env.REDIS_URL = redisUrl;
  await waitForRedis();
}

async function waitForServer(apiBase) {
  const deadline = Date.now() + 20_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/health`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw lastError ?? new Error('Server did not become ready');
}

async function api(apiBase, path, init) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {})
    },
    ...init
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function listEvents(apiBase, sessionId) {
  const response = await api(apiBase, `/sessions/${sessionId}/events?limit=200`);
  return response.data.items;
}

async function waitForEvent(apiBase, sessionId, type, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = (await listEvents(apiBase, sessionId)).find((item) => item.type === type);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for event: ${type}`);
}

async function waitForStatus(apiBase, sessionId, status, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const detail = await api(apiBase, `/sessions/${sessionId}`);
    last = detail.data.status;
    if (last === status) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for status ${status}, last=${last}`);
}

async function cleanupQueue() {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue('agent-task-queue', { connection, prefix });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
    await connection.quit();
  }
}

await ensureRedis();
await cleanupQueue().catch(() => undefined);
await runNpm(['run', 'build', '-w', '@agent-cluster/shared']);
await runNpm(['run', 'build', '-w', '@agent-cluster/server']);

const port = await findFreePort();
const apiBase = `http://127.0.0.1:${port}/api`;
const server = spawn(process.execPath, ['apps/server/dist/apps/server/src/main.js'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SERVER_PORT: port,
    ENABLE_BULLMQ: 'true',
    REDIS_URL: redisUrl,
    BULLMQ_PREFIX: prefix,
    AGENT_CLUSTER_DATA_FILE: dataFile,
    AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'true',
    LLM_DRY_RUN: 'true',
    LLM_MOCK_FALLBACK: 'true',
    MOCK_RUNTIME_ENABLED: 'true',
    MOCK_RUNTIME_DELAY_MS: '20',
    DISCUSSION_MAX_ROUNDS: '0',
    LOG_FORMAT: 'json'
  }
});

server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  await waitForServer(apiBase);
  const queues = await api(apiBase, '/ops/queues');
  const queueItems = queues.data?.queues;
  if (queues.data?.enabled !== true) {
    throw new Error(`BullMQ should be enabled: ${JSON.stringify(queues)}`);
  }
  if (!Array.isArray(queueItems) || queueItems.length < 1) {
    throw new Error(`Queue summary missing: ${JSON.stringify(queues)}`);
  }

  const taskQueue = queueItems.find((item) => item.name === 'agent-task-queue');
  if (!taskQueue) {
    throw new Error(`agent-task-queue missing: ${JSON.stringify(queues)}`);
  }
  if (taskQueue.status !== 'connected') {
    throw new Error(`agent-task-queue should be connected: ${JSON.stringify(taskQueue)}`);
  }
  for (const key of ['waiting', 'active', 'completed', 'failed']) {
    if (typeof taskQueue[key] !== 'number') {
      throw new Error(`agent-task-queue ${key} should be numeric: ${JSON.stringify(taskQueue)}`);
    }
  }
  const created = await api(apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'BullMQ smoke verifies real queued execution.',
      agentIds: ['coordinator', 'backend', 'test', 'review']
    })
  });
  const sessionId = created.data.session.id;
  const briefEvent = await waitForEvent(apiBase, sessionId, 'brief_created');
  const briefId = briefEvent.metadata.payload.briefId;
  await api(apiBase, `/sessions/${sessionId}/briefs/${briefId}/confirm`, { method: 'POST' });
  await waitForStatus(apiBase, sessionId, 'COMPLETED');

  const queuesAfterExecution = await api(apiBase, '/ops/queues');
  const taskQueueAfterExecution = queuesAfterExecution.data.queues.find((item) => item.name === 'agent-task-queue');
  if (!taskQueueAfterExecution || taskQueueAfterExecution.completed < 1) {
    throw new Error(`BullMQ execution job was not completed: ${JSON.stringify(queuesAfterExecution)}`);
  }

  console.log(`bullmq ops smoke ok: completed=${taskQueueAfterExecution.completed}`);
} finally {
  if (!server.killed) {
    server.kill();
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await cleanupQueue().catch(() => undefined);
  rmSync(dataFile, { force: true });
  if (redisContainerName) {
    await run('docker', ['stop', redisContainerName]).catch(() => undefined);
  }
}
