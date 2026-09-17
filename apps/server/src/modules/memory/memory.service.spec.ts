import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryService } from './memory.service.js';

test('closed Session admission blocks memory writes and runtime recall while preserving history', () => {
  const lifecycle = {
    contractVersion: 'main-agent-collaboration/v1', sessionId: 'session', dataEpoch: 'epoch-test',
    generation: 1, revision: 1, state: 'active', admission: 'open', stopStatus: 'idle'
  };
  const collections = new Map<string, unknown>([
    ['memoriesBySession', {}],
    ['sessionLifecyclesBySession', { session: lifecycle }]
  ]);
  const service = new MemoryService({
    getCollection: (key: string, fallback: unknown) => collections.get(key) ?? fallback,
    setCollection: (key: string, value: unknown) => { collections.set(key, structuredClone(value)); return Promise.resolve(true); }
  } as never);

  const memory = service.create({ sessionId: 'session', content: 'durable decision', confidence: 1 });
  assert.deepEqual(service.search('session', 'durable'), [memory]);
  collections.set('sessionLifecyclesBySession', {
    session: { ...lifecycle, revision: 2, state: 'deleting', admission: 'closed' }
  });

  assert.deepEqual(service.search('session', 'durable'), []);
  assert.throws(() => service.create({ sessionId: 'session', content: 'late memory' }), /SESSION_ADMISSION_CLOSED/);
  assert.deepEqual(service.list('session'), [memory]);
});
