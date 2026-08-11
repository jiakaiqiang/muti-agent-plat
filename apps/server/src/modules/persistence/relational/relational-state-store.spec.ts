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
  assert.match(queryFor('event_outbox'), /coalesce\([\s\S]*payload->'sourceRecord'[\s\S]*jsonb_build_object/i);
  assert.doesNotMatch(queryFor('event_outbox'), /payload \? 'sourceRecord'/i);
});

test('outbox claims use a single skip-locked lease update and return canonical records', async () => {
  const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
  const pool = {
    async query(sql: string, parameters?: unknown[]) {
      queries.push({ sql, parameters });
      return { rows: [{ value: { id: 'outbox:event-1', status: 'publishing', leaseOwner: 'worker-1' } }] };
    }
  };
  const store = new RelationalStateStore(pool as never, {} as never);

  const claimed = await store.claimPendingEventOutbox('worker-1', 25, 45_000);

  assert.equal(claimed[0]?.id, 'outbox:event-1');
  assert.match(queries[0]?.sql ?? '', /for update skip locked/i);
  assert.match(queries[0]?.sql ?? '', /status='publishing'/i);
  assert.match(queries[0]?.sql ?? '', /lease_expires_at=now\(\)\+\(\$3\*interval '1 millisecond'\)/i);
  assert.deepEqual(queries[0]?.parameters, ['worker-1', 25, 45_000]);
});
