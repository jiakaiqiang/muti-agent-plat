import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRunResult } from '@agent-cluster/shared';
import { createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { normalizeRuntimeResultContext } from './runtime-result-context-normalizer.js';

function result(output: Record<string, unknown>): AgentRunResult {
  return {
    invocationId: 'invocation',
    runtimeType: 'codex',
    status: 'completed',
    output: output as never,
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence('invocation'),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  };
}

test('preserves strict Runtime output fields without normalization', () => {
  const requestedContext = {
    reason: 'Need source',
    requestedRefs: [{ type: 'workspace_file', label: 'main', ref: 'src/main.ts' }],
    requestedPaths: ['src/main.ts'],
    requestedCommands: [],
    followUpInstruction: null
  };
  const normalized = normalizeRuntimeResultContext(result({
    schemaVersion: '1.0',
    kind: 'task_execution_result',
    status: 'blocked',
    summary: 'Need source',
    completedItems: [],
    changedArtifacts: [],
    agentMessages: [],
    nextSuggestedActions: [],
    risks: [],
    requestedContext
  }));
  assert.deepEqual((normalized.output as { requestedContext: unknown }).requestedContext, requestedContext);

  const withNull = normalizeRuntimeResultContext(result({ requestedContext: null }));
  assert.equal((withNull.output as { requestedContext: unknown }).requestedContext, null);
});

test('does not repair malformed Runtime output but still sanitizes internal error context', () => {
  const malformed = result({
    kind: 'task_execution_result',
    status: 'blocked',
    requestedContext: { requestedRefs: 'not-an-array' }
  });
  malformed.status = 'failed';
  malformed.error = {
    code: 'CONTEXT_INSUFFICIENT',
    message: 'bad request',
    retryable: true,
    requestedContext: { requestedRefs: 'not-an-array' } as never
  };
  const normalized = normalizeRuntimeResultContext(malformed);
  assert.deepEqual((normalized.output as { requestedContext: unknown }).requestedContext, {
    requestedRefs: 'not-an-array'
  });
  assert.equal(normalized.error?.requestedContext, undefined);
});
