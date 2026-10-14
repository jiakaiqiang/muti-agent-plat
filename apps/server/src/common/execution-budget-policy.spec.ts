import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeEventObservation, type AgentRuntimeEvent } from '@agent-cluster/shared';
import { ExecutionBudgetHealth as BudgetPolicy } from './execution-budget-policy.js';
import { createRuntimeHealthState, reduceRuntimeHealth } from './runtime-health-policy.js';

// Both assertions and production consume the same normalized health state, not a second error flag.
class ExecutionBudgetHealth {
  private readonly policy: BudgetPolicy;
  private state;
  constructor(deadline: number, private readonly silenceMs: number, _toolMs: number, startedAt: number) {
    this.policy = new BudgetPolicy(deadline);
    this.state = createRuntimeHealthState({ sessionId: 's', operationId: 'op', invocationId: 'call',
      sessionGeneration: 1, observerEpoch: 'test', phase: 'brief_generation', agentId: 'a', runtimeType: 'claude_code',
      startedAt: new Date(startedAt).toISOString(), deadlineAt: new Date(deadline).toISOString() }, startedAt);
  }
  observe(event: AgentRuntimeEvent, now: number) {
    const observation = runtimeEventObservation(event);
    if (observation) this.state = reduceRuntimeHealth(this.state, { type: 'observation', observation: {
      ...this.state.snapshot, ...observation, source: 'runtime', sequence: this.state.lastSequence + 1,
      observedAt: new Date(now).toISOString()
    } }, now, this.silenceMs);
  }
  check(now: number, connected: boolean) {
    this.state = reduceRuntimeHealth(this.state, { type: 'tick', observedAt: new Date(now).toISOString() }, now, this.silenceMs);
    return this.policy.check(now, connected, this.state.snapshot);
  }
}

function output(content = 'new output'): AgentRuntimeEvent {
  return { invocationId: 'call', type: 'runtime_progress', visibility: 'debug',
    content, metadata: { code: 'STREAM_TEXT' }, createdAt: '2026-09-29T00:00:00Z' };
}

test('healthy progress crosses the deadline without renewing the persisted budget', () => {
  const health = new ExecutionBudgetHealth(100, 100, 300, 0);
  health.observe(output(), 90);
  assert.deepEqual(health.check(110, true), { waitMs: 5000 });
  health.observe(output('more output'), 180);
  assert.deepEqual(health.check(200, true), { waitMs: 5000 });
  assert.deepEqual(health.check(280, true), { waitMs: 5000 });
});

test('silence and weak evidence remain unknown instead of killing an active call', () => {
  const health = new ExecutionBudgetHealth(100, 100, 300, 0);
  health.observe(output(), 20);
  health.observe(output(), 90);
  health.observe({ ...output(), metadata: { code: 'RUNTIME_HEARTBEAT' } }, 99);
  health.observe({ ...output(), metadata: { code: 'STREAM_SYSTEM', subtype: 'init' } }, 110);
  assert.deepEqual(health.check(120, true), { waitMs: 5000 });
});

test('upstream errors enable fallback but useful recovery disables it', () => {
  const health = new ExecutionBudgetHealth(100, 100, 300, 0);
  const error = { ...output(), metadata: { code: 'STREAM_SYSTEM', subtype: 'api_error' } };
  health.observe(error, 40);
  assert.deepEqual(health.check(60, true), { waitMs: 40 });
  assert.deepEqual(health.check(100, true), { reason: 'provider_or_tool_error' });
  health.observe(output('recovered output'), 110);
  assert.deepEqual(health.check(120, true), { waitMs: 5000 });
});

test('a disconnected Runtime cannot claim the healthy progress exemption', () => {
  const health = new ExecutionBudgetHealth(100, 100, 300, 0);
  health.observe(output(), 90);
  assert.deepEqual(health.check(110, false), { reason: 'runtime_disconnected' });
});

test('a long running tool remains unknown and a real tool error enables fallback', () => {
  const health = new ExecutionBudgetHealth(100, 100, 300, 0);
  const tool: AgentRuntimeEvent = { ...output(), type: 'tool_called', visibility: 'user',
    metadata: { toolCallId: 'tool-1', name: 'Bash' } };
  health.observe(tool, 80);
  assert.deepEqual(health.check(210, true), { waitMs: 5000 });
  assert.deepEqual(health.check(380, true), { waitMs: 5000 });
  health.observe({ ...tool, type: 'tool_completed', metadata: { ...tool.metadata, isError: true } }, 381);
  assert.deepEqual(health.check(382, true), { reason: 'provider_or_tool_error' });
});

test('all explicit provider retry/error observations enable expired-budget fallback', () => {
  for (const metadata of [
    { code: 'STREAM_SYSTEM', subtype: 'api_retry' },
    { code: 'RUNTIME_REQUEST_OBSERVATION', observationKind: 'provider_retry' },
    { code: 'RUNTIME_REQUEST_OBSERVATION', observationKind: 'provider_error' }
  ]) {
    const health = new ExecutionBudgetHealth(100, 100, 300, 0);
    health.observe({ ...output(), metadata }, 110);
    assert.deepEqual(health.check(120, true), { reason: 'provider_or_tool_error' }, JSON.stringify(metadata));
  }
});

test('new request/acknowledgement, heartbeat and silence cannot erase an unresolved failure', () => {
  const health = new ExecutionBudgetHealth(100, 10, 300, 0);
  health.observe({ ...output(), metadata: { code: 'STREAM_SYSTEM', subtype: 'api_retry' } }, 50);
  for (const observationKind of ['request_started', 'request_acknowledged', 'transport_alive']) {
    health.observe({ ...output(), metadata: { code: 'RUNTIME_REQUEST_OBSERVATION', observationKind } }, 110);
    assert.deepEqual(health.check(120, true), { reason: 'provider_or_tool_error' });
  }
  health.observe(output('recovered'), 130);
  assert.deepEqual(health.check(1000, true), { waitMs: 5000 }, 'recovered then silent is unknown, not the old fault');
});

test('structured output correction has its own allowance, never provider fallback', () => {
  const health = new ExecutionBudgetHealth(100, 10, 300, 0);
  health.observe({ ...output(), type: 'tool_completed', metadata: { name: 'StructuredOutput', isError: true } }, 110);
  assert.deepEqual(health.check(120, true), { waitMs: 5000 });
});
