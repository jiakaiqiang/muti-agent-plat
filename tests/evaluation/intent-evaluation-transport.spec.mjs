import test from 'node:test';
import assert from 'node:assert/strict';
import {runSerial, withCircuitCooldown} from './intent-evaluation-transport.mjs';

const blocked = (retryAfterMs = 120_000) => ({
  id: 'test', providerCalls: 0, modelOutputSeen: false,
  actual: {reasonCodes: ['INTENT_PROVIDER_CIRCUIT_OPEN']},
  invocations: [{error: {details: {circuitOpen: true, retryAfterMs}}}]
});
const completed = {id: 'test', providerCalls: 1, modelOutputSeen: true, passed: false,
  actual: {reasonCodes: ['INTENT_OUTPUT_INVALID']}};

test('batches run with concurrency one, in order', async () => {
  let active = 0, peak = 0;
  const order = [];
  await runSerial([1, 2, 3], async item => {
    active++; peak = Math.max(active, peak); order.push(item);
    await new Promise(resolve => setImmediate(resolve));
    active--;
  });
  assert.equal(peak, 1);
  assert.deepEqual(order, [1, 2, 3]);
});

test('failed serial batch stops subsequent work', async () => {
  const order = [];
  await assert.rejects(runSerial([1, 2, 3], async item => {
    order.push(item);
    if (item === 2) throw Error('failed');
  }), /failed/);
  assert.deepEqual(order, [1, 2]);
});

test('zero-call circuit waits retryAfterMs and preserves attempts and wait evidence', async () => {
  let time = 0, calls = 0;
  const sleeps = [], audit = [];
  const result = await withCircuitCooldown(async () => ++calls === 1 ? blocked(120_123) : completed, {
    now: () => time,
    sleep: async ms => {sleeps.push(ms); time += ms;},
    persist: async value => audit.push(structuredClone(value))
  });
  assert.deepEqual(sleeps, [60_000, 60_000, 123]);
  assert.equal(calls, 2);
  assert.equal(result.passed, false); // Invalid output is retained, never sampled again.
  assert.equal(result.transport.retryCount, 1);
  assert.equal(result.transport.waitTotalMs, 120_123);
  assert.equal(result.transport.attempts[0].result.providerCalls, 0);
  assert.equal(result.transport.attempts[0].requestedWaitMs, 120_123);
  assert.deepEqual(audit.map(a => a.state), ['waiting', 'retrying', 'finished']);
});

for (const [name, row] of [
  ['provider called but timed out', {...blocked(), providerCalls: 1}],
  ['malformed model output', completed],
  ['model output despite inconsistent zero-call count', {...blocked(), modelOutputSeen: true}],
  ['valid understanding', {...blocked(), actual: {...blocked().actual, understanding: {segments: []}}}],
  ['unrelated zero-call failure', {...blocked(), actual: {reasonCodes: ['CONFIG_ERROR']}}]
]) test(`does not retry: ${name}`, async () => {
  let calls = 0;
  const result = await withCircuitCooldown(async () => {calls++; return row;}, {
    sleep: async () => assert.fail('must not sleep')
  });
  assert.equal(calls, 1);
  assert.equal(result.transport.retryCount, 0);
});

test('missing retryAfterMs does not invent a delay or loop', async () => {
  const result = await withCircuitCooldown(async () => blocked(null), {
    sleep: async () => assert.fail('must not sleep')
  });
  assert.equal(result.transport.stopReason, 'circuit_retry_after_missing');
});

test('repeated circuit blocks have a bounded and recorded retry limit', async () => {
  let time = 0, calls = 0;
  const result = await withCircuitCooldown(async () => {calls++; return blocked(10);}, {
    now: () => time, sleep: async ms => {time += ms;}
  });
  assert.equal(calls, 4);
  assert.equal(result.transport.retryCount, 3);
  assert.equal(result.transport.waitTotalMs, 30);
  assert.equal(result.transport.stopReason, 'circuit_retry_limit');
});
