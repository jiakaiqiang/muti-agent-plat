import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollaborationEvent } from '@agent-cluster/shared';
import { firstValueFrom } from 'rxjs';
import { EventsService } from './events.service.js';

function makeService(
  claimed: Array<Record<string, unknown>> = [],
  persistedEvents: Record<string, CollaborationEvent[]> = {}
) {
  const calls = { appended: [] as Array<{ id: string }>, replaced: 0, discarded: [] as string[], published: [] as string[] };
  const service = new EventsService({
    getCollection(key: string, fallback: unknown) {
      return key === 'eventsBySession' ? persistedEvents : fallback;
    },
    setCollection() {
      calls.replaced += 1;
      return Promise.resolve(true);
    },
    appendEvent(event: { id: string }) {
      calls.appended.push(event);
      return Promise.resolve(true);
    },
    claimPendingEventOutbox() {
      return Promise.resolve(claimed);
    },
    markEventPublished(eventId: string) {
      calls.published.push(eventId);
      return Promise.resolve();
    },
    discardEventOutbox(eventId: string) {
      calls.discarded.push(eventId);
      return Promise.resolve(true);
    },
    flush() {
      return Promise.resolve();
    }
  } as never);
  return { service, calls };
}

test('SSE streams publish persisted events without creating frontend lifecycle signals', async () => {
  const { service, calls } = makeService();
  try {
    const eventPromise = firstValueFrom(service.stream('session-1'));
    const created = service.create({
      sessionId: 'session-1',
      type: 'agent_message',
      content: 'persisted before publish'
    });
    assert.equal((await eventPromise).id, created.id);
    assert.deepEqual(calls.appended.map((event) => event.id), [created.id]);
    assert.equal(calls.replaced, 0);
    assert.equal(service.hasSession('session-1'), true);
    service.deleteSession('session-1');
    assert.equal(calls.replaced, 1);
    assert.equal(service.hasSession('session-1'), false);
  } finally {
    await service.onModuleDestroy();
  }
});

test('outbox recovery discards events whose session is no longer active', async () => {
  const eventId = 'deleted-session-event';
  const { service, calls } = makeService([{
    id: `outbox:${eventId}`,
    payload: { event: { id: eventId, sessionId: 'deleted-session' } }
  }]);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.discarded, [eventId]);
  } finally {
    await service.onModuleDestroy();
  }
});

test('outbox recovery republishes an event committed before the publishing process exited', async () => {
  const event: CollaborationEvent = {
    id: 'committed-stop-event',
    sessionId: 'session-1',
    type: 'runtime_progress',
    actor: { type: 'system', id: 'runtime' },
    toAgentIds: [],
    content: '执行已停止。',
    metadata: {
      schemaVersion: '0.1',
      idempotencyKey: 'runtime-stop:request-1:2',
      payload: { code: 'RUNTIME_STOP_STATE_CHANGED', stopRequestId: 'request-1', version: 2 }
    },
    createdAt: '2026-09-15T00:00:00.000Z'
  };
  const { service, calls } = makeService([{
    id: `outbox:${event.id}`,
    payload: { event }
  }], { [event.sessionId]: [event] });
  try {
    const recovered = firstValueFrom(service.stream(event.sessionId));
    assert.equal((await recovered).id, event.id);
    assert.deepEqual(calls.published, [event.id]);
    assert.deepEqual(service.list(event.sessionId).map(item => item.id), [event.id]);
  } finally {
    await service.onModuleDestroy();
  }
});
