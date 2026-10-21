import assert from 'node:assert/strict';
import test from 'node:test';
import { RelationalStateStore } from './relational-state-store.js';

test('intent record projection refuses a route from a different session or epoch and refuses historical payload overwrite', async () => {
  const store = new RelationalStateStore({} as never, {} as never) as any;
  const item = { id: 'revision-1', sessionId: 'session', dataEpoch: 'epoch', routingId: 'route', intentRevision: 1,
    authorizationState: 'unknown', createdAt: '2026-10-19T00:00:00.000Z' };
  let insertAttempted = false;
  const mismatch = { async query(sql: string) { if (sql.includes('insert into')) insertAttempted = true; return { rows: [] }; } };
  await assert.rejects(store.writeIntentRecords(mismatch, 'intentRouteRevisionsBySession', { session: [item] }), /BINDING_MISMATCH/);
  assert.equal(insertAttempted, false);
  const conflict = { async query(sql: string) { return { rows: sql.includes('select s.id') ? [{ session_id: '1', routing_id: '2' }] : [] }; } };
  await assert.rejects(store.writeIntentRecords(conflict, 'intentRouteRevisionsBySession', { session: [item] }), /INTENT_RECORD_IMMUTABLE/);
});

test('runtime health projection binds the Session and guards monotonic versions without storing reasoning', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = { async query(sql: string, values?: unknown[]) {
    calls.push({ sql, values });
    return { rows: sql.includes('select id::text from agent_cluster.sessions') ? [{ id: '1' }] : [] };
  } };
  const store = new RelationalStateStore({} as never, {} as never) as any;
  await store.writeRuntimeHealth(client, { session: [{ invocationId: 'call', version: 5, updatedAt: '2026-09-29T00:00:00Z' }] });
  const write = calls.find(item => item.sql.includes('insert into agent_cluster.runtime_health_snapshots'))!;
  assert.match(write.sql, /runtime_health_snapshots.session_id=excluded.session_id/);
  assert.match(write.sql, /runtime_health_snapshots.version <= excluded.version/);
  assert.deepEqual(write.values?.slice(0, 3), ['call', '1', 5]);
});

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

test('GitHub authorization projection stores only an encrypted secret outside its snapshot', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [] };
    }
  };
  const store = new RelationalStateStore({} as never, {} as never) as any;
  const record = {
    id: 'auth-1', accountId: '123', executionLocation: 'server', state: 'active',
    version: 1, secretEnvelope: 'enc-v2:encrypted-only',
    createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z'
  };
  await store.writeCodeHostAuthorizations(client, [record]);
  const values = calls[0]?.values ?? [];
  assert.equal(values[4], record.secretEnvelope);
  assert.equal(String(values[7]).includes(record.secretEnvelope), false);
  await assert.rejects(store.writeCodeHostAuthorizations(client, [
    { ...record, secretEnvelope: 'github_pat_plaintext' }
  ]), /GITHUB_AUTHORIZATION_SECRET_NOT_ENCRYPTED/);
});

test('OAuth state projection stores only a hash and removes consumed states', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = { async query(sql: string, values?: unknown[]) {
    calls.push({ sql, values });
    return { rows: sql.includes('select id::text from agent_cluster.sessions') ? [{ id: '1' }] : [] };
  } };
  const store = new RelationalStateStore({} as never, {} as never) as any;
  const state = { stateHash: 'a'.repeat(64), sessionId: 'session-1',
    repositoryUrl: 'https://github.com/example/project', executionLocation: 'server',
    expiresAt: '2026-09-27T01:00:00.000Z' };
  await store.writeCodeHostOAuthStates(client, [state]);
  assert.ok(calls.some((call) => call.sql.includes('delete from agent_cluster.github_oauth_states')));
  const insert = calls.find((call) => call.sql.includes('insert into agent_cluster.github_oauth_states'));
  assert.equal(insert?.values?.[0], state.stateHash);
  assert.equal(JSON.stringify(insert?.values).includes('access_token'), false);
});

test('GitHub conflict projection omits editable file content', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: sql.includes('select id::text') ? [{ id: '1' }] : [] };
    }
  };
  const store = new RelationalStateStore({} as never, {} as never) as any;
  await store.writeGitHubConflicts(client, { 'session-1': [{
    id: 'conflict-1', sessionId: 'session-1', deliveryRound: 1,
    targetOperation: 'merge_pull_request', version: 1,
    files: [{ fileId: 'file-1', path: 'src/a.ts', kind: 'text', status: 'draft',
      version: 2, oursContent: 'private-ours', resultContent: 'private-result' }],
    createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z'
  }] });
  const snapshot = String(calls.find((call) => call.sql.includes('insert into agent_cluster.github_conflicts'))?.values?.[5]);
  assert.equal(snapshot.includes('private-ours'), false);
  assert.equal(snapshot.includes('private-result'), false);
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

