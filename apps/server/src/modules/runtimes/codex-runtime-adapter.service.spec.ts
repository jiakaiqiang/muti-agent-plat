import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCodexRunMode } from './codex-runtime-adapter.service.js';

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

test('pickCodexRunMode: 未设 env → legacy', () => {
  withEnv(undefined, () => {
    assert.equal(pickCodexRunMode(), 'legacy');
  });
});

test('pickCodexRunMode: off → legacy', () => {
  withEnv('off', () => {
    assert.equal(pickCodexRunMode(), 'legacy');
  });
});

test('pickCodexRunMode: codex → streaming', () => {
  withEnv('codex', () => {
    assert.equal(pickCodexRunMode(), 'streaming');
  });
});

test('pickCodexRunMode: all → streaming', () => {
  withEnv('all', () => {
    assert.equal(pickCodexRunMode(), 'streaming');
  });
});

test('pickCodexRunMode: 未知值 → legacy', () => {
  withEnv('bogus', () => {
    assert.equal(pickCodexRunMode(), 'legacy');
  });
});
