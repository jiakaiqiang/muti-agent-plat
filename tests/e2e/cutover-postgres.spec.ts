import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Client } from 'pg';

const root = resolve(import.meta.dirname, '..', '..');
const command = resolve(root, 'scripts/cutover-context-v2.mjs');
const tableName = `agent_cluster_cutover_${Date.now()}`;
let databaseUrl = process.env.CUTOVER_TEST_DATABASE_URL ?? 'postgresql://agent_cluster:agent_cluster_dev@localhost:5432/agent_cluster';
let containerName: string | undefined;

async function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('no port')));
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

async function ensurePostgres() {
  if (await canConnect()) return;
  const port = await freePort();
  containerName = `agent-cluster-cutover-test-${Date.now()}`;
  const child = spawn('docker', [
    'run', '-d', '--rm', '--name', containerName,
    '-e', 'POSTGRES_DB=agent_cluster',
    '-e', 'POSTGRES_USER=agent_cluster',
    '-e', 'POSTGRES_PASSWORD=agent_cluster_dev',
    '-p', `${port}:5432`, 'pgvector/pgvector:pg16'
  ], { cwd: root, stdio: 'ignore' });
  await new Promise<void>((resolveStart, reject) => {
    child.once('exit', (code) => code === 0 ? resolveStart() : reject(new Error(`docker run exited ${code}`)));
    child.once('error', reject);
  });
  databaseUrl = `postgresql://agent_cluster:agent_cluster_dev@localhost:${port}/agent_cluster`;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await canConnect()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error('PostgreSQL test container did not become ready');
}

async function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try { return (await client.query<T>(sql, params)).rows; } finally { await client.end(); }
}

function run(args: string[], overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, [command, ...args], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      AGENT_CLUSTER_PERSISTENCE: 'true',
      AGENT_CLUSTER_PERSISTENCE_BACKEND: 'postgres',
      AGENT_CLUSTER_POSTGRES_COLLECTION_TABLE: tableName,
      AGENT_CLUSTER_DATA_DIR: resolve(root, '.cache', 'cutover-postgres-test'),
      AGENT_CLUSTER_CUTOVER_ARCHIVE_DIR: resolve(root, '.cache', 'cutover-postgres-archive'),
      AGENT_CLUSTER_CUTOVER_ARCHIVE_KEY: 'postgres-e2e-archive-key-with-entropy',
      AGENT_CLUSTER_CUTOVER_ENVIRONMENT: 'postgres-e2e',
      AGENT_CLUSTER_CUTOVER_TOKEN_SECRET: 'postgres-e2e-secret-with-entropy',
      AGENT_CLUSTER_CUTOVER_OPERATOR: 'postgres-e2e-operator',
      AGENT_CLUSTER_CUTOVER_QUIESCED: 'true',
      AGENT_CLUSTER_COMMIT: 'postgres-e2e-commit',
      ...overrides
    },
    encoding: 'utf8'
  });
}

function dryRun() {
  const result = run(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as {
    confirmToken: string;
    backend: string;
    collections: Array<{ key: string; itemCount: number }>;
  };
}

before(async () => {
  await ensurePostgres();
  await query(`create table if not exists ${tableName} (key text primary key, value jsonb not null, updated_at timestamptz not null default now())`);
});

beforeEach(async () => {
  await query(`truncate table ${tableName}`);
  await query(`insert into ${tableName} (key, value) values ($1, $2::jsonb), ($3, $4::jsonb)`, [
    'sessions', JSON.stringify([{ id: 'old-session', title: 'private title' }]),
    'eventsBySession', JSON.stringify({ 'old-session': [{ content: 'private event' }] })
  ]);
});

after(async () => {
  await query(`drop table if exists ${tableName}`).catch(() => undefined);
  if (containerName) spawnSync('docker', ['stop', containerName], { stdio: 'ignore' });
  rmSync(resolve(root, '.cache', 'cutover-postgres-archive'), { recursive: true, force: true });
});

test('PostgreSQL dry-run identifies the isolated backend and collection counts', () => {
  const report = dryRun();
  assert.equal(report.backend, 'postgres');
  assert.deepEqual(report.collections, [
    { key: 'eventsBySession', itemCount: 1 },
    { key: 'sessions', itemCount: 1 }
  ]);
});

test('PostgreSQL dry-run performs zero writes', async () => {
  const beforeRows = await query(`select key, value from ${tableName} order by key`);
  dryRun();
  const afterRows = await query(`select key, value from ${tableName} order by key`);
  assert.deepEqual(afterRows, beforeRows);
});

test('PostgreSQL apply requires maintenance mode', () => {
  const token = dryRun().confirmToken;
  const result = run(['--apply', '--confirm', token], { AGENT_CLUSTER_MAINTENANCE_MODE: 'false' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CUTOVER_MAINTENANCE_REQUIRED/);
});

test('PostgreSQL apply rejects a token bound to another environment', () => {
  const token = dryRun().confirmToken;
  const result = run(['--apply', '--confirm', token, '--environment', 'other'], { AGENT_CLUSTER_MAINTENANCE_MODE: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CUTOVER_ENVIRONMENT_MISMATCH/);
});

test('PostgreSQL apply rejects a stale table revision', async () => {
  const token = dryRun().confirmToken;
  await query(`update ${tableName} set value = $2::jsonb where key = $1`, ['sessions', JSON.stringify([{ id: 'newer' }])]);
  const result = run(['--apply', '--confirm', token], { AGENT_CLUSTER_MAINTENANCE_MODE: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CUTOVER_STALE_DRY_RUN/);
});

test('PostgreSQL apply succeeds in one isolated transaction', () => {
  const token = dryRun().confirmToken;
  const result = run(['--apply', '--confirm', token], { AGENT_CLUSTER_MAINTENANCE_MODE: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).status, 'applied');
});

test('PostgreSQL apply removes all old business data and writes v2 seeds', async () => {
  const token = dryRun().confirmToken;
  const result = run(['--apply', '--confirm', token], { AGENT_CLUSTER_MAINTENANCE_MODE: 'true' });
  assert.equal(result.status, 0, result.stderr);
  const rows = await query<{ key: string; value: unknown }>(`select key, value from ${tableName} order by key`);
  const state = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.deepEqual(state.sessions, []);
  assert.equal(JSON.stringify(state).includes('old-session'), false);
  assert.equal(Array.isArray(state.agents), true);
});

test('PostgreSQL apply persists schema-v3 metadata and one minimal audit', async () => {
  const token = dryRun().confirmToken;
  const result = run(['--apply', '--confirm', token], { AGENT_CLUSTER_MAINTENANCE_MODE: 'true' });
  assert.equal(result.status, 0, result.stderr);
  const rows = await query<{ key: string; value: unknown }>(
    `select key, value from ${tableName} where key in ('systemDataMetadata', 'cutoverAudits') order by key`
  );
  const state = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal((state.systemDataMetadata as { pipelineVersion: string }).pipelineVersion, 'v2');
  assert.equal((state.cutoverAudits as unknown[]).length, 1);
  assert.doesNotMatch(JSON.stringify(state.cutoverAudits), /private title|private event/);
});

test('PostgreSQL apply is idempotent for the same confirm token', () => {
  const token = dryRun().confirmToken;
  const first = run(['--apply', '--confirm', token], { AGENT_CLUSTER_MAINTENANCE_MODE: 'true' });
  const second = run(['--apply', '--confirm', token], { AGENT_CLUSTER_MAINTENANCE_MODE: 'true' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout.trim()).status, 'already_applied');
});
