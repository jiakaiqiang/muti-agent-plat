import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionsController } from './sessions.controller.js';

test('stop-state endpoint returns the authoritative Runtime summary envelope', () => {
  const summary = {
    sessionId: 'session-1',
    stopRequestId: 'stop-1',
    version: 2,
    status: 'confirmed',
    requestedCount: 1,
    confirmedCount: 1,
    targets: [],
    blockers: [],
    canResume: true
  };
  const controller = new SessionsController({ stopState: (sessionId: string) => ({ ...summary, sessionId }) } as never);
  const response = controller.stopState('session-1');
  assert.deepEqual(response.data, summary);
});
