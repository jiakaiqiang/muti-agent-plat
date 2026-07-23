import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expectedRelationalComments,
  RELATIONAL_SCHEMA_BOOTSTRAP_SQL,
  RELATIONAL_SCHEMA_V1_SQL,
  RELATIONAL_TABLES,
  SCHEMA_MIGRATIONS_TABLE
} from './relational-schema.js';

test('every relational table and column has a non-empty Chinese explanation', () => {
  const definitions = [SCHEMA_MIGRATIONS_TABLE, ...RELATIONAL_TABLES];
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
  const sql = `${RELATIONAL_SCHEMA_BOOTSTRAP_SQL}\n${RELATIONAL_SCHEMA_V1_SQL}`;
  for (const expected of expectedRelationalComments()) {
    const target = expected.column ? `${expected.table}.${expected.column}` : expected.table;
    const prefix = expected.column ? 'comment on column' : 'comment on table';
    assert.ok(sql.includes(`${prefix} agent_cluster.${target} is `), `missing rendered SQL comment: ${target}`);
  }
});

test('all external identity tables use text external IDs instead of forcing UUID values', () => {
  const externalIdentityTables = RELATIONAL_TABLES.filter((definition) =>
    definition.columns.some((column) => column.name === 'external_id')
  );
  assert.ok(externalIdentityTables.length > 0);
  for (const definition of externalIdentityTables) {
    const externalId = definition.columns.find((column) => column.name === 'external_id');
    assert.match(externalId?.sql ?? '', /^text\b/);
  }
});
