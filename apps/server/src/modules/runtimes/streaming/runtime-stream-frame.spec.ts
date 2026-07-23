import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAssistantTextFrame,
  isRuntimeActivityFrame,
  isResultFrame,
  isStderrTailFrame,
  isSystemFrame,
  isToolResultFrame,
  isToolUseFrame,
  type RuntimeStreamFrame
} from './runtime-stream-frame.js';

test('RuntimeStreamFrame guards discriminate all six kinds', () => {
  const frames: RuntimeStreamFrame[] = [
    { kind: 'assistant_text', text: 'hi' },
    { kind: 'tool_use', toolCallId: 't1', tool: 'read_file', input: { path: 'x' } },
    {
      kind: 'tool_result',
      toolCallId: 't1',
      tool: 'read_file',
      output: 'file body',
      isError: false
    },
    { kind: 'result', payload: { ok: true }, usage: { inputTokens: 1, outputTokens: 2 }, cliSessionId: 's1' },
    { kind: 'system', subtype: 'init', raw: {}, disposition: 'debug_only' },
    { kind: 'stderr_tail', text: 'warn' }
  ];

  assert.equal(frames.filter(isAssistantTextFrame).length, 1);
  assert.equal(frames.filter(isToolUseFrame).length, 1);
  assert.equal(frames.filter(isToolResultFrame).length, 1);
  assert.equal(frames.filter(isResultFrame).length, 1);
  assert.equal(frames.filter(isSystemFrame).length, 1);
  assert.equal(frames.filter(isStderrTailFrame).length, 1);
});

test('narrowing preserves specific fields via type guard', () => {
  const frame: RuntimeStreamFrame = {
    kind: 'result',
    payload: { summary: 'done' },
    cliSessionId: 'abc'
  };
  if (!isResultFrame(frame)) {
    assert.fail('guard should recognize result frame');
  }
  // 类型窄化后可直接访问 result 独有字段
  assert.equal(frame.cliSessionId, 'abc');
  const payload = frame.payload as { summary: string };
  assert.equal(payload.summary, 'done');
});

test('tool_use frame carries toolCallId for pairing with tool_result', () => {
  const use: RuntimeStreamFrame = {
    kind: 'tool_use',
    toolCallId: 'call-42',
    tool: 'write_file',
    input: { path: 'a.ts', contents: 'x' }
  };
  const result: RuntimeStreamFrame = {
    kind: 'tool_result',
    toolCallId: 'call-42',
    tool: 'write_file',
    output: 'ok'
  };
  if (!isToolUseFrame(use) || !isToolResultFrame(result)) {
    assert.fail('guards should recognize tool frames');
  }
  assert.equal(use.toolCallId, result.toolCallId);
});

test('assistant_text supports incremental delta accumulation', () => {
  const deltas: RuntimeStreamFrame[] = [
    { kind: 'assistant_text', text: '你' },
    { kind: 'assistant_text', text: '好' },
    { kind: 'assistant_text', text: '世界' }
  ];
  const merged = deltas.filter(isAssistantTextFrame).map((f) => f.text).join('');
  assert.equal(merged, '你好世界');
});

test('system frame preserves unknown subtype for forward compatibility', () => {
  const frame: RuntimeStreamFrame = {
    kind: 'system',
    subtype: 'future_event_kind',
    raw: { anything: 1 },
    disposition: 'debug_only'
  };
  if (!isSystemFrame(frame)) {
    assert.fail('guard should recognize system frame');
  }
  assert.equal(frame.subtype, 'future_event_kind');
});

test('diagnostic frames do not count as invocation activity', () => {
  assert.equal(
    isRuntimeActivityFrame({
      kind: 'system',
      subtype: 'account/rateLimits/updated',
      raw: {},
      disposition: 'debug_only'
    }),
    false
  );
  assert.equal(isRuntimeActivityFrame({ kind: 'stderr_tail', text: 'retrying' }), false);
  assert.equal(isRuntimeActivityFrame({ kind: 'assistant_text', text: 'working' }), true);
  assert.equal(isRuntimeActivityFrame({ kind: 'usage', usage: { inputTokens: 1 } }), true);
});
