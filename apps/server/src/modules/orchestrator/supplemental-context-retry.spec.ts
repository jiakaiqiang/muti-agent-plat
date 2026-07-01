import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canRetryWithSupplementalContext,
  resolveContextInsufficientMaxRetries
} from './supplemental-context-retry.js';

const requestedContext = {
  requestedRefs: [{ type: 'workspace_file' as const, label: 'apps/server/src/main.ts', ref: 'apps/server/src/main.ts' }],
  reason: 'need main.ts'
};

test('canRetryWithSupplementalContext requires CONTEXT_INSUFFICIENT code', () => {
  assert.equal(
    canRetryWithSupplementalContext('RUNTIME_TIMEOUT', requestedContext, 0, 3),
    false
  );
  assert.equal(canRetryWithSupplementalContext(undefined, requestedContext, 0, 3), false);
});

test('canRetryWithSupplementalContext requires a non-empty requestedContext', () => {
  assert.equal(
    canRetryWithSupplementalContext('CONTEXT_INSUFFICIENT', undefined, 0, 3),
    false
  );
});

test('canRetryWithSupplementalContext allows retry up to but not including the max', () => {
  assert.equal(canRetryWithSupplementalContext('CONTEXT_INSUFFICIENT', requestedContext, 0, 3), true);
  assert.equal(canRetryWithSupplementalContext('CONTEXT_INSUFFICIENT', requestedContext, 1, 3), true);
  assert.equal(canRetryWithSupplementalContext('CONTEXT_INSUFFICIENT', requestedContext, 2, 3), true);
  assert.equal(canRetryWithSupplementalContext('CONTEXT_INSUFFICIENT', requestedContext, 3, 3), false);
  assert.equal(canRetryWithSupplementalContext('CONTEXT_INSUFFICIENT', requestedContext, 99, 3), false);
});

test('canRetryWithSupplementalContext with maxRetries=0 rejects immediately', () => {
  assert.equal(canRetryWithSupplementalContext('CONTEXT_INSUFFICIENT', requestedContext, 0, 0), false);
});

test('resolveContextInsufficientMaxRetries defaults to 3', () => {
  const previous = process.env.AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES;
  delete process.env.AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES;
  try {
    assert.equal(resolveContextInsufficientMaxRetries(), 3);
  } finally {
    if (previous !== undefined) {
      process.env.AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES = previous;
    }
  }
});

test('resolveContextInsufficientMaxRetries respects env override and clamps to non-negative integers', () => {
  const previous = process.env.AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES;
  try {
    process.env.AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES = '5';
    assert.equal(resolveContextInsufficientMaxRetries(), 5);
    process.env.AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES = '0';
    assert.equal(resolveContextInsufficientMaxRetries(), 0);
    process.env.AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES = '-2';
    assert.equal(resolveContextInsufficientMaxRetries(), 3, 'negative falls back to default');
    process.env.AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES = 'nope';
    assert.equal(resolveContextInsufficientMaxRetries(), 3, 'non-numeric falls back to default');
    process.env.AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES = '2.7';
    assert.equal(resolveContextInsufficientMaxRetries(), 2, 'truncates to integer');
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES;
    } else {
      process.env.AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES = previous;
    }
  }
});
