import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillEvents, backfillTasks, deriveActor, runPostgresBackfill } from './backfill-actor-ref.mjs';

test('deriveActor: user_message → user', () => {
  assert.deepEqual(deriveActor({ type: 'user_message' }), { type: 'user', id: 'system' });
});

test('deriveActor: fromAgentId → agent', () => {
  assert.deepEqual(deriveActor({ type: 'agent_message', fromAgentId: 'a1' }), { type: 'agent', id: 'a1' });
});

test('deriveActor: system 事件 → system', () => {
  assert.deepEqual(deriveActor({ type: 'session_status_changed' }), { type: 'system', id: 'system' });
});

test('backfillEvents: 补齐三类样本', () => {
  const eventsBySession = {
    s1: [
      { id: 'e1', type: 'agent_message', fromAgentId: 'a1', actor: { type: 'agent', id: 'existing' } },
      { id: 'e2', type: 'agent_message', fromAgentId: 'a2' },
      { id: 'e3', type: 'session_status_changed' }
    ]
  };
  const stats = backfillEvents(eventsBySession);
  assert.equal(stats.scanned, 3);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.filled, 2);
  assert.equal(eventsBySession.s1[0].actor.id, 'existing');
  assert.deepEqual(eventsBySession.s1[1].actor, { type: 'agent', id: 'a2' });
  assert.deepEqual(eventsBySession.s1[2].actor, { type: 'system', id: 'system' });
});

test('backfillEvents: 幂等,连跑三次结果一致', () => {
  const eventsBySession = {
    s1: [{ id: 'e1', type: 'agent_message', fromAgentId: 'a1' }]
  };
  const a = backfillEvents(eventsBySession);
  const b = backfillEvents(eventsBySession);
  const c = backfillEvents(eventsBySession);
  assert.equal(a.filled, 1);
  assert.equal(b.filled, 0);
  assert.equal(c.filled, 0);
  assert.deepEqual(eventsBySession.s1[0].actor, { type: 'agent', id: 'a1' });
});

test('backfillEvents: 破坏样本 actor.id=wrong 不覆盖', () => {
  const eventsBySession = {
    s1: [{ id: 'e1', type: 'agent_message', fromAgentId: 'a1', actor: { type: 'agent', id: 'wrong' } }]
  };
  const stats = backfillEvents(eventsBySession);
  assert.equal(stats.filled, 0);
  assert.equal(stats.skipped, 1);
  assert.equal(eventsBySession.s1[0].actor.id, 'wrong');
});

test('backfillTasks: 补齐 assignee/assignedBy', () => {
  const tasksBySession = {
    s1: [
      { id: 't1', assigneeAgentId: 'a1', assignedByAgentId: 'coord' },
      { id: 't2', assignee: { type: 'agent', id: 'existing' } },
      { id: 't3' }
    ]
  };
  const stats = backfillTasks(tasksBySession);
  assert.equal(stats.scanned, 3);
  assert.equal(stats.filled, 1);
  assert.equal(stats.skipped, 2);
  assert.deepEqual(tasksBySession.s1[0].assignee, { type: 'agent', id: 'a1' });
  assert.deepEqual(tasksBySession.s1[0].assignedBy, { type: 'agent', id: 'coord' });
  assert.equal(tasksBySession.s1[1].assignee.id, 'existing');
});

test('runPostgresBackfill: dry-run only reads collections', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: [
          { key: 'eventsBySession', value: { s1: [{ type: 'agent_message', fromAgentId: 'a1' }] } },
          { key: 'tasksBySession', value: { s1: [{ assigneeAgentId: 'a1' }] } }
        ]
      };
    }
  };
  const stats = await runPostgresBackfill({ apply: false, pool });
  assert.equal(stats.events.filled, 1);
  assert.equal(stats.tasks.filled, 1);
  assert.equal(calls.length, 1);
});

test('runPostgresBackfill: apply creates backup and updates both collections in one transaction', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql).trim(), params });
      if (String(sql).includes('select key, value')) {
        return {
          rows: [
            { key: 'eventsBySession', value: { s1: [{ type: 'session_status_changed' }] } },
            { key: 'tasksBySession', value: { s1: [{ assignedByAgentId: 'coord' }] } }
          ]
        };
      }
      return { rows: [] };
    }
  };
  const stats = await runPostgresBackfill({ apply: true, pool, tableName: 'agent_cluster_collections' });
  assert.match(stats.backupTable, /^agent_cluster_collections_actor_ref_backup_\d{14}$/);
  assert.ok(calls.some((call) => call.sql === 'begin'));
  assert.ok(calls.some((call) => call.sql.startsWith('create table agent_cluster_collections_actor_ref_backup_')));
  assert.equal(calls.filter((call) => call.sql.startsWith('update agent_cluster_collections')).length, 2);
  assert.ok(calls.some((call) => call.sql === 'commit'));
});
