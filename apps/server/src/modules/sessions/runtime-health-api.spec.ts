import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionsController } from './sessions.controller.js';

test('health wait API rejects malformed versions/keys before reaching the mutation and returns the same invocation acknowledgement', async () => {
  let calls = 0;
  const controller = new SessionsController({
    runtimeHealthState: () => ({ items: [] }),
    async waitForRuntime(sessionId: string, invocationId: string, body: unknown) { calls++; return { sessionId, invocationId, body }; }
  } as never);
  for (const body of [undefined, {}, { expectedVersion: 0, sessionGeneration: 1, idempotencyKey: 'one' },
    { expectedVersion: 1, sessionGeneration: 1, idempotencyKey: '' }]) {
    await assert.rejects(controller.waitForRuntime('s', 'call', body as never));
  }
  assert.equal(calls, 0);
  const result = await controller.waitForRuntime('s', 'call', { expectedVersion: 1, sessionGeneration: 1, idempotencyKey: 'one' });
  assert.equal(result.data.invocationId, 'call');
  assert.equal(calls, 1);
});
