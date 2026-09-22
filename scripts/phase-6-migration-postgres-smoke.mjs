import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSmokeV2State } from '../tests/e2e/smoke-server.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidencePath = resolve(root, '.cache/agent-cluster/phase-6/postgres-migration-evidence.json');
const baseUrl = process.env.RELATIONAL_TEST_DATABASE_URL?.trim();
if (!baseUrl) {
  console.error('RELATIONAL_TEST_DATABASE_URL is required; refusing to use DATABASE_URL.');
  process.exitCode = 2;
} else {
  const databaseName = `agent_cluster_phase6_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const parsed = new URL(baseUrl);
  parsed.pathname = '/postgres';
  const admin = new Pool({ connectionString: parsed.toString() });
  const target = new URL(baseUrl);
  target.pathname = `/${databaseName}`;
  const directory = await mkdtemp(join(tmpdir(), 'agent-cluster-phase6-migration-'));
  const source1 = join(directory, 'source-1.json');
  const source2 = join(directory, 'source-2.json');
  const rollback = join(directory, 'rollback.json');
  const cli = resolve(root, 'apps/server/src/modules/persistence/relational/relational-migration.cli.ts');
  let evidence;

  const run = (args) => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolveRun({ code, stdout, stderr }));
  });

  const state1 = createSmokeV2State();
  const state2 = structuredClone(state1);
  state2.cutoverAudits.push({
    id: randomUUID(),
    appliedAt: new Date().toISOString(),
    environment: 'phase-6-rollback-smoke',
    result: 'applied',
    dataEpoch: state1.systemDataMetadata.dataEpoch
  });
  try {
    await writeFile(source1, `${JSON.stringify(state1, null, 2)}\n`, 'utf8');
    await writeFile(source2, `${JSON.stringify(state2, null, 2)}\n`, 'utf8');
    await admin.query(`create database "${databaseName}"`);
    const db = target.toString();
    const apply1 = await run(['apply', '--database-url', db, '--source', source1, '--confirm']);
    assert.equal(apply1.code, 0, apply1.stderr || apply1.stdout);
    const verify1 = await run(['verify', '--database-url', db, '--source', source1]);
    assert.equal(verify1.code, 0, verify1.stderr || verify1.stdout);
    const apply2 = await run(['apply', '--database-url', db, '--source', source2, '--confirm', '--allow-non-empty', '--output', rollback]);
    assert.equal(apply2.code, 0, apply2.stderr || apply2.stdout);
    const rollbackText = await readFile(rollback, 'utf8');
    const rollbackState = JSON.parse(rollbackText);
    assert.equal(rollbackState.cutoverAudits?.length, 1);
    const verify2 = await run(['verify', '--database-url', db, '--source', source2]);
    assert.equal(verify2.code, 0, verify2.stderr || verify2.stdout);
    const rollbackApply = await run(['apply', '--database-url', db, '--source', rollback, '--confirm', '--allow-non-empty', '--output', join(directory, 'rollback-2.json')]);
    assert.equal(rollbackApply.code, 0, rollbackApply.stderr || rollbackApply.stdout);
    const rollbackVerify = await run(['verify', '--database-url', db, '--source', rollback]);
    assert.equal(rollbackVerify.code, 0, rollbackVerify.stderr || rollbackVerify.stdout);
    evidence = {
      schemaVersion: 'phase-6-postgres-migration-evidence-v1',
      result: 'passed',
      executedAt: new Date().toISOString(),
      database: 'temporary database created from explicit RELATIONAL_TEST_DATABASE_URL and removed after test',
      apply: 'empty target applied and verified',
      nonEmptyApply: 'rollback export created, hashed, applied, and verified',
      rollback: 'export reapplied and verified',
      filePostgresEquivalence: 'source fixture and relational projection verified with zero mismatched collections',
      fixtureHashes: {
        source1: hash(JSON.stringify(state1)),
        source2: hash(JSON.stringify(state2)),
        rollback: hash(rollbackText)
      }
    };
  } finally {
    try {
      await admin.query(`drop database if exists "${databaseName}"`);
    } finally {
      await admin.end().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (evidence) {
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
  }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
