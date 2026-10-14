import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeHealthState, reduceRuntimeHealth } from './runtime-health-policy.js';

const identity = { sessionId: 's', invocationId: 'i', operationId: 'o', sessionGeneration: 1, observerEpoch: 'e' };
const initial = () => createRuntimeHealthState({ ...identity, phase: 'brief_generation', agentId: 'a',
  runtimeType: 'claude_code', startedAt: new Date(0).toISOString(), deadlineAt: new Date(300).toISOString() }, 0);
const observe = (state: ReturnType<typeof initial>, kind: string, sequence: number, now: number,
  extra: Record<string, unknown> = {}) => reduceRuntimeHealth(state, { type: 'observation', observation: {
    ...identity, kind, sequence, observedAt: new Date(now).toISOString(), source: 'test', ...extra
  } } as Parameters<typeof reduceRuntimeHealth>[1], now, 100);

test('silence and elapsed budget retain the original invocation indefinitely', () => {
  let state = initial();
  for (const now of [101, 600_000, 1_800_000, 86_400_000]) {
    state = reduceRuntimeHealth(state, { type: 'tick', observedAt: new Date(now).toISOString() }, now, 100);
    assert.equal(state.snapshot.stage, 'unknown_wait');
    assert.equal(state.snapshot.health, 'unknown');
    assert.equal(state.snapshot.invocationId, 'i');
    assert.equal(state.snapshot.deadlineAt, new Date(300).toISOString());
  }
});

test('thinking is optional and heartbeat/process/request acknowledgement are weak evidence', () => {
  for (const kind of ['text_progress', 'tool_input_progress', 'tool_progress', 'reasoning_progress']) {
    assert.equal(observe(initial(), kind, 1, 50).snapshot.health, 'progressing');
  }
  for (const kind of ['transport_alive', 'request_acknowledged', 'probe_result']) {
    const state = observe(initial(), kind, 1, 99, { processStatus: 'alive', requestStatus: 'pending' });
    assert.equal(reduceRuntimeHealth(state, { type: 'tick', observedAt: new Date(200).toISOString() }, 200, 100).snapshot.stage, 'unknown_wait');
  }
});

test('retransmits are ignored but different identical-text events are legitimate progress', () => {
  const first = observe(initial(), 'text_progress', 1, 10, { eventId: 'block:1', count: 1 });
  const replay = observe(first, 'text_progress', 2, 80, { eventId: 'block:1', count: 1 });
  assert.equal(replay.lastProgressMono, 10);
  const second = observe(replay, 'text_progress', 3, 90, { eventId: 'block:2', count: 1 });
  assert.equal(second.lastProgressMono, 90);
});

test('empty or invalid progress counts do not manufacture activity', () => {
  for (const count of [0, -1, NaN, Infinity]) {
    const state = observe(initial(), 'reasoning_progress', 1, 99, { count });
    assert.equal(state.lastProgressMono, 0);
    assert.equal(state.snapshot.health, 'unknown');
  }
});

test('retry is not progress; genuine progress recovers, stale identity is ignored', () => {
  const retry = observe(initial(), 'provider_retry', 1, 50);
  assert.equal(retry.snapshot.stage, 'retrying');
  assert.equal(retry.lastProgressMono, 0);
  assert.equal(observe(retry, 'text_progress', 2, 60).snapshot.health, 'progressing');
  assert.equal(observe(retry, 'text_progress', 2, 60, { sessionGeneration: 2 }), retry);
});

test('wait acknowledgement does not renew progress, stop and terminal win over late activity', () => {
  let state = reduceRuntimeHealth(initial(), { type: 'tick', observedAt: new Date(200).toISOString() }, 200, 100);
  state = reduceRuntimeHealth(state, { type: 'wait', observedAt: new Date(210).toISOString() }, 210, 100);
  assert.equal(state.lastProgressMono, 0);
  assert.equal(state.snapshot.stage, 'unknown_wait');
  state = observe(state, 'stop_requested', 1, 220);
  assert.equal(observe(state, 'text_progress', 2, 230).snapshot.stage, 'stopping');
  state = observe(state, 'terminal_received', 3, 240);
  assert.equal(observe(state, 'reasoning_progress', 4, 250).snapshot.stage, 'terminal');
});

