import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeInvocationService } from './runtime-invocation.service.js';

test('RuntimeInvocationService resolves, starts and drains a generic invocation', async () => {
  const events: string[] = [];
  const plan = { invocationId: 'invocation-1', pendingApprovals: undefined };
  const service = new RuntimeInvocationService(
    { resolve: () => plan } as never,
    {
      start() {
        return {
          hasStreamingEvents: true,
          events: (async function* () { events.push('drained'); yield { type: 'progress' }; })(),
          result: Promise.resolve({ status: 'completed', invocationId: 'invocation-1' })
        };
      }
    } as never
  );

  const result = await service.invoke({} as never);
  assert.equal(result.status, 'completed');
  assert.deepEqual(events, ['drained']);
});
