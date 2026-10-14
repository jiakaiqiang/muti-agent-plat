import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Pool, type PoolClient } from 'pg';
import type { PersistenceService, PersistedState } from '../src/modules/persistence/persistence.service.js';
import { RelationalStateStore } from '../src/modules/persistence/relational/relational-state-store.js';
import { SessionLifecycleStore } from '../src/modules/runtimes/session-lifecycle-store.js';
import { SessionStopStateStore } from '../src/modules/runtimes/session-stop-state-store.js';

// Replays the three collection transactions a Session delete performs
// (stop request, beginDelete, completeDelete) against a disposable copy of the
// dev database and reports SQL round trips per transaction. It mutates data, so
// it refuses to run unless the target database name ends with `_bench`.
const url = process.env.BENCH_DATABASE_URL;
if (!url) throw new Error('BENCH_DATABASE_URL is required (a disposable *_bench database).');
const database = new URL(url).pathname.replace(/^\//, '');
if (!database.endsWith('_bench')) throw new Error(`Refusing to mutate non-bench database: ${database}`);

const pool = new Pool({ connectionString: url, max: 2 });
let queryCount = 0;
// SQL wall time grouped by the table a statement touches, so the remaining
// cost can be split into SQL versus in-process load/diff/clone work.
let sqlByTable: Record<string, { queries: number; ms: number }> = {};
function tableOf(sql: string) {
  const verb = sql.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? 'other';
  const table = /agent_cluster\.([a-z_]+)/.exec(sql)?.[1];
  return table ? `${verb} ${table}` : verb;
}
// Count only transaction clients checked out by RelationalStateStore. pool.query()
// uses the callback form of connect internally, so that form is passed through.
const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
(pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) => {
  if (args.length) return connect(...args);
  return (connect() as Promise<PoolClient>).then(client => {
    // pg reuses client objects across checkouts; wrap each one only once.
    if ((client as unknown as { counted?: boolean }).counted) return client;
    (client as unknown as { counted?: boolean }).counted = true;
    const query = client.query.bind(client) as (...queryArgs: unknown[]) => unknown;
    (client as unknown as { query: (...queryArgs: unknown[]) => unknown }).query = (...queryArgs: unknown[]) => {
      queryCount += 1;
      const bucket = sqlByTable[tableOf(String(queryArgs[0]))] ??= { queries: 0, ms: 0 };
      bucket.queries += 1;
      const startedAt = performance.now();
      const result = query(...queryArgs) as Promise<unknown> | undefined;
      // The callback form (used by pool.query internally) returns nothing to time.
      return result?.finally(() => { bucket.ms += performance.now() - startedAt; });
    };
    return client;
  });
};

// Loaded state is already externalized, so a passthrough codec measures the SQL
// path without writing to the local content store.
const codec = { externalize: (value: unknown) => ({ value, contents: [] }), hydrate: (value: unknown) => value };
const store = new RelationalStateStore(pool, codec as never);
const persistence = {
  assertWritable() {},
  async mutateCollections<T>(keys: string[], mutator: (draft: PersistedState) => T, scope?: { sessionIds?: string[] }) {
    return (await store.mutateCollections(keys, mutator, scope)).result;
  }
} as unknown as PersistenceService;

const target = await pool.query<{ external_id: string; data_epoch: string | null }>(
  `select s.external_id, s.metadata->'sourceRecord'->>'dataEpoch' data_epoch
     from agent_cluster.sessions s
     left join agent_cluster.session_lifecycles l on l.session_id = s.id
    where s.deleted_at is null and coalesce(l.source_snapshot->'sourceRecord'->>'state', 'active') = 'active'
    order by s.created_at limit 1`
);
const sessionId = target.rows[0]?.external_id;
assert.ok(sessionId, 'bench database has no active Session to delete');
const totals = await pool.query<{ events: string; outbox: string }>(
  `select (select count(*) from agent_cluster.collaboration_events)::text events,
          (select count(*) from agent_cluster.event_outbox)::text outbox`
);

const steps: Array<{ step: string; queries: number; ms: number; sqlMs: number; top: string[] }> = [];
async function measure(step: string, run: () => Promise<unknown>) {
  queryCount = 0;
  sqlByTable = {};
  const startedAt = performance.now();
  await run();
  const buckets = Object.entries(sqlByTable).sort((a, b) => b[1].ms - a[1].ms);
  steps.push({
    step, queries: queryCount, ms: Math.round(performance.now() - startedAt),
    sqlMs: Math.round(buckets.reduce((sum, [, item]) => sum + item.ms, 0)),
    top: buckets.slice(0, 5).map(([name, item]) => `${name}: ${item.queries}q/${Math.round(item.ms)}ms`)
  });
}

const stops = new SessionStopStateStore(persistence);
const lifecycle = new SessionLifecycleStore(persistence);
await measure('stopRequest', () => stops.requestWithEvent(sessionId, 'session_delete'));
await measure('beginDelete', () => lifecycle.beginDelete(sessionId, target.rows[0]?.data_epoch ?? 'bench', `bench-${Date.now()}`));
await measure('completeDelete', () => lifecycle.completeDelete(sessionId));
// Ordinary Session save (touchSession -> setCollection('sessions')): one Session changes.
await measure('saveOneSession', () => store.mutateCollections(['sessions'], draft => {
  const saved = (draft.sessions as Array<Record<string, unknown>>).find(item => item.id === sessionId)!;
  saved.updatedAt = new Date().toISOString();
}));
const sessionsAfter = await pool.query<{ live: string }>(
  `select count(*)::text live from agent_cluster.sessions where deleted_at is null`
);

// Integrity: per-Session sequence numbers stay unique and every event keeps its outbox row.
const integrity = await pool.query<{ duplicate_seq: string; events_without_outbox: string }>(
  `select (select count(*) from (select session_id, session_seq from agent_cluster.collaboration_events
                                  group by 1, 2 having count(*) > 1) d)::text duplicate_seq,
          (select count(*) from agent_cluster.collaboration_events e
            where not exists (select 1 from agent_cluster.event_outbox o
                               where o.external_id = 'outbox:' || e.external_id))::text events_without_outbox`
);
await pool.end();

console.log(JSON.stringify({
  database, sessionId,
  events: Number(totals.rows[0]?.events), outbox: Number(totals.rows[0]?.outbox),
  liveSessionsAfter: Number(sessionsAfter.rows[0]?.live),
  steps,
  totalQueries: steps.reduce((sum, item) => sum + item.queries, 0),
  totalMs: steps.reduce((sum, item) => sum + item.ms, 0),
  duplicateSeq: Number(integrity.rows[0]?.duplicate_seq),
  eventsWithoutOutbox: Number(integrity.rows[0]?.events_without_outbox)
}, null, 2));
