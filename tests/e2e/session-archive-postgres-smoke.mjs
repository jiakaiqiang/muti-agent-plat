import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const root = fileURLToPath(new URL('../..', import.meta.url));
const npmCli = process.env.npm_execpath;
const tableName = `agent_cluster_session_archive_smoke_${Date.now()}`;
const suppliedDatabaseUrl = process.env.RELATIONAL_TEST_DATABASE_URL?.trim();
let databaseUrl = suppliedDatabaseUrl ?? 'postgresql://agent_cluster:agent_cluster_dev@localhost:5432/agent_cluster';
let postgresContainerName;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.stdio ?? 'inherit',
      env: { ...process.env, ...(options.env ?? {}) }
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)));
  });
}

function runNpm(args) {
  if (!npmCli) throw new Error('npm_execpath is required; run this script through npm.');
  return run(process.execPath, [npmCli, ...args]);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => typeof address === 'object' && address?.port ? resolve(String(address.port)) : reject(new Error('Could not allocate a free port')));
    });
  });
}

async function canConnect() {
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
    if (await canConnect()) return;
    try {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      await client.end();
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw lastError ?? new Error('PostgreSQL did not become ready');
}

async function ensurePostgres() {
  if (suppliedDatabaseUrl) {
    if (process.env.DATABASE_URL?.trim() === suppliedDatabaseUrl) {
      throw new Error('RELATIONAL_TEST_DATABASE_URL must be an isolated test database and must not equal DATABASE_URL.');
    }
    if (!(await canConnect())) {
      throw new Error('RELATIONAL_TEST_DATABASE_URL is configured but PostgreSQL is unreachable; refusing to use another database.');
    }
    return;
  }
  const port = await findFreePort();
  postgresContainerName = `agent-cluster-session-archive-${Date.now()}`;
  await run('docker', [
    'run', '-d', '--rm', '--name', postgresContainerName,
    '-e', 'POSTGRES_DB=agent_cluster',
    '-e', 'POSTGRES_USER=agent_cluster',
    '-e', 'POSTGRES_PASSWORD=agent_cluster_dev',
    '-p', `${port}:5432`, 'pgvector/pgvector:pg16'
  ]);
  databaseUrl = `postgresql://agent_cluster:agent_cluster_dev@localhost:${port}/agent_cluster`;
  await waitForPostgres();
}

async function waitForServer(apiBase) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${apiBase}/health`)).ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
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
      AGENT_CLUSTER_SEED_DEFAULT_AGENTS: 'true',
      DATABASE_URL: databaseUrl,
      RELATIONAL_TEST_DATABASE_URL: databaseUrl,
      NODE_ENV: 'test',
      PHASE_6_POLICY_ADMISSION_BYPASS: 'isolated_test_only',
      LLM_DRY_RUN: 'true',
      LLM_MOCK_FALLBACK: 'true',
      MOCK_RUNTIME_ENABLED: 'true',
      INTENT_ROUTING_MODE: 'disabled'
    }
  });
  server.stdout.on('data', chunk => process.stdout.write(chunk));
  server.stderr.on('data', chunk => process.stderr.write(chunk));
  await waitForServer(apiBase);
  return { apiBase, server };
}

async function stopServer(handle) {
  if (!handle) return;
  if (process.platform === 'win32' && handle.server.pid) {
    await run('taskkill', ['/pid', String(handle.server.pid), '/T', '/F'], { stdio: 'ignore' }).catch(() => undefined);
  } else if (!handle.server.killed) {
    handle.server.kill();
  }
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 2_000);
    handle.server.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function api(apiBase, path, init) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function assertDatabaseRecord(sessionId, archived) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `select metadata->'sourceRecord'->>'archivedAt' as archived_at
         from agent_cluster.sessions where external_id=$1`,
      [sessionId]
    );
    assert.equal(result.rows.length, 1);
    assert.equal(Boolean(result.rows[0].archived_at), archived);
  } finally {
    await client.end();
  }
}

async function dropSmokeTable() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`drop table if exists public.${tableName}`);
    await client.query(`drop table if exists agent_cluster.${tableName}`);
  } finally {
    await client.end();
  }
}

await ensurePostgres();
await runNpm(['run', 'build', '-w', '@agent-cluster/shared']);
await runNpm(['run', 'build', '-w', '@agent-cluster/server']);

let first;
let second;
try {
  await dropSmokeTable();
  first = await startServer();
  const created = await api(first.apiBase, '/sessions', {
    method: 'POST',
    body: JSON.stringify({ input: 'PostgreSQL session archive smoke', projectId: 'project-archive-smoke' })
  });
  const sessionId = created.data.session.id;

  const archived = await api(first.apiBase, `/sessions/${sessionId}/archive`, {
    method: 'POST', headers: { 'Idempotency-Key': 'archive-postgres-smoke' }
  });
  assert.equal(archived.data.archived, true);
  assert.equal((await api(first.apiBase, '/sessions?visibility=active')).data.items.some(item => item.id === sessionId), false);
  const groups = (await api(first.apiBase, '/sessions/archives')).data.groups;
  assert.equal(groups.some(group => group.projectKey === 'project-archive-smoke' && group.items.some(item => item.id === sessionId)), true);
  await assertDatabaseRecord(sessionId, true);

  await stopServer(first);
  first = undefined;
  second = await startServer();
  const restoredAfterRestart = (await api(second.apiBase, '/sessions/archives')).data.groups;
  assert.equal(restoredAfterRestart.some(group => group.items.some(item => item.id === sessionId)), true);

  const restored = await api(second.apiBase, `/sessions/${sessionId}/archive/restore`, {
    method: 'POST', headers: { 'Idempotency-Key': 'restore-postgres-smoke' }
  });
  assert.equal(restored.data.restored, true);
  assert.equal(restored.data.session.status, 'PAUSED');
  assert.equal((await api(second.apiBase, '/sessions?visibility=active')).data.items.some(item => item.id === sessionId), true);
  await assertDatabaseRecord(sessionId, false);

  console.log(JSON.stringify({ result: 'pass', sessionId, checks: ['archive', 'project grouping', 'postgres restart recovery', 'restore', 'archivedAt persistence'] }));
} finally {
  await stopServer(first).catch(() => undefined);
  await stopServer(second).catch(() => undefined);
  await dropSmokeTable().catch(() => undefined);
  if (postgresContainerName) await run('docker', ['stop', postgresContainerName], { stdio: 'ignore' }).catch(() => undefined);
}
