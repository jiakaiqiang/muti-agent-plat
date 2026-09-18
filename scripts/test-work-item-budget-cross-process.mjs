import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';

/**
 * Cross-process competition for one requirement's budget.
 *
 * Run under tsx so both modes can import the TypeScript services:
 *   node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json \
 *     scripts/test-work-item-budget-cross-process.mjs
 *
 * The driver creates a disposable database, seeds one session, then spawns two
 * worker processes that race for the same allowance. Two services inside one
 * event loop cannot prove this: only separate OS processes can show that the
 * persistence transaction — not in-process serialization — decides the winner.
 */
const SELF = 'scripts/test-work-item-budget-cross-process.mjs';
const WORKER_MARKER = 'WORK_ITEM_BUDGET_WORKER';
const workerRequest = process.env[WORKER_MARKER];

if (workerRequest) {
  const request = JSON.parse(workerRequest);
  const { PersistenceService } = await import('../apps/server/src/modules/persistence/persistence.service.js');
  const { WorkItemBudgetStore } = await import('../apps/server/src/modules/runtimes/work-item-budget-store.js');
  const persistence = new PersistenceService({
    enabled: true,
    backend: 'postgres',
    databaseUrl: request.databaseUrl
  });
  try {
    await persistence.initialize();
    const store = new WorkItemBudgetStore(persistence, () => request.now);
    const outcome = await store.reserve({
      sessionId: request.sessionId,
      workItemId: request.workItemId,
      attemptId: request.attemptId,
      operationId: request.attemptId,
      category: 'execution',
      requestedTokens: request.requestedTokens,
      limitTokens: request.limitTokens,
      now: request.now
    });
    process.stdout.write(`${JSON.stringify({
      status: outcome.status,
      availableTokens: outcome.status === 'insufficient' ? outcome.availableTokens : undefined
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'error', code: error?.code ?? 'unknown' })}\n`);
    process.exitCode = 1;
  } finally {
    await persistence.onModuleDestroy().catch(() => undefined);
  }
} else {
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
  const name = `agent_cluster_wib_xproc_${process.pid}_${Date.now()}`;
  if (!/^agent_cluster_wib_xproc_\d+_\d+$/.test(name)) throw new Error('Unsafe test database name');
  const isolatedUrl = new URL(adminUrl);
  isolatedUrl.pathname = `/${name}`;
  const isolated = isolatedUrl.toString();
  const pool = new Pool({ connectionString: adminUrl.toString() });
  const now = new Date().toISOString();
  const sessionId = `xproc-session-${process.pid}`;
  const workItemId = `${sessionId}-item`;
  let created = false;

  const runWorker = (attemptId, requestedTokens) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'node_modules/tsx/dist/cli.mjs', '--tsconfig', 'apps/server/tsconfig.json', SELF
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        [WORKER_MARKER]: JSON.stringify({
          databaseUrl: isolated, sessionId, workItemId, attemptId, requestedTokens,
          limitTokens: 1_000, now
        })
      }
    });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      const line = out.split(/\r?\n/).find(item => item.trim().startsWith('{'));
      if (code !== 0 || !line) {
        reject(new Error(`worker ${attemptId} exited ${code} without a result line`));
        return;
      }
      resolve(JSON.parse(line));
    });
  });

  try {
    await pool.query(`create database "${name}"`);
    created = true;
    const { PersistenceService } = await import('../apps/server/src/modules/persistence/persistence.service.js');
    const seed = new PersistenceService({ enabled: true, backend: 'postgres', databaseUrl: isolated });
    await seed.initialize();
    await seed.setCollection('sessions', [...seed.getCollection('sessions', []), {
      id: sessionId, dataEpoch: seed.currentDataEpoch(), title: 'Cross-process budget',
      status: 'EXECUTING', ownerId: 'test', createdAt: now, updatedAt: now
    }]);
    await seed.onModuleDestroy();

    console.log(`Isolated PostgreSQL fixture: ${name}`);
    const outcomes = await Promise.all([
      runWorker('attempt-a', 700),
      runWorker('attempt-b', 700)
    ]);
    const statuses = outcomes.map(item => item.status).sort();
    if (JSON.stringify(statuses) !== JSON.stringify(['insufficient', 'reserved'])) {
      throw new Error(`exactly one process may take the allowance, got ${JSON.stringify(outcomes)}`);
    }

    const verifyPool = new Pool({ connectionString: isolated });
    try {
      const row = await verifyPool.query(
        'select reserved_tokens from agent_cluster.work_item_budgets where work_item_external_id=$1',
        [workItemId]
      );
      if (row.rows.length !== 1 || Number(row.rows[0].reserved_tokens) !== 700) {
        throw new Error(`the committed allowance must be exactly one row of 700, got ${JSON.stringify(row.rows)}`);
      }
    } finally {
      await verifyPool.end();
    }
    console.log('cross-process budget competition: exactly one reserved, one refused, ledger holds 700');
  } catch (error) {
    console.error(`Cross-process budget validation failed (${error.code ?? error.message}).`);
    process.exitCode = 1;
  } finally {
    try {
      if (created) {
        await pool.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()',
          [name]
        );
        await pool.query(`drop database if exists "${name}"`);
      }
    } catch {
      // Cleanup failures must not mask the assertion result.
    }
    await pool.end().catch(() => undefined);
  }
}
