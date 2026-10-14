import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeEventObservation } from './runtime-observation.js';
import { ClaudeStreamJsonParser } from './runtime-streaming/claude-stream-json-parser.js';
import { frameToRuntimeEvent } from './runtime-streaming/frame-to-runtime-event.js';
import { normalizeRuntimeFailureDetails, normalizeRuntimeHealthSnapshot, unknownRuntimeHealthCapabilities } from './runtime-request-health.js';
import type { AgentRuntimeEvent } from './contracts.js';
const event = (metadata: Record<string, unknown>): AgentRuntimeEvent => ({ invocationId: 'i', type: 'runtime_progress',
  visibility: 'debug', content: '', createdAt: '2026-09-29T00:00:00Z', metadata });

test('Claude retry and error frames normalize to explicit faults with safe native diagnostics', () => {
  for (const subtype of ['api_retry', 'api_error']) {
    const parser = new ClaudeStreamJsonParser();
    const frames = parser.feedLine(JSON.stringify({ type: 'system', subtype, uuid: 'error-1', status_code: 429,
      attempt: 7, max_retries: 10, retry_delay_ms: 38875, error: { message: 'Bearer private-token', prompt: 'private prompt' }, thinking: 'hidden' }));
    const observation = runtimeEventObservation(frameToRuntimeEvent('i', frames[0])!);
    assert.equal(observation?.kind, subtype === 'api_retry' ? 'provider_retry' : 'provider_error');
    assert.deepEqual(observation?.failure, { code: 'rate_limit', httpStatus: 429, retryAttempt: 7, maxRetries: 10, retryDelayMs: 38875 });
    assert.equal(/private|hidden/.test(JSON.stringify(observation)), false);
  }
});

test('request observation faults, StreamTruncated and provider terminal errors have the same classification', () => {
  for (const observationKind of ['provider_retry', 'provider_error']) {
    assert.equal(runtimeEventObservation(event({ code: 'RUNTIME_REQUEST_OBSERVATION', observationKind }))?.kind, observationKind);
  }
  assert.equal(runtimeEventObservation(event({ code: 'STREAM_SYSTEM', subtype: 'api_retry',
    raw: { error: { connection: { code: 'StreamTruncated' } } } }))?.failure?.code, 'stream_interrupted');
  const terminal = { ...event({ runtimeError: { details: { httpStatus: 502 } } }), type: 'runtime_failed' as const };
  assert.equal(runtimeEventObservation(terminal)?.failure?.code, 'upstream_error');
});

test('format correction is separate from provider/tool faults; replay and diagnostics are not progress', () => {
  const error = { ...event({ name: 'StructuredOutput', isError: true }), type: 'tool_completed' as const };
  assert.equal(runtimeEventObservation(error)?.kind, 'output_contract_error');
  assert.equal(runtimeEventObservation({ ...error, metadata: { name: 'Read', isError: true } })?.kind, 'tool_error');
  assert.equal(runtimeEventObservation({ ...error, visibility: 'user', metadata: { name: 'StructuredOutput' } })?.kind, 'submission_accepted');
  assert.equal(runtimeEventObservation({ ...error, metadata: { name: 'StructuredOutput' } }), undefined);
  assert.equal(runtimeEventObservation(event({ code: 'STREAM_TEXT', progressReplay: true })), undefined);
  assert.equal(runtimeEventObservation(event({ code: 'STREAM_SYSTEM', subtype: 'init' })), undefined);
});

test('distinct progress on the same tool stays observable; replay identity remains stable and bounded', () => {
  const first = { ...event({ toolCallId: 'tool-1', sequence: 1 }), visibility: 'user' as const, content: 'progress' };
  const second = { ...first, metadata: { ...first.metadata, sequence: 2 } };
  assert.notEqual(runtimeEventObservation(first)?.eventId, runtimeEventObservation(second)?.eventId);
  assert.equal(runtimeEventObservation(first)?.eventId, runtimeEventObservation({ ...first })?.eventId);
  const unsafeSequence = { ...first, metadata: { toolCallId: 'tool-1', sequence: 'secret'.repeat(1000) } };
  assert.equal(runtimeEventObservation(unsafeSequence)?.eventId?.includes('secret'), false);
});

test('snapshot roundtrip keeps safe failure facts, strips raw payloads and accepts old snapshots', () => {
  const old = { schemaVersion: 1, policyVersion: 'request-health-v1', version: 1, sessionGeneration: 1,
    sessionId: 's', operationId: 'op', invocationId: 'i', observerEpoch: 'e', phase: 'discussion', agentId: 'a',
    runtimeType: 'claude_code', stage: 'retrying', health: 'abnormal', reasonCode: 'provider_retry',
    capabilities: unknownRuntimeHealthCapabilities(), processStatus: 'unknown', requestStatus: 'unknown',
    startedAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:01:00Z', observationDue: false, canWait: false, canStop: true };
  assert.ok(normalizeRuntimeHealthSnapshot(old));
  const normalized = normalizeRuntimeHealthSnapshot({ ...old, failure: { code: 'rate_limit', httpStatus: 429,
    retryAttempt: 7, maxRetries: 10, retryDelayMs: Infinity, prompt: 'secret', raw: 'secret' },
    failureAt: old.updatedAt, budgetFallbackReason: 'provider_or_tool_error' });
  assert.deepEqual(normalized?.failure, { code: 'rate_limit', httpStatus: 429, retryAttempt: 7, maxRetries: 10 });
  assert.equal(normalized?.budgetFallbackReason, 'provider_or_tool_error');
  assert.equal(JSON.stringify(normalized).includes('secret'), false);
  assert.equal(normalizeRuntimeFailureDetails({ code: 'secret', httpStatus: 502 }), undefined);
});
