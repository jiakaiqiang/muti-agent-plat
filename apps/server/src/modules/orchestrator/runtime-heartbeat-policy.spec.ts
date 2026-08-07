import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldEmitHeartbeat, shouldSuppressHeartbeat } from './runtime-heartbeat-policy.js';

const adapter = { type: 'codex', run: async () => ({}) as never } as never;

test('streaming handles keep a silent-period heartbeat fallback', () => {
  assert.equal(shouldEmitHeartbeat(adapter, true), true);
});

test('buffered handles receive synthetic heartbeats', () => {
  assert.equal(shouldEmitHeartbeat(adapter, false), true);
});

test('missing adapters receive synthetic heartbeats for failure visibility', () => {
  assert.equal(shouldEmitHeartbeat(undefined, false), true);
});

test('stream capability is supplied by the execution handle, not Adapter shape inspection', () => {
  assert.equal(shouldEmitHeartbeat(adapter), true);
});

const interval = 30_000;

test('recent runtime activity suppresses the heartbeat', () => {
  assert.equal(shouldSuppressHeartbeat(10_000, 0, interval), true);
});

test('a timer tick firing slightly early still emits its heartbeat', () => {
  // Regression: setInterval drift used to swallow a beat, making elapsed
  // seconds jump straight from 180 to 240 with no activity in between.
  assert.equal(shouldSuppressHeartbeat(interval - 5, 0, interval), false);
});

test('a timer tick on schedule emits its heartbeat', () => {
  assert.equal(shouldSuppressHeartbeat(interval, 0, interval), false);
});

test('activity inside the tolerance window still suppresses the heartbeat', () => {
  assert.equal(shouldSuppressHeartbeat(interval - 1_001, 0, interval), true);
});
