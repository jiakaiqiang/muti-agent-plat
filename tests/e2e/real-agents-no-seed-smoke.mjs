import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
let databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://agent_cluster:agent_cluster_dev@localhost:5432/agent_cluster';
const tableName = `agent_cluster_agents_no_seed_${Date.now()}`;
let postgresContainerName;

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

async function canConnectToPostgres() {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function waitForPostgres() {
  const deadline = Date.now() + 30_000;
  let lastError;

  while (Date.now() < deadline) {
    if (await canConnectToPostgres()) {
      return;
    }
    lastError = new Error('PostgreSQL is not ready');
    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  throw lastError ?? new Error('PostgreSQL did not become ready');
}

async function ensurePostgres() {
  if (await canConnectToPostgres()) {
    return;
  }

  const port = await findFreePort();
  postgresContainerName = `agent-cluster-agents-no-seed-${Date.now()}`;
  await run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    postgresContainerName,
    '-e',
    'POSTGRES_DB=agent_cluster',
    '-e',
    'POSTGRES_USER=agent_cluster',
    '-e',
    'POSTGRES_PASSWORD=agent_cluster_dev',
    '-p',
    `${port}:5432`,
    'pgvector/pgvector:pg16'
  ]);
  databaseUrl = `postgresql://agent_cluster:agent_cluster_dev@localhost:${port}/agent_cluster`;
  await waitForPostgres();
}

async function dropSmokeTable() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`drop table if exists ${tableName}`);
  } finally {
    await client.end();
  }
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

await ensurePostgres();
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
    AGENT_CLUSTER_PERSISTENCE: 'true',
    AGENT_CLUSTER_PERSISTENCE_BACKEND: 'postgres',
    AGENT_CLUSTER_POSTGRES_COLLECTION_TABLE: tableName,
    AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'false',
    DATABASE_URL: databaseUrl,
    DEFAULT_AGENT_RUNTIME_TYPE: 'generic_llm',
    LLM_DRY_RUN: 'false',
    LLM_MOCK_FALLBACK: 'false',
    MOCK_RUNTIME_ENABLED: 'false'
  }
});

server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

try {
  await dropSmokeTable();
  await waitForServer(apiBase);
  const response = await fetch(`${apiBase}/agents`);
  if (!response.ok) {
    throw new Error(`GET /agents failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  if (!Array.isArray(body.data)) {
    throw new Error(`Agent response should be an array: ${JSON.stringify(body)}`);
  }
  if (body.data.length !== 0) {
    throw new Error(`Real mode should not auto-seed default agents: ${JSON.stringify(body.data)}`);
  }

  console.log('real agents no-seed smoke ok');
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
  await dropSmokeTable().catch(() => undefined);
  if (postgresContainerName) {
    await run('docker', ['stop', postgresContainerName]).catch(() => undefined);
  }
}
