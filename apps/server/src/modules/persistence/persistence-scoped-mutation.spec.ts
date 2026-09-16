import assert from 'node:assert/strict';
import test from 'node:test';
import { PersistenceService, type PersistedState } from './persistence.service.js';

function fixture() {
  const service = new PersistenceService({ enabled: true, backend: 'postgres' });
  const internals = service as any;
  let database: PersistedState = { sessions: [{ id: 's', title: 'before', status: 'FAILED' }] };
  internals.state = structuredClone(database);
  internals.pool = {};
  const store = {
    async mutateCollections<T>(keys: string[], mutate: (draft: PersistedState) => T) {
      const draft = structuredClone(Object.fromEntries(keys.map(key => [key, database[key]])));
      const result = mutate(draft);
      database = { ...database, ...draft };
      return { state: draft, result };
    }
  };
  internals.relationalStore = store;
  return { service, store, database: () => database };
}

test('scoped commit keeps a local update queued before the transaction starts and a later local update', async () => {
  const { service, database } = fixture();
  const transaction = service.mutateCollections(['sessions'], draft => {
    (draft.sessions as any[])[0].status = 'AGENT_DISCUSSING';
  });
  const sessions = service.getCollection<any[]>('sessions', []);
  sessions[0].title = 'latest title';
  const localWrite = service.setCollection('sessions', sessions);
  await Promise.all([transaction, localWrite]);
  assert.deepEqual(service.getCollection('sessions', []), [{ id: 's', title: 'latest title', status: 'AGENT_DISCUSSING' }]);
  assert.deepEqual(database().sessions, service.getCollection('sessions', []));
});

test('consecutive scoped transactions retain the newest committed value', async () => {
  const { service } = fixture();
  await Promise.all(['AGENT_DISCUSSING', 'EXECUTING'].map(status => service.mutateCollections(['sessions'], draft => {
    (draft.sessions as any[])[0].status = status;
  })));
  assert.equal(service.getCollection<any[]>('sessions', [])[0].status, 'EXECUTING');
});

test('only serialization and deadlock errors retry, with a three-attempt limit', async () => {
  const { service, store } = fixture();
  let attempts = 0;
  const original = store.mutateCollections.bind(store);
  store.mutateCollections = async (...args) => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error('serialization'), { code: '40001' });
    return original(...args);
  };
  await service.mutateCollections(['sessions'], draft => { (draft.sessions as any[])[0].title = 'committed'; });
  assert.equal(attempts, 3);
  for (const [code, expected] of [['40P01', 3], ['23505', 1]] as const) {
    attempts = 0;
    store.mutateCollections = async () => { attempts++; throw Object.assign(new Error(code), { code }); };
    await assert.rejects(service.mutateCollections(['sessions'], () => {}), new RegExp(String(code)));
    assert.equal(attempts, expected);
    assert.equal(service.getCollection<any[]>('sessions', [])[0].title, 'committed');
  }
});

test('scoped file mutations reject async callbacks and out-of-scope writes, and roll back failed durability', async () => {
  const service = new PersistenceService({ enabled: true, backend: 'file' });
  const internals = service as any;
  internals.state = { sessions: [{ id: 's', title: 'before' }] };
  internals.writeFileState = () => { throw new Error('disk write failed'); };
  await assert.rejects(service.mutateCollections(['sessions'], draft => { (draft.sessions as any[])[0].title = 'after'; }), /disk write failed/);
  await assert.rejects(service.mutateCollections(['sessions'], async () => {}), /MUST_BE_SYNCHRONOUS/);
  await assert.rejects(service.mutateCollections(['sessions'], draft => { draft.eventOutbox = []; }), /OUTSIDE_SCOPE/);
  assert.equal(service.getCollection<any[]>('sessions', [])[0].title, 'before');
});
