import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRunResult, ExecutionTerminationKind } from '@agent-cluster/shared';
import { createAgentMessageOutput, createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import {
  abortWithTermination,
  createExecutionTermination,
  ensureStructuredTermination,
  normalizeTerminatedResult,
  terminationDisposition,
  terminationErrorCode,
  terminationFromSignal
} from './execution-termination.js';

function termination(kind: ExecutionTerminationKind) {
  return createExecutionTermination({ kind, source: 'system', scope: 'invocation' });
}

test('termination kinds map to stable dispositions and compatibility error codes', () => {
  assert.deepEqual(
    ['user_cancelled', 'user_paused', 'frontend_disconnected', 'runtime_disconnected', 'phase_timeout', 'runtime_timeout', 'service_shutdown', 'superseded', 'maintenance'].map(
      (kind) => [kind, terminationDisposition(termination(kind as ExecutionTerminationKind)), terminationErrorCode(termination(kind as ExecutionTerminationKind))]
    ),
    [
      ['user_cancelled', 'stop', 'RUNTIME_CANCELLED'],
      ['user_paused', 'stop', 'RUNTIME_CANCELLED'],
      ['frontend_disconnected', 'stop', 'RUNTIME_CANCELLED'],
      ['runtime_disconnected', 'stop', 'RUNTIME_CANCELLED'],
      ['phase_timeout', 'retry', 'RUNTIME_TIMEOUT'],
      ['runtime_timeout', 'retry', 'RUNTIME_TIMEOUT'],
      ['service_shutdown', 'stop', 'RUNTIME_CANCELLED'],
      ['superseded', 'replace', 'RUNTIME_CANCELLED'],
      ['maintenance', 'stop', 'RUNTIME_CANCELLED']
    ]
  );
});

test('abortWithTermination preserves the first termination reason', () => {
  const controller = new AbortController();
  const first = termination('superseded');
  const second = termination('user_cancelled');
  assert.equal(abortWithTermination(controller, first), true);
  assert.equal(abortWithTermination(controller, second), false);
  assert.equal(terminationFromSignal(controller.signal)?.terminationId, first.terminationId);
});

test('normalizeTerminatedResult replaces native abort text with safe structured output', () => {
  const result: AgentRunResult = {
    invocationId: 'invocation-1',
    runtimeType: 'codex',
    status: 'cancelled',
    output: createAgentMessageOutput({ messageKind: 'risk', content: 'The operation was aborted' }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence('invocation-1'),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    error: { code: 'RUNTIME_CANCELLED', message: 'The operation was aborted', retryable: false }
  };
  const reason = createExecutionTermination({
    kind: 'phase_timeout',
    source: 'orchestrator',
    scope: 'phase',
    phase: 'discussion',
    timeout: { mode: 'deadline', timeoutMs: 60_000 }
  });
  const normalized = normalizeTerminatedResult(result, reason);
  assert.equal(normalized.status, 'failed');
  assert.equal(normalized.error?.code, 'RUNTIME_TIMEOUT');
  assert.equal(normalized.termination?.kind, 'phase_timeout');
  assert.doesNotMatch(normalized.error?.message ?? '', /operation was aborted/i);
});

test('ensureStructuredTermination classifies adapter watchdog timeouts', () => {
  const result: AgentRunResult = {
    invocationId: 'invocation-timeout',
    runtimeType: 'codex',
    status: 'failed',
    output: createAgentMessageOutput({ messageKind: 'risk', content: 'watchdog timeout' }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence('invocation-timeout'),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    error: {
      code: 'RUNTIME_TIMEOUT',
      message: 'watchdog timeout',
      retryable: true,
      details: { watchdog: 'idle_timeout', thresholdMs: 45_000 }
    }
  };
  const normalized = ensureStructuredTermination(result, { phase: 'task_execution' });
  assert.equal(normalized.termination?.kind, 'runtime_timeout');
  assert.deepEqual(normalized.termination?.timeout, { mode: 'idle', timeoutMs: 45_000 });
});

/**
 * T05 / SRS-AC4, I4. A user-initiated Runtime switch is its own termination
 * reason. It must not be audited as a pause or a cancellation, and above all it
 * must not be retryable: the provider retry chain would otherwise restart the
 * invocation the switch barrier just stopped.
 */
test('a Runtime switch is an audited user stop, never a retryable failure', () => {
  const switched = termination('runtime_switch');
  assert.equal(terminationDisposition(switched), 'stop');
  assert.equal(terminationErrorCode(switched), 'RUNTIME_CANCELLED');

  const result: AgentRunResult = {
    invocationId: 'invocation-switch',
    runtimeType: 'codex',
    status: 'cancelled',
    output: createAgentMessageOutput({ messageKind: 'risk', content: 'The operation was aborted' }),
    events: [],
    artifacts: [],
    systemEvidence: createRuntimeArtifactSystemEvidence('invocation-switch'),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    error: { code: 'RUNTIME_CANCELLED', message: 'The operation was aborted', retryable: false }
  };
  const normalized = normalizeTerminatedResult(
    result,
    createExecutionTermination({
      kind: 'runtime_switch',
      source: 'user',
      scope: 'invocation',
      phase: 'task_execution'
    })
  );

  assert.equal(normalized.status, 'cancelled');
  assert.equal(normalized.error?.retryable, false, 'a switch must not re-enter the provider retry chain');
  assert.equal(normalized.error?.details?.terminationKind, 'runtime_switch');
  assert.equal(
    normalized.error?.details?.terminationSource,
    'user',
    'the audit trail must show the user asked, not that the provider failed'
  );
  assert.doesNotMatch(normalized.error?.message ?? '', /operation was aborted/i);
});

/**
 * A switch reason has to survive a round trip through an AbortSignal, because the
 * stop barrier carries it that way; an unrecognised kind would be dropped and the
 * stop would be re-derived as a plain user cancellation, losing the audit reason.
 */
test('a Runtime switch survives the abort signal round trip', () => {
  const controller = new AbortController();
  const switched = createExecutionTermination({ kind: 'runtime_switch', source: 'user', scope: 'session' });
  assert.equal(abortWithTermination(controller, switched), true);
  const recovered = terminationFromSignal(controller.signal);
  assert.equal(recovered?.kind, 'runtime_switch', 'the guard must accept the new kind');
  assert.equal(recovered?.terminationId, switched.terminationId);
});
