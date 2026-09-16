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
  assert.match(queries[1] ?? '', /pg_advisory_xact_lock/);
  const truncate = queries.find(sql => sql.startsWith('truncate table')) ?? '';
  assert.match(truncate, /agent_cluster\.artifacts/);
  assert.match(truncate, /agent_cluster\.file_revision_records/);
  assert.doesNotMatch(truncate, /schema_migrations/);
  assert.doesNotMatch(truncate, /migration_runs/);
  assert.doesNotMatch(truncate, /migration_errors/);
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
    async connect() { return { query: this.query, release() {} }; },
    async query(sql: string, parameters?: unknown[]) {
      if (!sql.includes('for update skip locked')) return { rows: [] };
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

test('immediate outbox records use the PostgreSQL transaction clock for availability', async () => {
  const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
  const client = {
    async query(sql: string, parameters?: unknown[]) {
      queries.push({ sql, parameters });
      return { rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const codec = { externalize(value: unknown) { return { value, contents: [] }; } };
  const store = new RelationalStateStore(pool as never, codec as never);

  await store.writeCollection('eventOutbox', [{
    id: 'outbox:event-future-clock',
    idempotencyKey: 'session:session-1:event:event-future-clock',
    aggregateType: 'session',
    aggregateId: 'session-1',
    eventType: 'runtime_progress',
    payload: {},
    status: 'pending',
    attempts: 0,
    createdAt: '2099-01-01T00:00:00.000Z'
  }]);

  const write = queries.find(({ sql }) => /insert into agent_cluster\.event_outbox as outbox/i.test(sql));
  assert.match(write?.sql ?? '', /coalesce\(\$9,now\(\)\)/i);
  assert.equal(write?.parameters?.[8], null);
});

test('discardEventOutbox terminalizes an obsolete event and clears its lease', async () => {
  const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
  const pool = {
    async connect() { return { query: this.query, release() {} }; },
    async query(sql: string, parameters?: unknown[]) {
      if (!sql.includes("status='discarded'")) return { rows: [] };
      queries.push({ sql, parameters });
      return { rows: [] };
    }
  };
  const store = new RelationalStateStore(pool as never, {} as never);

  await store.discardEventOutbox('event-deleted', 'session deleted');

  assert.match(queries[0]?.sql ?? '', /status='discarded'/i);
  assert.match(queries[0]?.sql ?? '', /lease_owner=null,lease_expires_at=null/i);
  assert.deepEqual(queries[0]?.parameters, ['outbox:event-deleted', 'session deleted']);
});

test('100 appendEvent calls insert only new events and outbox records without updating history', async () => {
  const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
  let nextSequence = 8;
  const client = {
    async query(sql: string, parameters?: unknown[]) {
      queries.push({ sql, parameters });
      if (/from agent_cluster\.sessions[\s\S]*for update/i.test(sql)) return { rows: [{ id: '42' }] };
      if (/max\(session_seq\)/i.test(sql)) return { rows: [{ next_sequence: String(nextSequence++) }] };
      return { rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const codec = { externalize(value: unknown) { return { value, contents: [] }; } };
  const store = new RelationalStateStore(pool as never, codec as never);

  await store.appendEvent({
    id: 'event-8',
    sessionId: 'session-1',
    type: 'agent_message',
    actor: { type: 'agent', id: 'agent-1' },
    toAgentIds: [],
    content: 'new event',
    metadata: { schemaVersion: '0.1', payload: {} },
    createdAt: '2026-08-19T07:03:41.000Z'
  });
  for (let index = 9; index < 108; index += 1) {
    await store.appendEvent({
      id: `event-${index}`,
      sessionId: 'session-1',
      type: 'agent_message',
      actor: { type: 'agent', id: 'agent-1' },
      toAgentIds: [],
      content: `new event ${index}`,
      metadata: { schemaVersion: '0.1', payload: {} },
      createdAt: '2026-08-19T07:03:41.000Z'
    });
  }

  const eventWrites = queries.filter(({ sql }) => /insert into agent_cluster\.collaboration_events/i.test(sql));
  const outboxWrites = queries.filter(({ sql }) => /insert into agent_cluster\.event_outbox/i.test(sql));
  assert.equal(queries[0]?.sql, 'begin');
  assert.equal(queries.at(-1)?.sql, 'commit');
  assert.equal(eventWrites.length, 100);
  assert.equal(outboxWrites.length, 100);
  assert.equal(eventWrites.some(({ sql }) => /do update/i.test(sql)), false);
  assert.equal(eventWrites[0]?.parameters?.[2], '8');
  assert.equal(outboxWrites[0]?.parameters?.[0], 'outbox:event-8');
  assert.equal(queries.some(({ sql }) => /^\s*update agent_cluster\.collaboration_events/i.test(sql)), false);
});
