import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve('docs/quality/intent-recognition-correction-runs/2026-10-19-sdd-development');
const prefix = process.env.INTENT_POSTGRES_EVIDENCE_PREFIX ?? 'postgres-intent-repro';
assert.match(prefix, /^[a-z0-9-]+$/);
const label = 'intent-sdd-postgres', name = `${label}-${randomUUID()}`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
const image = JSON.parse(docker(['image', 'inspect', 'postgres:16-alpine']))[0];
const report = { executedAt: new Date().toISOString(), imageId: image.Id, imageDigests: image.RepoDigests,
  scope: 'isolated local PostgreSQL container, independent database connections, service fixtures; no production connection or real-model accuracy claim',
  tests: ['intent-correction.integration.spec.ts', 'intent-semantic-transactions.integration.spec.ts', 'postgres-migration-runner.integration.spec.ts'],
  exitCode: null, cleanupConfirmed: false };
let container;
try {
  container = docker(['run', '--detach', '--name', name, '--label', `codex.task=${label}`, '--publish', '127.0.0.1::5432',
    '--env', 'POSTGRES_USER=intent_test', '--env', 'POSTGRES_PASSWORD=isolated-fixture-only', '--env', 'POSTGRES_DB=intent_sdd', image.Id]);
  const binding = docker(['port', container, '5432/tcp']); assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const deadline = Date.now() + 20000;
  for (;;) {
    // The image briefly starts a Unix-socket-only init server, then stops it.
    // Wait for the final TCP listener rather than mistaking init for readiness.
    const ready = spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'intent_test', '-d', 'intent_sdd'], { timeout: 5000 });
    if (ready.status === 0) break;
    assert.ok(Date.now() < deadline, 'PostgreSQL readiness deadline exceeded');
    await new Promise(done => setTimeout(done, 200));
  }
  report.serverVersion = docker(['exec', container, 'psql', '-U', 'intent_test', '-d', 'intent_sdd', '-Atc', 'show server_version;']);
  const test = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), '--test', '--test-concurrency=1', '--tsconfig', 'apps/server/tsconfig.json',
    ...report.tests.map(file => `apps/server/src/modules/persistence/relational/${file}`)],
  { encoding: 'utf8', timeout: 180000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env,
    RELATIONAL_TEST_DATABASE_URL: `postgresql://intent_test:isolated-fixture-only@${binding}/intent_sdd` } });
  const log = `${test.stdout ?? ''}${test.stderr ?? ''}`;
  writeFileSync(resolve(directory, `${prefix}.log`), log);
  report.exitCode = test.status;
  if (test.error) throw test.error;
  assert.equal(test.status, 0, 'PostgreSQL tests failed; see evidence log');
  assert.match(log, /^# pass 36$/m); assert.match(log, /^# skipped 0$/m); assert.match(log, /^# fail 0$/m);
  report.migrations = docker(['exec', container, 'psql', '-U', 'intent_test', '-d', 'intent_sdd', '-Atc', 'select count(*) from agent_cluster.schema_migrations;']);
  report.fixtureTriggersRemaining = docker(['exec', container, 'psql', '-U', 'intent_test', '-d', 'intent_sdd', '-Atc',
    "select count(*) from pg_trigger where tgname in ('intent_fixture_receipt','intent_fixture_version','intent_fixture_report','intent_fixture_retry','intent_fixture_answer','intent_fixture_brief','intent_fixture_brief_confirm');"]);
  assert.equal(report.fixtureTriggersRemaining, '0');
} finally {
  if (container) {
    const inspected = JSON.parse(docker(['inspect', container]))[0];
    assert.equal(inspected.Id, container); assert.equal(inspected.Config.Labels['codex.task'], label); assert.equal(inspected.Name, `/${name}`);
    docker(['rm', '--force', '--volumes', container]);
    report.cleanupConfirmed = docker(['ps', '-aq', '--filter', `id=${container}`]) === '';
  }
  writeFileSync(resolve(directory, `${prefix}.json`), JSON.stringify(report, null, 2));
}
assert.equal(report.cleanupConfirmed, true);
console.log(JSON.stringify(report));
