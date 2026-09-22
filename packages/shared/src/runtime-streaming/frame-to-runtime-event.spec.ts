import test from 'node:test';
import assert from 'node:assert/strict';
import { frameToRuntimeEvent } from './frame-to-runtime-event.js';
import type { RuntimeStreamFrame } from './runtime-stream-frame.js';

/**
 * Read receipts are validated from the emitted `tool_completed` event rather
 * than from the provider's tool-result text.  Keep the extra fields local to
 * this red test until the shared frame contract is extended by the
 * implementation task.
 */
type AuditedToolResultFrame = Extract<RuntimeStreamFrame, { kind: 'tool_result' }> & {
  input: { path: string };
  truncated: boolean;
  source: 'local_runtime' | 'server_runtime';
};

const invocationId = 'invocation-1';
const requiredPath = '.agent-cluster/discussion-documents/session-1/plan-revision-001.md';

function auditedToolResult(overrides: Partial<AuditedToolResultFrame> = {}): AuditedToolResultFrame {
  return {
    kind: 'tool_result',
    toolCallId: 'tool-1',
    tool: 'read_file',
    input: { path: requiredPath },
    output: '# revised plan',
    isError: false,
    truncated: false,
    source: 'local_runtime',
    ...overrides
  };
}

test('tool_completed keeps read_file input.path and read completeness metadata', () => {
  const event = frameToRuntimeEvent(invocationId, auditedToolResult() as RuntimeStreamFrame);

  assert.ok(event);
  assert.equal(event.type, 'tool_completed');
  assert.equal(event.metadata?.name, 'read_file');
  assert.deepEqual(event.metadata?.input, { path: requiredPath });
  assert.equal(event.metadata?.truncated, false);
  assert.equal(event.metadata?.source, 'local_runtime');
});

test('tool_completed preserves truncated=true so an incomplete read cannot satisfy the receipt gate', () => {
  const event = frameToRuntimeEvent(
    invocationId,
    auditedToolResult({ truncated: true, output: '# partial plan' }) as RuntimeStreamFrame
  );

  assert.ok(event);
  assert.equal(event.type, 'tool_completed');
  assert.equal(event.metadata?.input && (event.metadata.input as { path?: string }).path, requiredPath);
  assert.equal(event.metadata?.truncated, true);
  assert.equal(event.metadata?.source, 'local_runtime');
});
