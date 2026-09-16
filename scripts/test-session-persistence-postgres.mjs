import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';

// Always create a disposable database. Never run integration fixtures against
// the application database, even when DATABASE_URL is inherited by this process.
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) throw new Error('Unknown argument. Supported option: --check');
const checkOnly = args.includes('--check');
const environment = !process.env.DATABASE_URL && existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const configured = process.env.DATABASE_URL ?? environment.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m)?.[1];
if (!configured) throw new Error('DATABASE_URL is required (credentials are never printed).');
let adminUrl;
try {
  adminUrl = new URL(configured.trim());
} catch {
  throw new Error('DATABASE_URL is invalid (credentials are never printed).');
}
if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol)) {
  throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
}
adminUrl.pathname = '/postgres';
const name = `agent_cluster_sdd_test_${process.pid}_${Date.now()}`;
if (!/^agent_cluster_sdd_test_\d+_\d+$/.test(name)) throw new Error('Unsafe test database name');
const integrationFile = 'apps/server/src/modules/persistence/relational/postgres-migration-runner.integration.spec.ts';
if (!existsSync(integrationFile)) throw new Error('PostgreSQL integration test file is missing.');
if (checkOnly) {
  console.log(JSON.stringify({ result: 'ready', createsDisposableDatabase: true, databaseNamePrefix: 'agent_cluster_sdd_test_', integrationFile }));
  process.exit(0);
}
const pool = new Pool({ connectionString: adminUrl.toString() });
let created = false;
try {
  await pool.query(`create database "${name}"`);
  created = true;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;
  console.log(`Isolated PostgreSQL fixture: ${name}`);
  const child = spawn(process.execPath, [
    'node_modules/tsx/dist/cli.mjs', '--tsconfig', 'apps/server/tsconfig.json', '--test',
    integrationFile
  ], { stdio: 'inherit', env: { ...process.env, RELATIONAL_TEST_DATABASE_URL: testUrl.toString() } });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} catch (error) {
  // pg error details may contain connection parameters; expose only SQLSTATE.
  console.error(`Isolated PostgreSQL validation failed (${error.code ?? 'runner error'}).`);
  process.exitCode = 1;
} finally {
  try {
    if (created) {
      await pool.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()',
        [name]
      );
      await pool.query(`drop database "${name}"`);
      console.log(`Removed disposable database: ${name}`);
    }
  } catch (error) {
    console.error(`Disposable PostgreSQL cleanup failed (${error.code ?? 'runner error'}).`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
