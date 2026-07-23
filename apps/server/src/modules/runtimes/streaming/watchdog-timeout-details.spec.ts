import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWatchdogTimeoutDetails, summarizeStderrTail } from './watchdog-timeout-details.js';
import { makeInvocationPlan } from '../invocation-plan.fixture.js';

test('buildWatchdogTimeoutDetails returns production observability fields', () => {
  const details = buildWatchdogTimeoutDetails({
    runtimeType: 'codex',
    input: makeInvocationPlan({
      invocationId: 'run-1',
      sessionId: 'session-1',
      phase: 'task_execution',
      agent: { agentId: 'a1', key: 'backend', name: 'Backend', role: 'backend', systemPrompt: '' },
      executionTarget: { runtimeType: 'codex' }
    }),
    observation: {
      reason: 'idle',
      thresholdMs: 600_000,
      startedAtMs: 1_000,
      lastActivityAtMs: 2_000,
      timedOutAtMs: 602_000,
      elapsedMs: 601_000,
      idleForMs: 600_000,
      firstFrameSeen: true
    },
    stderrTail: '\u001b[31mtemporary warning\u001b[0m'
  });

  assert.equal(details.runtimeType, 'codex');
  assert.equal(details.invocationId, 'run-1');
  assert.equal(details.phase, 'task_execution');
  assert.equal(details.thresholdMs, 600_000);
  assert.equal(details.lastActivityAt, new Date(2_000).toISOString());
  assert.equal(details.stderrTailSummary, 'temporary warning');
});

test('summarizeStderrTail limits persisted diagnostic text', () => {
  const summary = summarizeStderrTail('x'.repeat(1_100));
  assert.equal(summary?.length, 1_000);
});

test('summarizeStderrTail redacts common credential forms', () => {
  const summary = summarizeStderrTail([
    'Authorization: Bearer bearer-secret-value',
    'api_key=sk-supersecretvalue',
    'password: hunter2',
    'safe warning remains visible'
  ].join('\n'));
  assert.doesNotMatch(summary ?? '', /bearer-secret-value|supersecretvalue|hunter2/);
  assert.match(summary ?? '', /\[REDACTED\]/);
  assert.match(summary ?? '', /safe warning remains visible/);
});
