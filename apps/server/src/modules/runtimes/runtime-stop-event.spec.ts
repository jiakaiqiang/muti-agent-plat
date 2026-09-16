import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionStopRequest } from '@agent-cluster/shared';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import type { PersistedState } from '../persistence/persistence.service.js';
import { appendRuntimeStopStateEvent } from './runtime-stop-event.js';

test('runtime stop event idempotency collisions are observable without duplicating the event', () => {
  workspaceMetrics.resetForTests();
  const draft: PersistedState = {};
  const request: SessionStopRequest = {
    id: 'stop-request',
    sessionId: 'session',
    reason: 'user_paused',
    targetInvocationIds: ['invocation'],
    targets: [{
      invocationId: 'invocation',
      operationId: 'operation',
      state: 'waiting',
      updatedAt: '2026-09-15T00:00:00.000Z'
    }],
    version: 1,
    status: 'waiting',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z'
  };
  const original = appendRuntimeStopStateEvent(draft, request);
  request.status = 'confirmed';
  request.targets[0]!.state = 'confirmed';

  const replay = appendRuntimeStopStateEvent(draft, request);

  assert.equal(replay.id, original.id);
  assert.equal((draft.eventsBySession as Record<string, unknown[]>).session.length, 1);
  assert.equal((draft.eventOutbox as unknown[]).length, 1);
  assert.equal(workspaceMetrics.snapshot().series.find(item =>
    item.name === 'runtime_stop_event_idempotency_conflict_total')?.value, 1);
});
