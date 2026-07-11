import test from 'node:test';
import assert from 'node:assert/strict';
import { pickClaudeRunMode } from './claude-code-runtime-adapter.service.js';

function withEnv(value: string | undefined, fn: () => void) {
  const previous = process.env.ENGINEERING_RUNTIME_STREAMING;
  if (value === undefined) delete process.env.ENGINEERING_RUNTIME_STREAMING;
  else process.env.ENGINEERING_RUNTIME_STREAMING = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.ENGINEERING_RUNTIME_STREAMING;
    else process.env.ENGINEERING_RUNTIME_STREAMING = previous;
  }
}

test('pickClaudeRunMode: 未设 env → legacy', () => {
  withEnv(undefined, () => {
    assert.equal(pickClaudeRunMode(), 'legacy');
  });
});

test('pickClaudeRunMode: off → legacy', () => {
  withEnv('off', () => {
    assert.equal(pickClaudeRunMode(), 'legacy');
  });
});

test('pickClaudeRunMode: codex → legacy(不启用 claude 流式)', () => {
  withEnv('codex', () => {
    assert.equal(pickClaudeRunMode(), 'legacy');
  });
});

test('pickClaudeRunMode: all → streaming', () => {
  withEnv('all', () => {
    assert.equal(pickClaudeRunMode(), 'streaming');
  });
});

test('pickClaudeRunMode: 大小写不敏感 ALL → streaming', () => {
  withEnv('ALL', () => {
    assert.equal(pickClaudeRunMode(), 'streaming');
  });
});

test('pickClaudeRunMode: 未知值 → legacy', () => {
  withEnv('bogus', () => {
    assert.equal(pickClaudeRunMode(), 'legacy');
  });
});
