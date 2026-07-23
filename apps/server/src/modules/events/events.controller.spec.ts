import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollaborationEvent } from '@agent-cluster/shared';
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
