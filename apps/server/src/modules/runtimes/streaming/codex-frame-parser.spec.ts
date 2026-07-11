import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexNotification } from './codex-frame-parser.js';
import type { JsonRpcMessage } from './codex-appserver-codec.js';

test('agent.text_delta → assistant_text frame', () => {
  const msg: JsonRpcMessage = {
    jsonrpc: '2.0',
    method: 'agent.text_delta',
    params: { text: '你好' }
  };
  const frame = parseCodexNotification(msg);
  assert.equal(frame.kind, 'assistant_text');
  if (frame.kind !== 'assistant_text') return;
  assert.equal(frame.text, '你好');
});

test('official item/agentMessage/delta → assistant_text frame', () => {
  const frame = parseCodexNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: '你好' }
  });
  assert.deepEqual(frame, { kind: 'assistant_text', text: '你好' });
});

test('official item lifecycle maps command execution to tool frames', () => {
  const item = {
    type: 'commandExecution',
    id: 'cmd-1',
    command: 'npm test',
    cwd: 'D:/repo',
    status: 'completed',
    aggregatedOutput: 'ok'
  };
  const started = parseCodexNotification({ method: 'item/started', params: { item } });
  const completed = parseCodexNotification({ method: 'item/completed', params: { item } });
  assert.equal(started.kind, 'tool_use');
  assert.equal(completed.kind, 'tool_result');
  if (completed.kind === 'tool_result') assert.equal(completed.output, 'ok');
});

test('official token usage and turn completion map to usage/result frames', () => {
  const usage = parseCodexNotification({
    method: 'thread/tokenUsage/updated',
    params: {
      tokenUsage: {
        last: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4, totalTokens: 16 }
      }
    }
  });
  assert.equal(usage.kind, 'usage');
  const result = parseCodexNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'msg-1', text: '{"kind":"agent_message","messageKind":"summary","content":"done"}' }],
        error: null
      }
    }
  });
  assert.equal(result.kind, 'result');
  if (result.kind !== 'result') return;
  assert.equal(result.cliSessionId, 'thread-1');
  assert.equal((result.payload as { content: string }).content, 'done');
});

test('tool.called → tool_use frame', () => {
  const msg: JsonRpcMessage = {
    jsonrpc: '2.0',
    method: 'tool.called',
    params: { id: 't1', name: 'read_file', input: { path: 'x.ts' } }
  };
  const frame = parseCodexNotification(msg);
  assert.equal(frame.kind, 'tool_use');
  if (frame.kind !== 'tool_use') return;
  assert.equal(frame.toolCallId, 't1');
  assert.equal(frame.tool, 'read_file');
  assert.deepEqual(frame.input, { path: 'x.ts' });
});

test('tool.completed → tool_result frame', () => {
  const msg: JsonRpcMessage = {
    jsonrpc: '2.0',
    method: 'tool.completed',
    params: { id: 't1', name: 'read_file', output: 'file body', isError: false }
  };
  const frame = parseCodexNotification(msg);
  assert.equal(frame.kind, 'tool_result');
  if (frame.kind !== 'tool_result') return;
  assert.equal(frame.toolCallId, 't1');
  assert.equal(frame.output, 'file body');
  assert.equal(frame.isError, false);
});

test('run.completed → result frame with usage and cliSessionId', () => {
  const msg: JsonRpcMessage = {
    jsonrpc: '2.0',
    method: 'run.completed',
    params: {
      payload: { summary: 'done' },
      usage: { inputTokens: 100, outputTokens: 50 },
      sessionId: 's-42'
    }
  };
  const frame = parseCodexNotification(msg);
  assert.equal(frame.kind, 'result');
  if (frame.kind !== 'result') return;
  assert.deepEqual(frame.payload, { summary: 'done' });
  assert.equal(frame.cliSessionId, 's-42');
  assert.equal(frame.usage?.inputTokens, 100);
});

test('unknown method → system frame (forward compatible)', () => {
  const msg: JsonRpcMessage = {
    jsonrpc: '2.0',
    method: 'future.event',
    params: { anything: 1 }
  };
  const frame = parseCodexNotification(msg);
  assert.equal(frame.kind, 'system');
  if (frame.kind !== 'system') return;
  assert.equal(frame.subtype, 'future.event');
});

test('malformed params still yield a system frame instead of throwing', () => {
  const msg: JsonRpcMessage = { jsonrpc: '2.0', method: 'tool.called', params: null };
  const frame = parseCodexNotification(msg);
  // params 不合规 → 落 system,不抛
  assert.equal(frame.kind, 'system');
});