function collectionMutationHarness(input: {
  eventsBySession: Record<string, Array<Record<string, unknown>>>;
  eventOutbox: Array<Record<string, unknown>>;
}) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes('from agent_cluster.collaboration_events e join agent_cluster.sessions s')) {
        return { rows: Object.entries(input.eventsBySession).flatMap(([group_id, events]) =>
          events.map(value => ({ group_id, value }))) };
      }
      if (sql.includes('from agent_cluster.event_outbox outbox order by id')) {
        return { rows: input.eventOutbox.map(value => ({ value })) };
      }
      if (sql.includes('select id::text from agent_cluster.sessions')) return { rows: [{ id: `pk-${values?.[0]}` }] };
      return { rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const codec = { externalize: (value: unknown) => ({ value, contents: [] }), hydrate: (value: unknown) => value };
  return { queries, store: new RelationalStateStore(pool as never, codec as never) };
}

function storedEvent(sessionId: string, id: string) {
  return { id, sessionId, type: 'agent_message', actor: { type: 'agent', id: 'agent-1' },
    content: id, metadata: { schemaVersion: '0.1', payload: {} }, createdAt: '2026-10-13T00:00:00.000Z' };
}

function storedOutbox(eventId: string, sessionId: string) {
  return { id: `outbox:${eventId}`, idempotencyKey: `session:${sessionId}:event:${eventId}`, aggregateType: 'session',
    aggregateId: sessionId, eventType: 'agent_message', status: 'published', attempts: 0, createdAt: '2026-10-13T00:00:00.000Z' };
}

test('collection mutations write only new or changed events and outbox records', async () => {
  const { queries, store } = collectionMutationHarness({
    eventsBySession: {
      'session-a': [storedEvent('session-a', 'a-1'), storedEvent('session-a', 'a-2')],
      'session-b': [storedEvent('session-b', 'b-1')]
    },
    eventOutbox: [storedOutbox('a-1', 'session-a'), storedOutbox('a-2', 'session-a'), storedOutbox('b-1', 'session-b')]
  });

  await store.mutateCollections(['eventsBySession', 'eventOutbox'], draft => {
    const events = draft.eventsBySession as Record<string, Array<Record<string, unknown>>>;
    events['session-a']!.push(storedEvent('session-a', 'a-3'));
    (draft.eventOutbox as Array<Record<string, unknown>>).push({ ...storedOutbox('a-3', 'session-a'), status: 'pending' });
  });

  const eventWrites = queries.filter(({ sql }) => /insert into agent_cluster\.collaboration_events/i.test(sql));
  const outboxUpserts = queries.filter(({ sql }) => /insert into agent_cluster\.event_outbox as outbox/i.test(sql));
  assert.deepEqual(eventWrites.map(({ values }) => values?.[0]), ['a-3']);
  assert.deepEqual(outboxUpserts.map(({ values }) => values?.[0]), ['outbox:a-3']);
  assert.equal(queries.at(-1)?.sql, 'commit');
});

test('collection mutations rewrite an edited event but leave other Sessions untouched', async () => {
  const { queries, store } = collectionMutationHarness({
    eventsBySession: {
      'session-a': [storedEvent('session-a', 'a-1'), storedEvent('session-a', 'a-2')],
      'session-b': [storedEvent('session-b', 'b-1')]
    },
    eventOutbox: []
  });

  const { state } = await store.mutateCollections(['eventsBySession'], draft => {
    const events = draft.eventsBySession as Record<string, Array<Record<string, unknown>>>;
    events['session-a']![1] = { ...events['session-a']![1], content: 'edited' };
  });

  const eventWrites = queries.filter(({ sql }) => /insert into agent_cluster\.collaboration_events/i.test(sql));
  assert.deepEqual(eventWrites.map(({ values }) => values?.[0]), ['a-2']);
  assert.equal(eventWrites[0]?.values?.[6], 'edited');
  // The caller still receives the complete committed collection for its in-memory cache.
  const committed = state.eventsBySession as Record<string, unknown[]>;
  assert.equal(committed['session-a']?.length, 2);
  assert.equal(committed['session-b']?.length, 1);
});

test('event projection numbers new events after the stored sequence instead of by array position', async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = { async query(sql: string, values?: unknown[]) {
    queries.push({ sql, values });
    return { rows: sql.includes('select id::text from agent_cluster.sessions') ? [{ id: '7' }] : [] };
  } };
  const store = new RelationalStateStore({} as never, {} as never) as any;

  // An incremental write hands over only the newest event; position 1 would collide
  // with the existing first row on unique (session_id, session_seq).
  await store.writeEvents(client, { 'session-a': [storedEvent('session-a', 'a-9')] });

  const insert = queries.find(({ sql }) => /insert into agent_cluster\.collaboration_events/i.test(sql))!;
  assert.match(insert.sql, /coalesce\(max\(session_seq\),\s*0\)\s*\+\s*1/i);
  assert.equal(insert.values?.includes(1), false);
  assert.match(insert.sql, /on conflict \(external_id\) do update set content=excluded\.content,payload=excluded\.payload/);
});

