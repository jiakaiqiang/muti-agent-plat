import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedConsultations } from './bounded-consultation.js';

test('a thrown consultation stops scheduling and settles already started peers before returning', async () => {
  const started: number[] = [];
  let peerDone = false;
  await assert.rejects(boundedConsultations([0, 1, 2], 2, async value => {
    started.push(value);
    if (value === 0) throw new Error('required opinion failed');
    await new Promise(resolve => setTimeout(resolve, 10));
    peerDone = true;
    return value;
  }, () => false), /required opinion/);
  assert.deepEqual(started, [0, 1]);
  assert.equal(peerDone, true);
});

test('read-only consultation concurrency is bounded and merge order is stable', async () => {
  let active = 0;
  let maximum = 0;
  const results = await boundedConsultations([30, 1, 5, 1], 2, async value => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, value));
    active--;
    return value;
  }, () => false);
  assert.equal(maximum, 2);
  assert.deepEqual(results, [30, 1, 5, 1]);
});

test('default sequential consultations stop before scheduling later roles after a required opinion fails', async () => {
  const calls: string[] = [];
  await boundedConsultations(['requirements', 'architecture', 'development'], 1, async role => {
    calls.push(role);
    return role !== 'requirements';
  }, result => !result);
  assert.deepEqual(calls, ['requirements']);
});
