import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSmokeV2State } from '../tests/e2e/smoke-server.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = resolve(root, 'apps/server/src/modules/persistence/relational/relational-migration.cli.ts');

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolveRun({ code, stdout, stderr }));
  });
}

const directory = await mkdtemp(join(tmpdir(), 'agent-cluster-phase6-'));
const sourcePath = join(directory, 'state.v3.json');
try {
  await writeFile(sourcePath, `${JSON.stringify(createSmokeV2State(), null, 2)}\n`, 'utf8');
  const dryRun = await run(['dry-run', '--source', sourcePath]);
  assert.equal(dryRun.code, 0, dryRun.stderr || dryRun.stdout);
  const inventory = JSON.parse(dryRun.stdout.trim());
  assert.equal(inventory.result, 'ok');
  assert.equal(inventory.command, 'dry-run');

  const applyWithoutConfirmation = await run(['apply', '--source', sourcePath]);
  assert.notEqual(applyWithoutConfirmation.code, 0);
  assert.match(`${applyWithoutConfirmation.stdout}${applyWithoutConfirmation.stderr}`, /DATABASE_MIGRATION|MIGRATION_DATABASE_URL_REQUIRED|MIGRATION_CONFIRM_REQUIRED/);

  console.log(JSON.stringify({
    sourcePath,
    dryRun: { status: 'passed', inventory },
    applyGuard: { status: 'passed', detail: 'apply is not entered without explicit database/confirmation; no database was touched' },
    postgres: 'not executed: isolated RELATIONAL_TEST_DATABASE_URL not configured',
    publish: 'not executed: release authorization required'
  }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
