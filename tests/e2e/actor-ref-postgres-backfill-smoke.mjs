import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { runPostgresBackfill } from '../../scripts/backfill-actor-ref.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
let databaseUrl = process.env.DATABASE_URL;
const tableName = `agent_cluster_actor_ref_acceptance_${Date.now()}`;
let postgresContainerName;

const originalEvents = {
  session_a: [
    { id: 'event-user', type: 'user_message' },
    { id: 'event-agent', type: 'runtime_progress', fromAgentId: 'backend' },
    { id: 'event-system', type: 'session_status_changed' },
    { id: 'event-existing', type: 'runtime_progress', fromAgentId: 'review', actor: { type: 'agent', id: 'preserved' } }
  ]
};
const originalTasks = {
  session_a: [
    { id: 'task-legacy', assigneeAgentId: 'backend', assignedByAgentId: 'coordinator' },
    {
      id: 'task-existing',
      assigneeAgentId: 'test',
      assignedByAgentId: 'coordinator',
      assignee: { type: 'agent', id: 'preserved-assignee' },
      assignedBy: { type: 'agent', id: 'preserved-assigner' }
    }
  ]
};

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address?.port) resolve(String(address.port));
        else reject(new Error('Could not allocate a free port'));
      });
    });
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
    child.once('error', reject);
  });
}

async function canConnect() {
  if (!databaseUrl) return false;
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000 });
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
    lastError = new Error('PostgreSQL is not ready yet');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError;
}

async function ensurePostgres() {
  if (await canConnect()) return;
  const port = await findFreePort();
  postgresContainerName = `agent-cluster-actor-ref-acceptance-${Date.now()}`;
  await run('docker', [
    'run', '-d', '--rm', '--name', postgresContainerName,
    '-e', 'POSTGRES_DB=agent_cluster',
    '-e', 'POSTGRES_USER=agent_cluster',
    '-e', 'POSTGRES_PASSWORD=agent_cluster_dev',
    '-p', `${port}:5432`,
    'postgres:16-alpine'
  ]);
  databaseUrl = `postgresql://agent_cluster:agent_cluster_dev@localhost:${port}/agent_cluster`;
  await waitForPostgres();
}

async function withClient(callback) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function readCollections(client) {
  const result = await client.query(`select key, value from ${tableName} order by key`);
  return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
}

await ensurePostgres();

try {
  await withClient(async (client) => {
    await client.query(`create table ${tableName} (
      key text primary key,
      value jsonb not null,
      updated_at timestamptz not null default now()
    )`);
    await client.query(
      `insert into ${tableName} (key, value) values ($1, $2::jsonb), ($3, $4::jsonb)`,
      ['eventsBySession', JSON.stringify(originalEvents), 'tasksBySession', JSON.stringify(originalTasks)]
    );
  });

  const dryRun = await runPostgresBackfill({ apply: false, databaseUrl, tableName });
  assert.deepEqual(dryRun.events, { scanned: 4, skipped: 1, filled: 3 });
  assert.deepEqual(dryRun.tasks, { scanned: 2, skipped: 1, filled: 1 });
  await withClient(async (client) => {
    assert.deepEqual(await readCollections(client), {
      eventsBySession: originalEvents,
      tasksBySession: originalTasks
    });
  });

  const applied = await runPostgresBackfill({ apply: true, databaseUrl, tableName });
  assert.match(applied.backupTable, new RegExp(`^${tableName}_actor_ref_backup_\\d{14}$`));
  await withClient(async (client) => {
    const values = await readCollections(client);
    const events = values.eventsBySession.session_a;
    const tasks = values.tasksBySession.session_a;
    assert.deepEqual(events[0].actor, { type: 'user', id: 'system' });
    assert.deepEqual(events[1].actor, { type: 'agent', id: 'backend' });
    assert.deepEqual(events[2].actor, { type: 'system', id: 'system' });
    assert.deepEqual(events[3].actor, { type: 'agent', id: 'preserved' });
    assert.deepEqual(tasks[0].assignee, { type: 'agent', id: 'backend' });
    assert.deepEqual(tasks[0].assignedBy, { type: 'agent', id: 'coordinator' });
    assert.deepEqual(tasks[1].assignee, { type: 'agent', id: 'preserved-assignee' });
    assert.deepEqual(tasks[1].assignedBy, { type: 'agent', id: 'preserved-assigner' });

    const backup = await client.query(`select key, value from ${applied.backupTable} order by key`);
    assert.deepEqual(Object.fromEntries(backup.rows.map((row) => [row.key, row.value])), {
      eventsBySession: originalEvents,
      tasksBySession: originalTasks
    });
  });

  const idempotency = await runPostgresBackfill({ apply: false, databaseUrl, tableName });
  assert.equal(idempotency.events.filled, 0);
  assert.equal(idempotency.tasks.filled, 0);

  await withClient(async (client) => {
    await client.query(`update ${tableName} as current
      set value = backup.value, updated_at = backup.updated_at
      from ${applied.backupTable} as backup
      where current.key = backup.key`);
    assert.deepEqual(await readCollections(client), {
      eventsBySession: originalEvents,
      tasksBySession: originalTasks
    });
  });

  console.log(`actor-ref PostgreSQL acceptance ok: table=${tableName}, backup=${applied.backupTable}`);
} finally {
  await withClient(async (client) => {
    const backups = await client.query(
      `select tablename from pg_tables where schemaname = current_schema() and tablename like $1`,
      [`${tableName}_actor_ref_backup_%`]
    );
    for (const row of backups.rows) await client.query(`drop table if exists ${row.tablename}`);
    await client.query(`drop table if exists ${tableName}`);
  }).catch(() => undefined);
  if (postgresContainerName) await run('docker', ['stop', postgresContainerName]).catch(() => undefined);
}
