import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollaborationEvent } from '@agent-cluster/shared';
import { firstValueFrom } from 'rxjs';
import { EVENT_PAGE_CACHE_MAX, EventsService } from './events.service.js';

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

test('paged history reads the durable page instead of a stale in-memory event log', async () => {
  const old = { id: 'old', sessionId: 'session-1', type: 'agent_message', toAgentIds: [], content: 'old',
    metadata: { schemaVersion: '0.1', payload: {} }, createdAt: '2026-09-17T00:00:00.000Z' } as CollaborationEvent;
  const current = { ...old, id: 'current', content: 'current' };
  const { service } = makeService([], { 'session-1': [old] });
  const persistence = (service as unknown as { persistence: { readEventPage?: unknown } }).persistence;
  let requestedLimit = 0;
  persistence.readEventPage = async (_sessionId: string, options: { limit: number }) => {
    requestedLimit = options.limit;
    return { items: [current], hasMore: false };
  };
  try {
    const page = await service.listPage('session-1', { limit: 2 });
    assert.deepEqual(page.items.map((item) => item.id), ['current']);
    assert.equal(requestedLimit, 2);
  } finally {
    await service.onModuleDestroy();
  }
});

test('file history keeps only a bounded number of cached pages and invalidates them after an event', async () => {
  const events = Array.from({ length: EVENT_PAGE_CACHE_MAX + 2 }, (_, index) => ({
    id: `event-${index}`, sessionId: 'session-1', type: 'agent_message',
    toAgentIds: [], content: `message-${index}`,
    metadata: { schemaVersion: '0.1', payload: {} }, createdAt: '2026-09-17T00:00:00.000Z'
  })) as CollaborationEvent[];
  const { service } = makeService([], { 'session-1': events });
  const inspect = service as unknown as { pageCache: Map<string, unknown> };
  try {
    for (let index = 0; index <= EVENT_PAGE_CACHE_MAX; index += 1) {
      const page = await service.listPage('session-1', { afterEventId: events[index].id, limit: 1 });
      assert.equal(page.items[0]?.id, events[index + 1]?.id);
    }
    assert.equal(inspect.pageCache.size, EVENT_PAGE_CACHE_MAX);
    const previousLastId = events.at(-1)?.id;
    const previousPenultimateId = events.at(-2)?.id;
    const before = await service.listPage('session-1', { afterEventId: previousLastId, limit: 1 });
    assert.deepEqual(before.items, []);
    const next = service.create({ sessionId: 'session-1', type: 'agent_message', content: 'new message' });
    const after = await service.listPage('session-1', { afterEventId: previousPenultimateId, limit: 2 });
    assert.deepEqual(after.items.map((event) => event.id), [previousLastId, next.id]);
    assert.ok(inspect.pageCache.size <= EVENT_PAGE_CACHE_MAX);
  } finally {
    await service.onModuleDestroy();
  }
});

test('redacting a user message keeps an auditable tombstone and removes executable references', async () => {
  const event: CollaborationEvent = {
    id: 'user-message-to-delete',
    sessionId: 'session-1',
    type: 'user_message',
    actor: { type: 'user', id: 'local-user' },
    toAgentIds: ['coordinator'],
    content: '包含机密附件的原始消息',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'chat_message',
      payload: {
        text: '包含机密附件的原始消息',
        attachmentRefs: [{ id: 'file-1', name: 'secret.txt' }],
        skillRef: { key: 'review', revision: 1, label: 'Review' },
        agentRefs: [{ id: 'agent-1', key: 'reviewer', label: 'Reviewer' }]
      }
    },
    createdAt: '2026-09-22T00:00:00.000Z'
  };
  const { service, calls } = makeService([], { 'session-1': [event] });
  try {
    const first = await service.redactUserMessage('session-1', event.id, ['file-1']);
    assert.equal(first?.alreadyDeleted, false);
    assert.equal(first?.event.content, '消息已删除');
    const tombstone = service.list('session-1')[0];
    assert.equal(tombstone.content, '消息已删除');
    const payload = tombstone.metadata.payload as Record<string, unknown>;
    assert.equal(payload.deleted, true);
    assert.equal(typeof payload.deletedAt, 'string');
    assert.deepEqual(payload.deletedAttachmentIds, ['file-1']);
    assert.equal('attachmentRefs' in payload, false);
    assert.equal('skillRef' in payload, false);
    assert.equal('agentRefs' in payload, false);

    const second = await service.redactUserMessage('session-1', event.id, ['file-1']);
    assert.equal(second?.alreadyDeleted, true);
    assert.equal(calls.replaced, 1);
  } finally {
    await service.onModuleDestroy();
  }
});
