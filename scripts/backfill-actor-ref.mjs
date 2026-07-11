#!/usr/bin/env node

/**
 * actor-ref 回填脚本(M3-05):
 *   遍历 PersistenceService 里的 collaboration_events / agent_tasks 集合,
 *   为缺失 actor / assignee / assignedBy 的记录按 M3-04 deriveActor 相同规则补齐。
 *
 * 特性:
 *   - 默认 dry-run,仅统计;传 `--apply` 才真正写回。
 *   - 幂等:已有 actor / assignee / assignedBy 一律跳过,不覆盖。
 *
 * 使用:
 *   node scripts/backfill-actor-ref.mjs               # dry-run
 *   node scripts/backfill-actor-ref.mjs --apply       # 真正写回
 */

import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';

const systemEventTypes = new Set(['session_status_changed', 'error_reported']);

export function deriveActor(input) {
  if (input.type === 'user_message') {
    return { type: 'user', id: input.sessionUserId ?? 'system' };
  }
  if (input.fromAgentId) {
    return { type: 'agent', id: input.fromAgentId };
  }
  if (systemEventTypes.has(input.type)) {
    return { type: 'system', id: 'system' };
  }
  return { type: 'system', id: 'system' };
}

export function backfillEvents(eventsBySession) {
  let scanned = 0;
  let skipped = 0;
  let filled = 0;
  for (const events of Object.values(eventsBySession ?? {})) {
    for (const event of events ?? []) {
      scanned += 1;
      if (event.actor) {
        skipped += 1;
        continue;
      }
      event.actor = deriveActor({ type: event.type, fromAgentId: event.fromAgentId });
      filled += 1;
    }
  }
  return { scanned, skipped, filled };
}

export function backfillTasks(tasksBySession) {
  let scanned = 0;
  let skipped = 0;
  let filled = 0;
  const taskGroups = Array.isArray(tasksBySession)
    ? [tasksBySession]
    : Object.values(tasksBySession ?? {});
  for (const tasks of taskGroups) {
    for (const task of tasks ?? []) {
    scanned += 1;
    let touched = false;
    if (!task.assignee && task.assigneeAgentId) {
      task.assignee = { type: 'agent', id: task.assigneeAgentId };
      touched = true;
    }
    if (!task.assignedBy && task.assignedByAgentId) {
      task.assignedBy = { type: 'agent', id: task.assignedByAgentId };
      touched = true;
    }
    if (touched) filled += 1;
    else skipped += 1;
    }
  }
  return { scanned, skipped, filled };
}

export async function runBackfill({ apply, filePath }) {
  const raw = await readFile(filePath, 'utf8');
  const snapshot = JSON.parse(raw);

  const eventsStats = backfillEvents(snapshot.eventsBySession);
  const tasksStats = backfillTasks(snapshot.tasksBySession);

  if (apply) {
    const backupPath = `${filePath}.actor-ref-backup`;
    await copyFile(filePath, backupPath);
    await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    return { apply, backupPath, events: eventsStats, tasks: tasksStats };
  }
  return { apply, events: eventsStats, tasks: tasksStats };
}

function safeTableName(value) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid PostgreSQL collection table name: ${value}`);
  }
  return value;
}

function postgresBackupTableName(tableName, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return safeTableName(`${tableName}_actor_ref_backup_${stamp}`);
}

export async function runPostgresBackfill({
  apply,
  databaseUrl,
  tableName = 'agent_cluster_collections',
  pool
}) {
  const safeTable = safeTableName(tableName);
  const ownedPool = pool ?? new Pool({ connectionString: databaseUrl });
  const client = typeof ownedPool.connect === 'function' ? await ownedPool.connect() : ownedPool;
  try {
    const selected = await client.query(
      `select key, value from ${safeTable} where key = any($1::text[]) order by key`,
      [['eventsBySession', 'tasksBySession']]
    );
    const values = Object.fromEntries(selected.rows.map((row) => [row.key, row.value]));
    const eventsStats = backfillEvents(values.eventsBySession);
    const tasksStats = backfillTasks(values.tasksBySession);

    if (!apply) {
      return { apply, backend: 'postgres', tableName: safeTable, events: eventsStats, tasks: tasksStats };
    }

    const backupTable = postgresBackupTableName(safeTable);
    await client.query('begin');
    try {
      await client.query(
        `create table ${backupTable} as
         select key, value, updated_at from ${safeTable}
         where key = any($1::text[])`,
        [['eventsBySession', 'tasksBySession']]
      );
      for (const key of ['eventsBySession', 'tasksBySession']) {
        if (values[key] === undefined) continue;
        await client.query(
          `update ${safeTable} set value = $2::jsonb, updated_at = now() where key = $1`,
          [key, JSON.stringify(values[key])]
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    return {
      apply,
      backend: 'postgres',
      tableName: safeTable,
      backupTable,
      events: eventsStats,
      tasks: tasksStats
    };
  } finally {
    if (typeof client.release === 'function') client.release();
    if (!pool && typeof ownedPool.end === 'function') await ownedPool.end();
  }
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const apply = process.argv.includes('--apply');
  const backendIndex = process.argv.indexOf('--backend');
  const backend =
    backendIndex >= 0
      ? process.argv[backendIndex + 1]
      : process.env.AGENT_CLUSTER_PERSISTENCE_BACKEND ?? 'file';
  const idx = process.argv.indexOf('--file');
  const filePath = idx >= 0 ? process.argv[idx + 1] : join(process.cwd(), '.cache', 'agent-cluster', 'state.v0.1.json');
  const tableIndex = process.argv.indexOf('--table');
  const tableName =
    tableIndex >= 0
      ? process.argv[tableIndex + 1]
      : process.env.AGENT_CLUSTER_POSTGRES_COLLECTION_TABLE ?? 'agent_cluster_collections';
  const runner =
    backend === 'postgres'
      ? runPostgresBackfill({ apply, databaseUrl: process.env.DATABASE_URL, tableName })
      : runBackfill({ apply, filePath });
  runner
    .then((stats) => {
      console.log(JSON.stringify(stats, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
