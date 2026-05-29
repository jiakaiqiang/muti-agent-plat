import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
let redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379/0';
const prefix = `agent-cluster-smoke-${Date.now()}`;
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

async function api(apiBase, path) {
  const response = await fetch(`${apiBase}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function seedQueue() {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue('agent-task-queue', { connection, prefix });
  try {
    await queue.drain(true);
    await queue.add('ops-smoke', { source: 'bullmq-ops-smoke' }, { jobId: `ops-smoke-${Date.now()}` });
  } finally {
    await queue.close();
    await connection.quit();
  }
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
await seedQueue();
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
  if (taskQueue.waiting < 1) {
    throw new Error(`Seeded BullMQ job was not observed: ${JSON.stringify(taskQueue)}`);
  }

  console.log(`bullmq ops smoke ok: waiting=${taskQueue.waiting}`);
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
  if (redisContainerName) {
    await run('docker', ['stop', redisContainerName]).catch(() => undefined);
  }
}
