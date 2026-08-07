import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  RELATIONAL_SCHEMA_BOOTSTRAP_SQL,
  RELATIONAL_SCHEMA_NAME,
  RELATIONAL_SCHEMA_V1_SQL,
  RELATIONAL_SCHEMA_V2_SQL,
  RELATIONAL_SCHEMA_V3_SQL,
  RELATIONAL_SCHEMA_V4_SQL,
  RELATIONAL_SCHEMA_V5_SQL
} from './relational-schema.js';

type Migration = {
  version: number;
  name: string;
  sql: string;
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'relational_persistence_v2_baseline',
    sql: RELATIONAL_SCHEMA_V1_SQL
  },
  {
    version: 2,
    name: 'local_runtime_devices_and_audits',
    sql: RELATIONAL_SCHEMA_V2_SQL
  },
  {
    version: 3,
    name: 'file_revision_records',
    sql: RELATIONAL_SCHEMA_V3_SQL
  },
  {
    version: 4,
    name: 'workspace_leases_and_writebacks',
    sql: RELATIONAL_SCHEMA_V4_SQL
  },
  {
    version: 5,
    name: 'work_items_decisions_and_intent_routing',
    sql: RELATIONAL_SCHEMA_V5_SQL
  }
];

const ADVISORY_LOCK_KEY = 1_843_287_101;

export async function runPostgresMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(RELATIONAL_SCHEMA_BOOTSTRAP_SQL);
    const applied = await readAppliedMigrations(client);

    for (const migration of MIGRATIONS) {
      const checksum = sha256(migration.sql);
      const existing = applied.get(migration.version);
      if (existing && existing !== checksum) {
        throw new Error(
          `RELATIONAL_MIGRATION_CHECKSUM_MISMATCH: migration ${migration.version} was already applied with another checksum.`
        );
      }
      if (existing) continue;

      await client.query('begin');
      try {
        await client.query(migration.sql);
        await client.query(
          `insert into ${RELATIONAL_SCHEMA_NAME}.schema_migrations (version, name, checksum)
           values ($1, $2, $3)`,
          [migration.version, migration.name, checksum]
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }

    await assertSchemaComments(client);
    await assertReadWriteProbe(client);
  } finally {
    await client.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
async function readAppliedMigrations(client: PoolClient): Promise<Map<number, string>> {
  const result = await client.query<{ version: number; checksum: string }>(
    `select version, checksum from ${RELATIONAL_SCHEMA_NAME}.schema_migrations order by version`
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}

async function assertSchemaComments(client: PoolClient): Promise<void> {
  const result = await client.query<{ table_name: string; column_name: string | null }>(`
    select c.relname as table_name, null::text as column_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = '${RELATIONAL_SCHEMA_NAME}'
       and c.relkind in ('r', 'p')
       and obj_description(c.oid, 'pg_class') is null
    union all
    select c.relname as table_name, a.attname as column_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
     where n.nspname = '${RELATIONAL_SCHEMA_NAME}'
       and c.relkind in ('r', 'p')
       and a.attnum > 0
       and not a.attisdropped
       and col_description(c.oid, a.attnum) is null
    order by table_name, column_name nulls first
  `);
  if (result.rows.length) {
    const missing = result.rows
      .map((row) => (row.column_name ? `${row.table_name}.${row.column_name}` : row.table_name))
      .join(', ');
    throw new Error(`RELATIONAL_SCHEMA_COMMENT_MISSING: ${missing}`);
  }
}

async function assertReadWriteProbe(client: PoolClient): Promise<void> {
  await client.query('begin');
  try {
    await client.query('create temporary table agent_cluster_rw_probe (value integer not null) on commit drop');
    await client.query('insert into agent_cluster_rw_probe (value) values (1)');
    const result = await client.query<{ value: number }>('select value from agent_cluster_rw_probe');
    if (result.rows[0]?.value !== 1) throw new Error('RELATIONAL_DATABASE_PROBE_FAILED: unexpected probe result.');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
