import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeStreamFrame } from './runtime-stream-frame.js';
import { runtimeUsageFromFrames } from './usage-from-frames.js';

const resultFrame = (usage: RuntimeStreamFrame extends { kind: 'result' } ? never : Record<string, number>): RuntimeStreamFrame =>
  ({ kind: 'result', payload: {}, usage }) as RuntimeStreamFrame;

test('claude result usage keeps cache reads separate from the uncached input', () => {
  // Claude reports input_tokens as the uncached remainder; the parser already
  // surfaces cache_read/cache_creation as their own counters. Before this the
  // runner read inputTokens/outputTokens and dropped the rest.
  const usage = runtimeUsageFromFrames(
    [resultFrame({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 900, cacheWriteInputTokens: 50 })],
    { provider: 'anthropic-compatible', model: 'claude_code' }
  );

  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.cacheReadInputTokens, 900);
  assert.equal(usage.cacheWriteInputTokens, 50);
  assert.equal(usage.logicalInputTokens, 1_000, 'the model read the cached prefix too');
  assert.equal(usage.measurement, 'actual');
  assert.equal(usage.model, 'claude_code');
});

test('codex usage treats cached tokens as a subset of the reported input', () => {
  const usage = runtimeUsageFromFrames(
    [{ kind: 'usage', usage: { inputTokens: 1_000, outputTokens: 24, cacheReadInputTokens: 900 } }],
    { provider: 'openai-compatible', model: 'codex' }
  );

  assert.equal(usage.inputTokens, 1_000);
  assert.equal(usage.cacheReadInputTokens, 900);
  assert.equal(usage.logicalInputTokens, 1_000, 'must not re-add a subset onto its own total');
  assert.equal(usage.totalTokens, 1_024);
});

test('the last usage frame wins because codex reports cumulative totals', () => {
  const usage = runtimeUsageFromFrames(
    [
      { kind: 'usage', usage: { inputTokens: 10, outputTokens: 1 } },
      { kind: 'usage', usage: { inputTokens: 42, outputTokens: 24 } },
      resultFrame({ inputTokens: 5, outputTokens: 5 })
    ],
    { provider: 'openai-compatible', model: 'codex' }
  );

  assert.equal(usage.inputTokens, 42);
  assert.equal(usage.outputTokens, 24);
});

test('a result frame is used when no usage frame arrived', () => {
  const usage = runtimeUsageFromFrames([resultFrame({ inputTokens: 42, outputTokens: 24 })], {
    provider: 'openai-compatible',
    model: 'codex'
  });

  assert.equal(usage.inputTokens, 42);
  assert.equal(usage.totalTokens, 66);
  assert.equal(usage.measurement, 'actual');
});

test('no usage anywhere is unknown, not a free call', () => {
  const usage = runtimeUsageFromFrames(
    [{ kind: 'assistant_text', text: 'hi' }, { kind: 'result', payload: {} } as RuntimeStreamFrame],
    { provider: 'anthropic-compatible', model: 'claude_code' }
  );

  assert.equal(usage.measurement, 'unknown');
  assert.equal(usage.inputTokens, 0, 'legacy numeric field stays 0 for compatibility');
  assert.equal(usage.logicalInputTokens, undefined, 'but nothing claims the call was measured');
  assert.equal(usage.cacheReadInputTokens, undefined);
});

test('a zero cache counter is a reported zero, not an absence', () => {
  // The codex stub emits cachedInputTokens: 0. That is the provider saying "no
  // cache hit", which is different from saying nothing.
  const usage = runtimeUsageFromFrames(
    [{ kind: 'usage', usage: { inputTokens: 42, outputTokens: 24, cacheReadInputTokens: 0 } }],
    { provider: 'openai-compatible', model: 'codex' }
  );

  assert.equal(usage.cacheReadInputTokens, 0);
  assert.equal(usage.measurement, 'actual');
});
