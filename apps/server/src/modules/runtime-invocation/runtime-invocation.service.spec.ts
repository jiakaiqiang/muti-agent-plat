import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeInvocationService } from './runtime-invocation.service.js';

test('RuntimeInvocationService resolves, starts and drains a generic invocation', async () => {
  const events: string[] = [];
  const plan = { invocationId: 'invocation-1', pendingApprovals: undefined };
  const service = new RuntimeInvocationService(
    { resolve: () => plan } as never,
    {
      operations: { async begin() { events.push('reserved-operation'); return { id: 'operation' }; } },
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
  assert.deepEqual(events, ['reserved-operation', 'drained']);
});


test('RuntimeInvocationService passes server-owned parent to preserve the message deadline during correction validation', async () => {
  let received: unknown;
  const plan = { invocationId: 'correction-validation', admissionClass: 'routing', dataEpoch: 'epoch' };
  const service = new RuntimeInvocationService({ resolve: () => plan } as never, {
    operations: { async begin(input: unknown) { received = input; return { id: 'correction-op' }; } },
    start: () => ({ events: (async function* () {})(), result: Promise.resolve({ status: 'completed', invocationId: plan.invocationId }) })
  } as never);
  await service.invoke({ operationId: 'correction-op', parentOperationId: 'original-message-op', operationDeadlineAt: '2026-10-19T12:00:00.000Z', sessionId: 's1', phase: 'user_message_routing' } as never);
  assert.equal((received as { parentId: string }).parentId, 'original-message-op');
  assert.equal((received as { admissionClass: string }).admissionClass, 'routing');
  assert.equal((received as { deadlineCeilingAt: string }).deadlineCeilingAt, '2026-10-19T12:00:00.000Z');
});
