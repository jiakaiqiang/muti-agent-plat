import assert from 'node:assert/strict';
import test from 'node:test';
import { NEVER } from 'rxjs';
import { SKIP_PERSISTENCE_COMMIT } from '../persistence/skip-persistence-commit.js';
import type { CollaborationEvent } from '@agent-cluster/shared';
import { EventsController } from './events.controller.js';
import { shouldExposeCollaborationEvent } from './public-event-filter.js';

function event(type: CollaborationEvent['type'], code?: string): CollaborationEvent {
  return {
    id: 'event-1',
    sessionId: 'session-1',
    type,
    toAgentIds: [],
    content: code === 'STREAM_TEXT' ? '"mentionedAgentIds":[]' : 'visible',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'system_notice',
      payload: code ? { code } : {}
    },
    createdAt: new Date().toISOString()
  };
}

test('event API boundary hides persisted provider output deltas', () => {
  assert.equal(shouldExposeCollaborationEvent(event('runtime_progress', 'STREAM_TEXT')), false);
});

test('event API boundary keeps ordinary collaboration events visible', () => {
  assert.equal(shouldExposeCollaborationEvent(event('agent_message')), true);
});

test('event API boundary hides Receiver Runtime lifecycle events from collaboration', () => {
  const routingEvent = event('runtime_started');
  routingEvent.metadata.payload = { phase: 'user_message_routing' };
  assert.equal(shouldExposeCollaborationEvent(routingEvent), false);
});

test('SSE controller delegates response header management to Nest', () => {
  const controller = new EventsController({ hasSession: () => true, stream: () => NEVER } as never);
  assert.doesNotThrow(() => controller.stream('session-1'));
  assert.equal(Reflect.getMetadata(SKIP_PERSISTENCE_COMMIT, EventsController.prototype.stream), true);
});

test('SSE controller rejects unknown Sessions before allocating a stream', () => {
  const controller = new EventsController({ hasSession: () => false, stream: () => NEVER } as never);
  assert.throws(() => controller.stream('missing-session'), /Session not found/);
});

test('history is served in bounded cursor pages instead of one full-log load when a limit is requested', async () => {
  const log = Array.from({ length: 1_000 }, (_, index) => ({ ...event('agent_message'), id: `event-${index}` }));
  const service = {
    list: (_sessionId: string, afterEventId?: string) => {
      if (!afterEventId) return log;
      const index = log.findIndex((item) => item.id === afterEventId);
      return index >= 0 ? log.slice(index + 1) : log;
    },
    listPage(sessionId: string, options: { afterEventId?: string; limit?: number }) {
      const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 200)));
      const remaining = this.list(sessionId, options.afterEventId);
      const items = remaining.slice(0, limit);
      const hasMore = remaining.length > items.length;
      return { items, hasMore, ...(hasMore && items.length ? { nextCursor: items[items.length - 1].id } : {}) };
    }
  };
  const controller = new EventsController(service as never);

  const first = (await controller.list('session-1', undefined, '50')).data as { items: unknown[]; hasMore: boolean; nextCursor?: string };
  assert.equal(first.items.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, 'event-49');

  const capped = (await controller.list('session-1', undefined, '100000')).data as { items: unknown[] };
  assert.equal(capped.items.length, 500, 'a client cannot request the whole log through limit');

  const legacy = (await controller.list('session-1')).data as { items: unknown[]; hasMore: boolean };
  assert.equal(legacy.items.length, 1_000, 'without limit the historical whole-log shape is preserved');
  assert.equal(legacy.hasMore, false);
});
