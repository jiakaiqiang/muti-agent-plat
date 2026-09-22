import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const databaseUrl = process.env.RELATIONAL_TEST_DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error('RELATIONAL_TEST_DATABASE_URL is required; refusing to use DATABASE_URL for the phase 6 backend parity gate.');
  process.exitCode = 2;
} else {
  const databaseName = `agent_cluster_phase6_parity_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  const targetUrl = new URL(databaseUrl);
  targetUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const steps = [
    {
      id: 'file-fault-matrix',
      args: ['--import', 'tsx', 'scripts/phase-6-fault-matrix.mjs']
    },
    {
      id: 'postgres-concurrency-and-recovery',
      args: ['scripts/phase-6-postgres-smoke.mjs']
    },
    {
      id: 'postgres-migration-rollback-equivalence',
      args: ['scripts/phase-6-migration-postgres-smoke.mjs']
    }
  ];

  const results = [];
  try {
    await admin.query(`create database "${databaseName}"`);
    for (const step of steps) {
      const result = await run(step.args, step.id === 'postgres-concurrency-and-recovery'
        ? targetUrl.toString()
        : databaseUrl);
      results.push({ id: step.id, status: result.code === 0 ? 'passed' : 'failed' });
      if (result.code !== 0) {
        console.error(JSON.stringify({ backend: 'file+postgres', results }, null, 2));
        process.exitCode = result.code ?? 1;
        break;
      }
    }
  } finally {
    await admin.query(`drop database if exists "${databaseName}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }

  if (results.length === steps.length && results.every((item) => item.status === 'passed')) {
    console.log(JSON.stringify({
      backend: 'file+postgres',
      results,
      equivalence: 'file fault matrix + isolated PostgreSQL concurrency/recovery + migration rollback verified'
    }, null, 2));
  }
}

function run(args, relationalDatabaseUrl) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, RELATIONAL_TEST_DATABASE_URL: relationalDatabaseUrl },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolveRun({ code: 1, stderr: String(error) }));
    child.once('exit', (code, signal) => {
      if (code !== 0 && stderr.trim()) console.error(stderr.trim());
      resolveRun({ code: signal ? 1 : code ?? 1 });
    });
  });
}