test('session-scoped mutations load only that Session\'s events and outbox records', async () => {
  const { queries, store } = collectionMutationHarness({
    eventsBySession: { 'session-a': [storedEvent('session-a', 'a-1')] },
    eventOutbox: [storedOutbox('a-1', 'session-a')]
  });

  await store.mutateCollections(['eventsBySession', 'eventOutbox'], draft => {
    (draft.eventsBySession as Record<string, unknown[]>)['session-a']!.push(storedEvent('session-a', 'a-2'));
  }, { sessionIds: ['session-a'] });

  const eventLoad = queries.find(({ sql }) => /from agent_cluster\.collaboration_events e join agent_cluster\.sessions s/.test(sql))!;
  const outboxLoad = queries.find(({ sql }) => /from agent_cluster\.event_outbox outbox/.test(sql) && /select/i.test(sql))!;
  assert.match(eventLoad.sql, /s\.external_id\s*=\s*any\(\$1::text\[\]\)/);
  assert.deepEqual(eventLoad.values, [['session-a']]);
  assert.match(outboxLoad.sql, /outbox\.aggregate_external_id\s*=\s*any\(\$1::text\[\]\)/);
  assert.deepEqual(outboxLoad.values, [['session-a']]);
});

test('session-scoped mutations reject writes to another Session and roll back', async () => {
  const { queries, store } = collectionMutationHarness({ eventsBySession: {}, eventOutbox: [] });

  await assert.rejects(store.mutateCollections(['eventsBySession'], draft => {
    (draft.eventsBySession as Record<string, unknown[]>)['session-b'] = [storedEvent('session-b', 'b-1')];
  }, { sessionIds: ['session-a'] }), /COLLECTION_SCOPE_VIOLATION: eventsBySession:session-b/);
  await assert.rejects(store.mutateCollections(['eventOutbox'], draft => {
    (draft.eventOutbox as unknown[]).push(storedOutbox('b-1', 'session-b'));
  }, { sessionIds: ['session-a'] }), /COLLECTION_SCOPE_VIOLATION: eventOutbox:session-b/);

  assert.equal(queries.some(({ sql }) => /insert into agent_cluster\.collaboration_events/i.test(sql)), false);
  assert.equal(queries.filter(({ sql }) => sql === 'rollback').length, 2);
});

