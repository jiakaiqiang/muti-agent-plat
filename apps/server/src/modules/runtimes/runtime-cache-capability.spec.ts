import assert from 'node:assert/strict';
import test from 'node:test';
import {
  declaredCacheCapability,
  splitPromptForCache,
  usageFromStreamFrame
} from './runtime-cache-capability.js';

test('capability is declared per provider, model and endpoint combination', () => {
  const anthropic = declaredCacheCapability({
    provider: 'anthropic-compatible',
    model: 'claude-sonnet-5',
    endpoint: 'https://api.anthropic.com/v1/messages'
  });
  assert.equal(anthropic.capability, 'supported');

  // A local Ollama endpoint has not told us anything about prompt caching, so
  // the honest answer is unknown rather than a guess in either direction.
  const ollama = declaredCacheCapability({
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
    endpoint: 'http://127.0.0.1:11434/v1/chat/completions'
  });
  assert.equal(ollama.capability, 'unknown');
});

test('an unrecognised model on a supporting provider is unknown, not supported', () => {
  // Capability belongs to the exact combination. Inheriting "supported" from the
  // provider would make us send cache parameters a model may reject.
  const declared = declaredCacheCapability({
    provider: 'anthropic-compatible',
    model: 'some-unreleased-model',
    endpoint: 'https://api.anthropic.com/v1/messages'
  });
  assert.equal(declared.capability, 'unknown');
  assert.equal(declared.sendCacheParameters, false, 'unknown capability must not send cache parameters');
});

test('a declared-unsupported combination still executes normally', () => {
  const declared = declaredCacheCapability({
    provider: 'openai-compatible',
    model: 'gpt-4o-mini',
    endpoint: 'https://example.invalid/v1/chat/completions'
  });

  assert.equal(declared.capability, 'unsupported');
  assert.equal(declared.sendCacheParameters, false);
  assert.equal(declared.blocksExecution, false, 'no cache support is not a reason to refuse the call');
});

test('stable prefix and dynamic tail are split without changing trust level', () => {
  const split = splitPromptForCache({
    systemPrompt: 'You are a reviewer.',
    toolCatalog: '[tool schema]',
    projectRules: 'Follow repo conventions.',
    currentMessage: 'Please review this diff.',
    evidence: 'file contents from the workspace'
  });

  // Stable-first ordering is what makes a provider prefix reusable.
  assert.deepEqual(split.stablePrefix, [
    'You are a reviewer.',
    '[tool schema]',
    'Follow repo conventions.'
  ]);
  assert.deepEqual(split.dynamicTail, ['file contents from the workspace', 'Please review this diff.']);

  // Workspace evidence and user text stay untrusted content regardless of where
  // the split puts them: raising them to system to win a cache hit would be a
  // trust-boundary violation, not an optimisation.
  assert.equal(split.stablePrefix.includes('file contents from the workspace'), false);
  assert.equal(split.stablePrefix.includes('Please review this diff.'), false);
});

test('an empty stable prefix is not padded to reach a cache threshold', () => {
  const split = splitPromptForCache({
    systemPrompt: '',
    toolCatalog: '',
    projectRules: '',
    currentMessage: 'hi',
    evidence: ''
  });

  assert.deepEqual(split.stablePrefix, []);
  assert.equal(split.cacheable, false, 'nothing stable to cache means no cache breakpoint');
});

test('stream frame cache tokens reach usage instead of being dropped', () => {
  // The parsers already produce these counters; before 2C nothing carried them
  // into the settled usage, so every cache read looked like a full-price read.
  const usage = usageFromStreamFrame({
    provider: 'anthropic-compatible',
    model: 'claude-sonnet-5',
    frame: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 50
    }
  });

  assert.equal(usage.cacheReadInputTokens, 900);
  assert.equal(usage.cacheWriteInputTokens, 50);
  assert.equal(usage.logicalInputTokens, 1_000);
  assert.equal(usage.measurement, 'actual');
});

test('a frame with no usage yields unknown measurement rather than zeros', () => {
  const usage = usageFromStreamFrame({
    provider: 'anthropic-compatible',
    model: 'claude-sonnet-5',
    frame: {}
  });

  assert.equal(usage.measurement, 'unknown');
  assert.equal(usage.inputTokens, 0, 'the legacy field stays numeric for compatibility');
  assert.equal(usage.logicalInputTokens, undefined, 'but the normalized view must not claim zero');
});

test('usage never carries prompt text or credentials', () => {
  const usage = usageFromStreamFrame({
    provider: 'anthropic-compatible',
    model: 'claude-sonnet-5',
    frame: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 5 }
  });

  const serialized = JSON.stringify(usage);
  assert.equal(serialized.includes('sk-'), false);
  assert.equal(serialized.includes('prompt'), false);
});
