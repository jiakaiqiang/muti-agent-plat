import assert from 'node:assert/strict';
import test from 'node:test';
import { RelationalStateStore } from './relational-state-store.js';

test('replaceState clears managed state tables while retaining migration audit tables', async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const codec = {
    externalize(value: unknown) {
      return { value, contents: [] };
    }
  };
  const store = new RelationalStateStore(pool as never, codec as never);

  await store.replaceState({});

  assert.equal(queries[0], 'begin');
  assert.match(queries[1] ?? '', /^truncate table /);
  assert.match(queries[1] ?? '', /agent_cluster\.artifacts/);
  assert.match(queries[1] ?? '', /agent_cluster\.file_revision_records/);
  assert.doesNotMatch(queries[1] ?? '', /schema_migrations/);
  assert.doesNotMatch(queries[1] ?? '', /migration_runs/);
  assert.doesNotMatch(queries[1] ?? '', /migration_errors/);
  assert.equal(queries.at(-1), 'commit');
});

test('replaceState rolls back when clearing managed state tables fails', async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.startsWith('truncate table')) throw new Error('truncate failed');
      return { rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const codec = {
    externalize(value: unknown) {
      return { value, contents: [] };
    }
  };
  const store = new RelationalStateStore(pool as never, codec as never);

  await assert.rejects(() => store.replaceState({}), /truncate failed/);
  assert.equal(queries.at(-1), 'rollback');
});

test('loadState excludes projections owned by soft-deleted sessions', async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const codec = {
    hydrate<T>(value: T) {
      return value;
    }
  };
  const store = new RelationalStateStore(pool as never, codec as never);

  await store.loadState();

  const queryFor = (table: string) => queries.find((sql) => sql.includes(`agent_cluster.${table}`)) ?? '';
  assert.match(queryFor('runtime_invocations'), /join agent_cluster\.sessions s[\s\S]*where s\.deleted_at is null/i);
  assert.match(queryFor('artifacts'), /join agent_cluster\.sessions s[\s\S]*s\.deleted_at is null/i);
  assert.match(queryFor('workflow_runs'), /join agent_cluster\.sessions s[\s\S]*where s\.deleted_at is null/i);
  assert.match(queryFor('file_revision_records'), /join agent_cluster\.sessions s[\s\S]*s\.deleted_at is null/i);
  assert.match(queryFor('workspace_writebacks'), /join agent_cluster\.sessions s[\s\S]*where s\.deleted_at is null/i);
  assert.match(queryFor('suggested_tasks'), /join agent_cluster\.sessions s[\s\S]*where s\.deleted_at is null/i);
});
