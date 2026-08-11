import assert from 'node:assert/strict';
import test from 'node:test';
import { firstValueFrom } from 'rxjs';
import { EventsService } from './events.service.js';

function makeService() {
  return new EventsService({
    getCollection(_key: string, fallback: unknown) {
      return fallback;
    },
    setCollection() {
      return Promise.resolve(true);
    },
    claimPendingEventOutbox() {
      return Promise.resolve([]);
    },
    markEventPublished() {
      return Promise.resolve();
    },
    flush() {
      return Promise.resolve();
    }
  } as never);
}

test('SSE streams publish persisted events without creating frontend lifecycle signals', async () => {
  const service = makeService();
  try {
    const eventPromise = firstValueFrom(service.stream('session-1'));
    const created = service.create({
      sessionId: 'session-1',
      type: 'agent_message',
      content: 'persisted before publish'
    });
    assert.equal((await eventPromise).id, created.id);
    assert.equal(service.hasSession('session-1'), true);
    service.deleteSession('session-1');
    assert.equal(service.hasSession('session-1'), false);
  } finally {
    await service.onModuleDestroy();
  }
});
