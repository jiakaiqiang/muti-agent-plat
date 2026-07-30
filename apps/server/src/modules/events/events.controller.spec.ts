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
