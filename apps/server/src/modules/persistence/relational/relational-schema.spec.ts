import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expectedRelationalComments,
  RELATIONAL_SCHEMA_BOOTSTRAP_SQL,
  RELATIONAL_SCHEMA_V2_TABLES,
  RELATIONAL_SCHEMA_V3_TABLES,
  RELATIONAL_SCHEMA_V4_TABLES,
  RELATIONAL_SCHEMA_V5_TABLES,
  RELATIONAL_SCHEMA_V1_SQL,
  RELATIONAL_SCHEMA_V2_SQL,
  RELATIONAL_SCHEMA_V3_SQL,
  RELATIONAL_SCHEMA_V4_SQL,
  RELATIONAL_SCHEMA_V5_SQL,
  RELATIONAL_SCHEMA_V6_SQL,
  RELATIONAL_SCHEMA_V7_SQL,
  RELATIONAL_SCHEMA_V8_SQL,
  RELATIONAL_SCHEMA_V8_TABLES,
  RELATIONAL_SCHEMA_V9_SQL,
  RELATIONAL_SCHEMA_V9_TABLES,
  RELATIONAL_SCHEMA_V10_SQL,
  RELATIONAL_SCHEMA_V10_TABLES,
  RELATIONAL_SCHEMA_V11_SQL,
  RELATIONAL_SCHEMA_V11_TABLES,
  RELATIONAL_SCHEMA_V12_SQL,
  RELATIONAL_SCHEMA_V12_TABLES,
  RELATIONAL_SCHEMA_V13_SQL,
  RELATIONAL_SCHEMA_V13_TABLES,
  RELATIONAL_TABLES,
  SCHEMA_MIGRATIONS_TABLE
} from './relational-schema.js';

test('every relational table and column has a non-empty Chinese explanation', () => {
  const definitions = [
    SCHEMA_MIGRATIONS_TABLE,
    ...RELATIONAL_TABLES,
    ...RELATIONAL_SCHEMA_V2_TABLES,
    ...RELATIONAL_SCHEMA_V3_TABLES,
    ...RELATIONAL_SCHEMA_V4_TABLES,
    ...RELATIONAL_SCHEMA_V5_TABLES,
    ...RELATIONAL_SCHEMA_V8_TABLES,
    ...RELATIONAL_SCHEMA_V9_TABLES,
    ...RELATIONAL_SCHEMA_V10_TABLES,
    ...RELATIONAL_SCHEMA_V11_TABLES,
    ...RELATIONAL_SCHEMA_V12_TABLES,
    ...RELATIONAL_SCHEMA_V13_TABLES
  ];
  assert.ok(definitions.length >= 35, 'expected the complete relational domain schema');

  for (const definition of definitions) {
    assert.ok(definition.comment.trim(), `missing table comment: ${definition.name}`);
    assert.match(definition.comment, /[\u3400-\u9fff]/u, `table comment must explain the table in Chinese: ${definition.name}`);
    assert.ok(definition.columns.length > 0, `table has no columns: ${definition.name}`);
    for (const column of definition.columns) {
      assert.ok(column.comment.trim(), `missing column comment: ${definition.name}.${column.name}`);
      assert.match(
        column.comment,
        /[\u3400-\u9fff]/u,
        `column comment must explain the field in Chinese: ${definition.name}.${column.name}`
      );
    }
  }
});
test('rendered migration emits COMMENT statements for every declared table and column', () => {
  const sql = `${RELATIONAL_SCHEMA_BOOTSTRAP_SQL}\n${RELATIONAL_SCHEMA_V1_SQL}\n${RELATIONAL_SCHEMA_V2_SQL}\n${RELATIONAL_SCHEMA_V3_SQL}\n${RELATIONAL_SCHEMA_V4_SQL}\n${RELATIONAL_SCHEMA_V5_SQL}\n${RELATIONAL_SCHEMA_V6_SQL}\n${RELATIONAL_SCHEMA_V7_SQL}`;
  for (const expected of expectedRelationalComments()) {
    const target = expected.column ? `${expected.table}.${expected.column}` : expected.table;
    const prefix = expected.column ? 'comment on column' : 'comment on table';
    assert.ok(`${sql}\n${RELATIONAL_SCHEMA_V8_SQL}\n${RELATIONAL_SCHEMA_V9_SQL}\n${RELATIONAL_SCHEMA_V10_SQL}\n${RELATIONAL_SCHEMA_V11_SQL}\n${RELATIONAL_SCHEMA_V12_SQL}
${RELATIONAL_SCHEMA_V13_SQL}`.includes(`${prefix} agent_cluster.${target} is `), `missing rendered SQL comment: ${target}`);
  }
});

test('v6 migration adds WorkItem ownership to memories without rewriting v5', () => {
  assert.match(RELATIONAL_SCHEMA_V6_SQL, /alter table agent_cluster\.memories add column if not exists work_item_id bigint/);
  assert.match(RELATIONAL_SCHEMA_V6_SQL, /memories_work_item_fk/);
  assert.match(RELATIONAL_SCHEMA_V6_SQL, /memories_work_item_idx/);
});

test('v7 migration adds expiring worker leases to intent routing records', () => {
  assert.match(RELATIONAL_SCHEMA_V7_SQL, /intent_routing_records add column if not exists lease_owner text/);
  assert.match(RELATIONAL_SCHEMA_V7_SQL, /intent_routing_records add column if not exists lease_expires_at timestamptz/);
  assert.match(RELATIONAL_SCHEMA_V7_SQL, /intent_routing_lease_idx/);
});

test('v9 migration persists versioned session stop requests', () => {
  assert.match(RELATIONAL_SCHEMA_V9_SQL, /create table if not exists agent_cluster\.session_stop_requests/);
  assert.match(RELATIONAL_SCHEMA_V9_SQL, /session_stop_requests_one_open_idx/);
});

test('v10 migration persists recoverable Session lifecycle tombstones', () => {
  assert.match(RELATIONAL_SCHEMA_V10_SQL, /create table if not exists agent_cluster\.session_lifecycles/);
  assert.match(RELATIONAL_SCHEMA_V10_SQL, /generation integer not null check \(generation > 0\)/);
  assert.match(RELATIONAL_SCHEMA_V10_SQL, /session_lifecycles_state_idx/);
});

test('incremental migrations terminate every statement before concatenation', () => {
  for (const sql of [RELATIONAL_SCHEMA_V6_SQL, RELATIONAL_SCHEMA_V7_SQL]) {
    for (const statement of sql.split('\n\n')) {
      assert.ok(statement.endsWith(';'), `migration statement is missing a terminator: ${statement}`);
    }
  }
});

test('all external identity tables use text external IDs instead of forcing UUID values', () => {
  const externalIdentityTables = [
    ...RELATIONAL_TABLES,
    ...RELATIONAL_SCHEMA_V2_TABLES,
    ...RELATIONAL_SCHEMA_V3_TABLES,
    ...RELATIONAL_SCHEMA_V4_TABLES,
    ...RELATIONAL_SCHEMA_V5_TABLES
  ].filter((definition) =>
    definition.columns.some((column) => column.name === 'external_id')
  );
  assert.ok(externalIdentityTables.length > 0);
  for (const definition of externalIdentityTables) {
    const externalId = definition.columns.find((column) => column.name === 'external_id');
    assert.match(externalId?.sql ?? '', /^text\b/);
  }
});
