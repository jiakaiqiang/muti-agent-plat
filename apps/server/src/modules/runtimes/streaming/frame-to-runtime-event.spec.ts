import assert from 'node:assert/strict';
import test from 'node:test';
import { frameToRuntimeEvent } from './frame-to-runtime-event.js';

test('debug-only provider notifications stay debug-only', () => {
  const event = frameToRuntimeEvent('inv-1', {
    kind: 'system',
    subtype: 'thread/started',
    raw: { method: 'thread/started' },
    disposition: 'debug_only'
  });
  assert.equal(event?.visibility, 'debug');
  assert.equal(event?.metadata?.code, 'STREAM_SYSTEM');
});

test('MCP startup failures remain debug diagnostics and do not become terminal events', () => {
  const event = frameToRuntimeEvent('inv-1', {
    kind: 'system',
    subtype: 'mcpServer/startupStatus/updated',
    raw: { status: 'failed' },
    disposition: 'debug_only'
  });
  assert.equal(event?.visibility, 'debug');
  assert.equal(event?.type, 'runtime_progress');
  assert.equal(event?.metadata?.code, 'STREAM_SYSTEM');
});

test('stderr is audit-only until a provider failure is confirmed', () => {
  const event = frameToRuntimeEvent('inv-1', { kind: 'stderr_tail', text: 'diagnostic' });
  assert.equal(event?.visibility, 'debug');
  assert.equal(event?.metadata?.code, 'STREAM_STDERR');
});

test('provider text deltas stay internal because they may contain structured output fields', () => {
  const event = frameToRuntimeEvent('inv-1', {
    kind: 'assistant_text',
    text: '"mentionedAgentIds":[]'
  });
  assert.equal(event?.type, 'runtime_progress');
  assert.equal(event?.visibility, 'debug');
  assert.equal(event?.metadata?.code, 'STREAM_TEXT');
});

test('authoritative provider output is not duplicated into the chat timeline', () => {
  const event = frameToRuntimeEvent('inv-1', {
    kind: 'provider_output',
    payload: { kind: 'agent_message' },
    source: 'item/completed'
  });
  assert.equal(event, undefined);
});
