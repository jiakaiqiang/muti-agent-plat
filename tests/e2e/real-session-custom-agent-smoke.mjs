import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
let databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://agent_cluster:agent_cluster_dev@localhost:5432/agent_cluster';
const tableName = `agent_cluster_custom_session_${Date.now()}`;
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
      env: { ...process.env, ...(options.env ?? {}) }
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
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
  while (Date.now() < deadline) {
    if (await canConnectToPostgres()) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error('PostgreSQL did not become ready');
}

async function ensurePostgres() {
  if (await canConnectToPostgres()) return;
  const port = await findFreePort();
  postgresContainerName = `agent-cluster-custom-session-${Date.now()}`;
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
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error('Server did not become ready');
}

async function startServer() {
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
      DEFAULT_AGENT_RUNTIME_TYPE: 'mock',
      LLM_DRY_RUN: 'true',
      LLM_MOCK_FALLBACK: 'true',
      MOCK_RUNTIME_ENABLED: 'true'
    }
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await waitForServer(apiBase);
  return { apiBase, server };
}

async function stopServer(server) {
  if (!server.killed) server.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function api(apiBase, path, init) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

await ensurePostgres();
await runNpm(['run', 'build', '-w', '@agent-cluster/shared']);
await runNpm(['run', 'build', '-w', '@agent-cluster/server']);

let serverHandle;
try {
  await dropSmokeTable();
  serverHandle = await startServer();
  const createdAgent = await api(serverHandle.apiBase, '/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Custom Planner',
      role: 'Plans and coordinates user tasks.',
      capabilityIds: ['cap-brief', 'cap-dry-run'],
      tags: ['planner']
    })
  });

  const createdSession = await api(serverHandle.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      input: 'Create a plan with a custom real Agent.',
      agentIds: [createdAgent.data.id],
      tokenBudget: 30000
    })
  });

  const session = createdSession.data.session;
  if (!session.participatingAgentIds.includes(createdAgent.data.id)) {
    throw new Error(`Session did not use selected real Agent: ${JSON.stringify(session)}`);
  }
  if (session.status === 'FAILED') {
    const events = await api(serverHandle.apiBase, `/sessions/${session.id}/events`);
    throw new Error(`Custom Agent session should not fail: ${JSON.stringify(events.data.items)}`);
  }

  const events = await api(serverHandle.apiBase, `/sessions/${session.id}/events`);
  if (!events.data.items.some((event) => event.type === 'brief_created')) {
    throw new Error(`Custom Agent session should create a brief: ${JSON.stringify(events.data.items)}`);
  }

  console.log(`real custom-agent session smoke ok: ${session.id}`);
} finally {
  if (serverHandle) await stopServer(serverHandle.server);
  await dropSmokeTable().catch(() => undefined);
  if (postgresContainerName) {
    await run('docker', ['stop', postgresContainerName]).catch(() => undefined);
  }
}