test('known upstream failure survives silence, unsupported probes and request acknowledgement', () => {
  let state = observe(initial(), 'provider_retry', 1, 150);
  state = reduceRuntimeHealth(state, { type: 'tick', observedAt: new Date(200).toISOString() }, 200, 100);
  assert.equal(state.snapshot.health, 'abnormal');
  state = observe(state, 'probe_result', 2, 210, { probeStatus: 'unsupported' });
  assert.equal(state.snapshot.health, 'abnormal');
  state = observe(state, 'request_acknowledged', 3, 220);
  assert.equal(state.snapshot.stage, 'retrying');
  assert.equal(state.snapshot.reasonCode, 'provider_retry');
  assert.equal(state.lastProgressMono, 0);
});

test('probe liveness and a late tool result cannot erase provider failure; a new model action can', () => {
  let state = observe(initial(), 'provider_retry', 1, 10, { failure: { code: 'rate_limit', httpStatus: 429 } });
  for (const [index, probeStatus] of ['ok', 'timeout', 'unsupported'].entries()) {
    state = observe(state, 'probe_result', index + 2, 20 + index, { probeStatus, processStatus: 'alive' });
    assert.equal(state.snapshot.health, 'abnormal');
    assert.equal(state.snapshot.failure?.httpStatus, 429);
  }
  state = observe(state, 'tool_completed', 5, 30, { toolCallId: 'old-tool' });
  assert.equal(state.snapshot.health, 'abnormal');
  state = observe(state, 'tool_started', 6, 40, { toolCallId: 'new-model-tool' });
  assert.equal(state.snapshot.health, 'progressing');
  assert.equal(state.snapshot.failure, undefined);
});

test('format correction is retained until valid submission and confirmed exited probes are not unknown', () => {
  let state = observe(initial(), 'output_contract_error', 1, 10, { failure: { code: 'output_contract' } });
  state = observe(state, 'text_progress', 2, 20);
  assert.equal(state.snapshot.reasonCode, 'output_contract_error');
  state = observe(state, 'submission_accepted', 3, 30);
  assert.equal(state.snapshot.health, 'progressing');
  state = observe(state, 'probe_result', 4, 40, { probeStatus: 'ok', processStatus: 'exited' });
  assert.equal(state.snapshot.health, 'abnormal');
  assert.equal(state.snapshot.failure?.code, 'process_exited');
  assert.notEqual(state.snapshot.stage, 'terminal', 'an exited process probe is not a trusted business result');
  state = observe(state, 'text_progress', 5, 50);
  state = observe(state, 'output_contract_error', 6, 60);
  state = observe(state, 'probe_result', 7, 70, { probeStatus: 'ok', processStatus: 'alive' });
  assert.equal(state.snapshot.health, 'abnormal');
  assert.equal(state.snapshot.failure?.code, 'process_exited');
  assert.equal(state.snapshot.processStatus, 'exited');
});

test('late tool errors cannot replace a provider fault; connection loss wins over unrelated faults', () => {
  let state = observe(initial(), 'provider_retry', 1, 10, { failure: { code: 'rate_limit', httpStatus: 429 } });
  state = observe(state, 'tool_error', 2, 20, { failure: { code: 'tool_error' } });
  assert.equal(state.snapshot.reasonCode, 'provider_retry');
  state = observe(state, 'control_disconnected', 3, 30, { failure: { code: 'control_disconnected' } });
  state = observe(state, 'output_contract_error', 4, 40, { failure: { code: 'output_contract' } });
  state = observe(state, 'text_progress', 5, 50);
  assert.equal(state.snapshot.reasonCode, 'control_disconnected');
  assert.equal(state.snapshot.health, 'abnormal');
});
