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
  RELATIONAL_SCHEMA_V14_SQL,
  RELATIONAL_SCHEMA_V15_SQL,
  RELATIONAL_SCHEMA_V16_SQL,
  RELATIONAL_SCHEMA_V17_SQL,
  RELATIONAL_SCHEMA_V18_SQL,
  RELATIONAL_SCHEMA_V19_SQL,
  RELATIONAL_SCHEMA_V20_SQL,
  RELATIONAL_SCHEMA_V21_SQL,
  RELATIONAL_SCHEMA_V22_SQL,
  RELATIONAL_SCHEMA_V23_SQL,
  RELATIONAL_SCHEMA_V23_TABLES,
  RELATIONAL_SCHEMA_V14_TABLES,
  RELATIONAL_SCHEMA_V15_TABLES,
  RELATIONAL_SCHEMA_V16_TABLES,
  RELATIONAL_SCHEMA_V17_TABLES,
  RELATIONAL_SCHEMA_V19_TABLES,
  RELATIONAL_SCHEMA_V20_TABLES,
  RELATIONAL_SCHEMA_V21_TABLES,
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
    ...RELATIONAL_SCHEMA_V13_TABLES,
    ...RELATIONAL_SCHEMA_V14_TABLES,
    ...RELATIONAL_SCHEMA_V15_TABLES,
    ...RELATIONAL_SCHEMA_V16_TABLES,
    ...RELATIONAL_SCHEMA_V17_TABLES,
    ...RELATIONAL_SCHEMA_V19_TABLES,
    ...RELATIONAL_SCHEMA_V20_TABLES,
    ...RELATIONAL_SCHEMA_V21_TABLES,
    ...RELATIONAL_SCHEMA_V23_TABLES
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
${RELATIONAL_SCHEMA_V13_SQL}\n${RELATIONAL_SCHEMA_V14_SQL}\n${RELATIONAL_SCHEMA_V15_SQL}
${RELATIONAL_SCHEMA_V16_SQL}\n${RELATIONAL_SCHEMA_V17_SQL}\n${RELATIONAL_SCHEMA_V18_SQL}\n${RELATIONAL_SCHEMA_V19_SQL}\n${RELATIONAL_SCHEMA_V20_SQL}\n${RELATIONAL_SCHEMA_V21_SQL}\n${RELATIONAL_SCHEMA_V23_SQL}`.includes(`${prefix} agent_cluster.${target} is `), `missing rendered SQL comment: ${target}`);
  }
});

test('OAuth callback state has a dedicated expiring PostgreSQL projection', () => {
  assert.match(RELATIONAL_SCHEMA_V20_SQL, /create table if not exists agent_cluster\.github_oauth_states/);
  assert.match(RELATIONAL_SCHEMA_V20_SQL, /state_hash text primary key/);
  assert.match(RELATIONAL_SCHEMA_V20_SQL, /expires_at timestamptz not null/);
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

test('v18 migration persists one in-flight Runtime switch request per Session', () => {
  assert.match(RELATIONAL_SCHEMA_V18_SQL, /create table if not exists agent_cluster\.runtime_switch_requests/);
  // The unique logical key is what makes a replayed POST one request rather than
  // a second stop barrier; the partial index is what stops two concurrent
  // switches from racing the same preference write (AC8).
  assert.match(RELATIONAL_SCHEMA_V18_SQL, /logical_key text not null unique/);
  assert.match(RELATIONAL_SCHEMA_V18_SQL, /runtime_switch_requests_active_idx/);
  assert.match(RELATIONAL_SCHEMA_V18_SQL, /where status not in \('completed','failed'\)/);
  // The version backs both the event idempotency key and client convergence, so
  // it may never be absent or zero.
  assert.match(RELATIONAL_SCHEMA_V18_SQL, /version bigint not null check \(version > 0\)/);
  // A switch must outlive a restart with its stop evidence and generation fence.
  assert.match(RELATIONAL_SCHEMA_V18_SQL, /stop_request_external_id text/);
  assert.match(RELATIONAL_SCHEMA_V18_SQL, /lifecycle_generation integer/);
  assert.match(RELATIONAL_SCHEMA_V18_SQL, /failure_stage text/);
});

test('v18 does not rewrite the change-request table it follows', () => {
  assert.doesNotMatch(RELATIONAL_SCHEMA_V18_SQL, /agent_cluster\.change_requests/);
  assert.doesNotMatch(RELATIONAL_SCHEMA_V18_SQL, /drop table/i);
  assert.doesNotMatch(RELATIONAL_SCHEMA_V18_SQL, /alter table agent_cluster\.sessions/);
});

test('v19 stores GitHub source, delivery, conflict and encrypted authorization separately', () => {
  for (const table of ['github_source_bindings', 'github_deliveries', 'github_conflicts', 'github_authorizations']) {
    assert.match(RELATIONAL_SCHEMA_V19_SQL, new RegExp(`create table if not exists agent_cluster\\.${table}`));
  }
  assert.match(RELATIONAL_SCHEMA_V19_SQL, /secret_envelope text/);
  assert.match(RELATIONAL_SCHEMA_V19_SQL, /version bigint not null check \(version > 0\)/);
  assert.doesNotMatch(RELATIONAL_SCHEMA_V19_SQL, /alter table agent_cluster\.sessions/);
});

test('v22 migration indexes outbox records by Session for scoped collection loads', () => {
  assert.match(RELATIONAL_SCHEMA_V22_SQL,
    /create index if not exists event_outbox_aggregate_idx on agent_cluster\.event_outbox \(aggregate_type, aggregate_external_id\);/);
});
