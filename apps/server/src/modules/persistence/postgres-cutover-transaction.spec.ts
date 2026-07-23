import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computePersistenceRevision,
  replacePostgresStateTransaction,
  type CutoverPostgresClient,
  type CutoverPostgresPool
} from './postgres-cutover-transaction.js';

type QueryCall = { sql: string; params?: unknown[] };

function setup(rows: Array<{ key: string; value: unknown }>, failOn?: RegExp) {
  const calls: QueryCall[] = [];
  let released = false;
  const client: CutoverPostgresClient = {
    async query(sql: string, params?: unknown[]) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, ...(params ? { params } : {}) });
      if (failOn?.test(normalized)) {
        throw new Error(`forced failure: ${normalized}`);
      }
      if (/^select key, value/i.test(normalized)) {
        return { rows };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    }
  };
  const pool: CutoverPostgresPool = { async connect() { return client; } };
  return { calls, pool, released: () => released };
}

test('PostgreSQL cutover begins a transaction before locking the collection table', async () => {
  const fixture = setup([]);
  await replacePostgresStateTransaction({
    pool: fixture.pool,
    tableName: 'agent_cluster_collections',
    expectedRevision: computePersistenceRevision({}),
    nextState: {}
  });
  assert.equal(fixture.calls[0]?.sql, 'begin');
  assert.match(fixture.calls[1]?.sql ?? '', /^lock table agent_cluster_collections in access exclusive mode$/i);
});

test('PostgreSQL cutover reads rows in key order while holding the lock', async () => {
  const fixture = setup([]);
  await replacePostgresStateTransaction({
    pool: fixture.pool,
    tableName: 'agent_cluster_collections',
    expectedRevision: computePersistenceRevision({}),
    nextState: {}
  });
  assert.match(fixture.calls[2]?.sql ?? '', /^select key, value .* order by key$/i);
});

test('stale PostgreSQL revision rolls back before delete', async () => {
  const fixture = setup([{ key: 'sessions', value: [{ id: 'newer' }] }]);
  await assert.rejects(
    () =>
      replacePostgresStateTransaction({
        pool: fixture.pool,
        tableName: 'agent_cluster_collections',
        expectedRevision: computePersistenceRevision({}),
        nextState: {}
      }),
    /CUTOVER_STALE_DRY_RUN/
  );
  assert.equal(fixture.calls.some((call) => /^delete /i.test(call.sql)), false);
  assert.equal(fixture.calls.at(-1)?.sql, 'rollback');
});

test('successful PostgreSQL cutover deletes old rows and inserts new keys in stable order', async () => {
  const fixture = setup([]);
  await replacePostgresStateTransaction({
    pool: fixture.pool,
    tableName: 'agent_cluster_collections',
    expectedRevision: computePersistenceRevision({}),
    nextState: { zeta: [], alpha: { ready: true } }
  });
  const mutations = fixture.calls.filter((call) => /^(delete|insert) /i.test(call.sql));
  assert.match(mutations[0]?.sql ?? '', /^delete from/i);
  assert.deepEqual(mutations.slice(1).map((call) => call.params?.[0]), ['alpha', 'zeta']);
});

test('PostgreSQL cutover serializes each collection as JSON and commits once', async () => {
  const fixture = setup([]);
  await replacePostgresStateTransaction({
    pool: fixture.pool,
    tableName: 'agent_cluster_collections',
    expectedRevision: computePersistenceRevision({}),
    nextState: { metadata: { pipelineVersion: 'v2' } }
  });
  const insert = fixture.calls.find((call) => /^insert /i.test(call.sql));
  assert.equal(insert?.params?.[1], JSON.stringify({ pipelineVersion: 'v2' }));
  assert.equal(fixture.calls.filter((call) => call.sql === 'commit').length, 1);
});

test('delete failure rolls back the PostgreSQL transaction', async () => {
  const fixture = setup([], /^delete /i);
  await assert.rejects(() => replacePostgresStateTransaction({
    pool: fixture.pool,
    tableName: 'agent_cluster_collections',
    expectedRevision: computePersistenceRevision({}),
    nextState: {}
  }), /forced failure/);
  assert.equal(fixture.calls.at(-1)?.sql, 'rollback');
});

test('insert failure rolls back the PostgreSQL transaction without commit', async () => {
  const fixture = setup([], /^insert /i);
  await assert.rejects(() => replacePostgresStateTransaction({
    pool: fixture.pool,
    tableName: 'agent_cluster_collections',
    expectedRevision: computePersistenceRevision({}),
    nextState: { sessions: [] }
  }), /forced failure/);
  assert.equal(fixture.calls.some((call) => call.sql === 'commit'), false);
  assert.equal(fixture.calls.at(-1)?.sql, 'rollback');
});

test('commit failure rolls back and always releases the PostgreSQL client', async () => {
  const fixture = setup([], /^commit$/i);
  await assert.rejects(() => replacePostgresStateTransaction({
    pool: fixture.pool,
    tableName: 'agent_cluster_collections',
    expectedRevision: computePersistenceRevision({}),
    nextState: {}
  }), /forced failure/);
  assert.equal(fixture.calls.at(-1)?.sql, 'rollback');
  assert.equal(fixture.released(), true);
});
