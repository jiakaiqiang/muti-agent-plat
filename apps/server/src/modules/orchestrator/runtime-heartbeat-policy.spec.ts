import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldEmitHeartbeat } from './runtime-heartbeat-policy.js';

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
