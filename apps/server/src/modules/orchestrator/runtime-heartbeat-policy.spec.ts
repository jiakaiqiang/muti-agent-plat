import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldEmitHeartbeat } from './runtime-heartbeat-policy.js';

test('shouldEmitHeartbeat: adapter 有 stream 方法 → false', () => {
  const adapter = { type: 'codex', run: async () => ({}) as never, stream: () => ({}) as never };
  assert.equal(shouldEmitHeartbeat(adapter as never), false);
});

test('shouldEmitHeartbeat: adapter 无 stream 方法 → true', () => {
  const adapter = { type: 'mock', run: async () => ({}) as never };
  assert.equal(shouldEmitHeartbeat(adapter as never), true);
});

test('shouldEmitHeartbeat: adapter 为 undefined → true (回退到旧心跳兜底)', () => {
  assert.equal(shouldEmitHeartbeat(undefined), true);
});

test('shouldEmitHeartbeat: adapter.stream 存在但非函数 → true', () => {
  const adapter = { type: 'mock', run: async () => ({}) as never, stream: 'nope' } as unknown;
  assert.equal(shouldEmitHeartbeat(adapter as never), true);
});