function sqlHarness(respond: (sql: string, values?: unknown[]) => unknown[] | undefined) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return { rows: respond(sql, values) ?? [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const codec = { externalize: (value: unknown) => ({ value, contents: [] }), hydrate: (value: unknown) => value };
  return { queries, store: new RelationalStateStore(pool as never, codec as never) };
}

function storedSession(id: string, title = id) {
  return { id, title, status: 'PAUSED', ownerId: 'local-user', dataEpoch: 'epoch', revision: 1,
    participatingAgentIds: [], createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' };
}

function sessionRows(sessions: Array<Record<string, unknown>>) {
  return (sql: string, values?: unknown[]) => {
    if (sql.includes("select metadata->'sourceRecord' value from agent_cluster.sessions")) return sessions.map(value => ({ value }));
    if (/insert into agent_cluster\.sessions .*returning id::text/s.test(sql)) return [{ id: `pk-${values?.[0]}` }];
    if (sql.includes('select id::text from agent_cluster.sessions')) return [{ id: `pk-${values?.[0]}` }];
    return undefined;
  };
}

const sessionUpserts = (queries: Array<{ sql: string; values?: unknown[] }>) =>
  queries.filter(({ sql }) => /insert into agent_cluster\.sessions /.test(sql)).map(({ values }) => values?.[0]);
const sessionSoftDeletes = (queries: Array<{ sql: string; values?: unknown[] }>) =>
  queries.filter(({ sql }) => /update agent_cluster\.sessions set deleted_at=now\(\)/.test(sql));

test('editing one Session writes only that Session and soft-deletes nothing', async () => {
  const { queries, store } = sqlHarness(sessionRows([storedSession('s1'), storedSession('s2'), storedSession('s3')]));

  await store.mutateCollections(['sessions'], draft => {
    (draft.sessions as Array<Record<string, unknown>>)[1]!.title = 'renamed';
  });

  assert.deepEqual(sessionUpserts(queries), ['s2']);
  assert.deepEqual(sessionSoftDeletes(queries), []);
});

test('a Session removed from the collection soft-deletes only that Session', async () => {
  const { queries, store } = sqlHarness(sessionRows([storedSession('s1'), storedSession('s2'), storedSession('s3')]));

  await store.mutateCollections(['sessions'], draft => {
    draft.sessions = (draft.sessions as Array<{ id: string }>).filter(item => item.id !== 's3');
  });

  assert.deepEqual(sessionUpserts(queries), []);
  const softDeletes = sessionSoftDeletes(queries);
  assert.equal(softDeletes.length, 1);
  assert.match(softDeletes[0]!.sql, /external_id = any\(\$1::text\[\]\)/);
  assert.doesNotMatch(softDeletes[0]!.sql, /not \(/);
  assert.deepEqual(softDeletes[0]!.values, [['s3']]);
});

test('the full-collection Session writer keeps soft-deleting Sessions it was not given', async () => {
  const { queries, store } = sqlHarness(sessionRows([]));
  await (store as any).writeSessions({ query: (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    return Promise.resolve({ rows: sessionRows([])(sql, values) ?? [] });
  } }, [storedSession('s1')]);

  const softDeletes = sessionSoftDeletes(queries);
  assert.equal(softDeletes.length, 1);
  assert.match(softDeletes[0]!.sql, /not \(external_id = any\(\$1::text\[\]\)\)/);
  assert.deepEqual(softDeletes[0]!.values, [['s1']]);
});

test('Session lifecycle, stop request and logical operation writes skip unchanged Sessions', async () => {
  const lifecycle = (id: string) => ({ sessionId: id, generation: 1, revision: 1, state: 'active', admission: 'open', stopStatus: 'idle' });
  const stopRequest = (sessionId: string, id: string) => ({ id, sessionId, version: 1, status: 'confirmed',
    createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' });
  const operation = (id: string) => ({ id, stopState: 'confirmed', invocationIds: [] });
  const { queries, store } = sqlHarness((sql, values) => {
    if (sql.includes('from agent_cluster.session_lifecycles l join')) {
      return ['s1', 's2', 's3'].map(external_id => ({ external_id, value: lifecycle(external_id) }));
    }
    if (sql.includes('from agent_cluster.session_stop_requests r join')) {
      return ['s1', 's2'].map(group_id => ({ group_id, value: stopRequest(group_id, `${group_id}-stop-1`) }));
    }
    if (sql.includes('from agent_cluster.logical_operations o join')) {
      return ['s1', 's2'].map(group_id => ({ group_id, value: operation(`${group_id}-op`) }));
    }
    if (sql.includes('select id::text from agent_cluster.sessions')) return [{ id: `pk-${values?.[0]}` }];
    return undefined;
  });

  await store.mutateCollections(['sessionLifecyclesBySession', 'sessionStopRequestsBySession', 'logicalOperationsBySession'], draft => {
    (draft.sessionLifecyclesBySession as Record<string, Record<string, unknown>>).s2!.revision = 2;
    (draft.sessionStopRequestsBySession as Record<string, unknown[]>).s1!.push(stopRequest('s1', 's1-stop-2'));
    ((draft.logicalOperationsBySession as Record<string, Array<Record<string, unknown>>>).s2![0]!).stopState = 'requested';
  });

  const writes = (table: string) => queries.filter(({ sql }) => new RegExp(`insert into agent_cluster\.${table}`).test(sql));
  assert.deepEqual(writes('session_lifecycles').map(({ values }) => values?.[0]), ['pk-s2']);
  assert.deepEqual(writes('session_stop_requests').map(({ values }) => values?.[0]), ['s1-stop-2']);
  assert.deepEqual(writes('logical_operations').map(({ values }) => values?.[0]), ['s2-op']);
});

test('atomic whole-state writes also touch only edited and removed Sessions', async () => {
  const sessions = [storedSession('s1'), storedSession('s2'), storedSession('s3')];
  const respond = sessionRows(sessions);
  const { queries, store } = sqlHarness((sql, values) =>
    /from agent_cluster\.sessions/.test(sql) && /sourceRecord/.test(sql) && !/join/.test(sql)
      ? sessions.map(value => ({ value }))
      : respond(sql, values));
  const loaded = await store.loadState();
  const { computePersistenceRevision } = await import('../postgres-cutover-transaction.js');
  queries.length = 0;

  const next = (loaded.sessions as Array<Record<string, unknown>>)
    .filter(item => item.id !== 's3')
    .map(item => item.id === 's1' ? { ...item, title: 'renamed' } : item);
  await store.writeCollectionsAtomically(computePersistenceRevision(loaded), { sessions: next });

  assert.deepEqual(sessionUpserts(queries), ['s1']);
  const softDeletes = sessionSoftDeletes(queries);
  assert.equal(softDeletes.length, 1);
  assert.deepEqual(softDeletes[0]!.values, [['s3']]);
  assert.equal(queries.at(-1)?.sql, 'commit');
});
