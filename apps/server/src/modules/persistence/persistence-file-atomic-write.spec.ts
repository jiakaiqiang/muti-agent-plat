import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { PersistenceService, replaceFileWithRetry } from './persistence.service.js';

test('file persistence ignores a stale PID temp file and leaves no new temp artifact', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-atomic-write-'));
  const filePath = join(directory, 'state.v3.json');
  const staleTemp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(staleTemp, 'stale interrupted write');
  const persistence = new PersistenceService({ backend: 'file', filePath });
  try {
    await persistence.initialize();
    persistence.setCollection('value', { current: true });
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')).value, { current: true });
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.endsWith('.tmp')),
      [basename(staleTemp)]
    );
  } finally {
    await persistence.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('file persistence retries transient Windows replacement failures without dropping the new state', () => {
  let attempts = 0;
  replaceFileWithRetry('temporary-state', 'state.v3.json', () => {
    attempts += 1;
    if (attempts < 3) {
      throw Object.assign(new Error('destination is temporarily locked'), { code: 'EPERM' });
    }
  }, 4);
  assert.equal(attempts, 3);
});

test('file persistence does not retry non-transient replacement failures', () => {
  let attempts = 0;
  assert.throws(
    () => replaceFileWithRetry('temporary-state', 'state.v3.json', () => {
      attempts += 1;
      throw Object.assign(new Error('invalid destination'), { code: 'EINVAL' });
    }),
    /invalid destination/
  );
  assert.equal(attempts, 1);
});

test('atomic state mutation commits related collections together and rejects a stale revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-domain-mutation-'));
  const filePath = join(directory, 'state.v3.json');
  const persistence = new PersistenceService({ backend: 'file', filePath });
  try {
    await persistence.initialize();
    const revision = persistence.stateRevision();
    await persistence.mutateStateAtomically(revision, (draft) => {
      draft.workItemsBySession = { 'session-1': [{ id: 'work-item-1' }] };
      draft.intentRoutingRecordsBySession = { 'session-1': [{ id: 'routing-1' }] };
    });

    const stored = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(stored.workItemsBySession, { 'session-1': [{ id: 'work-item-1' }] });
    assert.deepEqual(stored.intentRoutingRecordsBySession, { 'session-1': [{ id: 'routing-1' }] });
    await assert.rejects(
      () => persistence.mutateStateAtomically(revision, (draft) => { draft.stale = true; }),
      /PERSISTENCE_REVISION_CONFLICT/
    );
    assert.equal('stale' in persistence.snapshotState(), false);
  } finally {
    await persistence.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('atomic state mutation keeps old in-memory state when durable file replacement fails', async () => {
  const persistence = new PersistenceService({ backend: 'file', filePath: join(tmpdir(), `state-${crypto.randomUUID()}.json`) });
  await persistence.initialize();
  const revision = persistence.stateRevision();
  const writable = persistence as unknown as { writeFileState: () => void };
  writable.writeFileState = () => { throw new Error('forced atomic write failure'); };

  await assert.rejects(
    () => persistence.mutateStateAtomically(revision, (draft) => { draft.value = 'new'; }),
    /forced atomic write failure/
  );
  assert.equal(persistence.snapshotState().value, undefined);
});

test('file event persistence writes and publishes an equivalent durable outbox record', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-file-outbox-'));
  const filePath = join(directory, 'state.v3.json');
  const persistence = new PersistenceService({ backend: 'file', filePath });
  try {
    await persistence.initialize();
    await persistence.setCollection('eventsBySession', {
      'session-1': [{
        id: 'event-1', sessionId: 'session-1', type: 'user_message', toAgentIds: [],
        content: 'hello', metadata: { schemaVersion: '0.1', payload: {} },
        actor: { type: 'user', id: 'user-1' }, createdAt: '2026-08-07T00:00:00.000Z'
      }]
    });
    let stored = JSON.parse(readFileSync(filePath, 'utf8')) as {
      eventsBySession: Record<string, unknown[]>;
      eventOutbox: Array<Record<string, unknown>>;
    };
    assert.equal(stored.eventsBySession['session-1']?.length, 1);
    assert.equal(stored.eventOutbox[0]?.id, 'outbox:event-1');
    assert.equal(stored.eventOutbox[0]?.status, 'pending');

    await persistence.markEventPublished('event-1');
    stored = JSON.parse(readFileSync(filePath, 'utf8')) as typeof stored;
    assert.equal(stored.eventOutbox[0]?.status, 'published');
    assert.equal(stored.eventOutbox[0]?.attempts, 1);
  } finally {
    await persistence.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
  }
});
