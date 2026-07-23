import assert from 'node:assert/strict';
import test from 'node:test';
import { RUNTIME_OUTPUT_KINDS, runtimeOutputExamples } from '@agent-cluster/shared';
import { framesToOutput, MapperError } from './frame-to-output.mapper.js';
import type { RuntimeStreamFrame } from './runtime-stream-frame.js';

const result = (payload: unknown): RuntimeStreamFrame => ({ kind: 'result', payload });

test('accepts every registered version 1.0 output without rewriting it', () => {
  for (const kind of RUNTIME_OUTPUT_KINDS) {
    const expected = runtimeOutputExamples[kind];
    assert.deepEqual(framesToOutput(kind, [result(expected)]), expected);
  }
});

test('assembles official Codex item output with terminal turn status', () => {
  const expected = runtimeOutputExamples.agent_message;
  const frames: RuntimeStreamFrame[] = [
    { kind: 'provider_output', payload: expected, source: 'item/completed' },
    { kind: 'result', payload: undefined, turnStatus: 'completed' }
  ];
  assert.deepEqual(framesToOutput('agent_message', frames), expected);
});

test('strictly rejects an invalid authoritative provider output', () => {
  const frames: RuntimeStreamFrame[] = [
    { kind: 'provider_output', payload: 'not-json', source: 'item/completed' },
    result(runtimeOutputExamples.agent_message)
  ];
  assert.throws(() => framesToOutput('agent_message', frames), /must be object/);
});

test('does not use assistant text to fill missing structured fields', () => {
  const frames: RuntimeStreamFrame[] = [
    { kind: 'assistant_text', text: 'legacy fallback text' },
    result({})
  ];
  assert.throws(
    () => framesToOutput('agent_message', frames),
    (error) => error instanceof MapperError && /RUNTIME_OUTPUT_CONTRACT_VIOLATION/.test(error.message)
  );
});
test('does not infer changed artifacts from tool frames', () => {
  const invalid = {
    ...runtimeOutputExamples.task_execution_result,
    changedArtifacts: undefined
  };
  const frames: RuntimeStreamFrame[] = [
    { kind: 'tool_use', toolCallId: '1', tool: 'write_file', input: { path: 'a.ts' } },
    { kind: 'tool_result', toolCallId: '1', tool: 'write_file', output: 'ok' },
    result(invalid)
  ];
  assert.throws(() => framesToOutput('task_execution_result', frames), /RUNTIME_OUTPUT_CONTRACT_VIOLATION/);
});

test('rejects a missing field, extra field, old schema version, and wrong kind', () => {
  const valid = runtimeOutputExamples.agent_message;
  const missing = { ...valid } as Record<string, unknown>;
  delete missing.targetAgentIds;

  for (const payload of [
    missing,
    { ...valid, providerPayload: {} },
    { ...valid, schemaVersion: '0.1' },
    runtimeOutputExamples.final_delivery
  ]) {
    assert.throws(() => framesToOutput('agent_message', [result(payload)]), /RUNTIME_OUTPUT_CONTRACT_VIOLATION/);
  }
});

test('rejects removed legacy Artifact aliases and metadata body fields', () => {
  const payload = {
    ...runtimeOutputExamples.task_execution_result,
    changedArtifacts: [
      {
        type: 'architecture_analysis',
        title: 'Legacy architecture report',
        content: '# report',
        uri: null,
        summary: null,
        metadata: { content: '# legacy body' }
      }
    ]
  };
  assert.throws(() => framesToOutput('task_execution_result', [result(payload)]), /RUNTIME_OUTPUT_CONTRACT_VIOLATION/);
});

test('no result frame throws MapperError', () => {
  assert.throws(
    () => framesToOutput('agent_message', [{ kind: 'assistant_text', text: 'hi' }]),
    MapperError
  );
});
