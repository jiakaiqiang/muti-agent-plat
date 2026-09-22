import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const databaseUrl = process.env.RELATIONAL_TEST_DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error('RELATIONAL_TEST_DATABASE_URL is required for the isolated phase 6 PostgreSQL smoke.');
  process.exitCode = 2;
} else {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'agent-cluster-phase6-pg-'));
  try {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--test',
      '--test-force-exit',
      'apps/server/src/modules/persistence/relational/postgres-migration-runner.integration.spec.ts'
    ], {
      cwd: root,
      env: {
        ...process.env,
        AGENT_CLUSTER_DATA_DIR: dataDir,
        RELATIONAL_TEST_DATABASE_URL: databaseUrl
      },
      stdio: 'inherit'
    });

    process.exitCode = await new Promise((resolveCode) => {
      child.once('error', (error) => {
        console.error(error);
        resolveCode(1);
      });
      child.once('exit', (code, signal) => {
        if (signal) {
          console.error(`phase 6 PostgreSQL smoke terminated by ${signal}`);
          resolveCode(1);
        } else {
          resolveCode(code ?? 1);
        }
      });
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
