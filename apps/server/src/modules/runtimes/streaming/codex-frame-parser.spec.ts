import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexNotification } from './codex-frame-parser.js';
import type { JsonRpcMessage } from './codex-appserver-codec.js';

test('legacy Codex notification methods are debug-only unknown frames', () => {
  for (const method of ['agent.text_delta', 'tool.called', 'tool.completed', 'run.completed']) {
    const frame = parseCodexNotification({ jsonrpc: '2.0', method, params: { text: 'legacy' } });
    assert.equal(frame.kind, 'system');
    if (frame.kind !== 'system') continue;
    assert.equal(frame.subtype, method);
    assert.equal(frame.disposition, 'debug_only');
  }
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

test('dynamicToolCall completion keeps arguments as tool_result input', () => {
  const path = '.agent-cluster/discussion-documents/session-1/plan-revision-001.md';
  const frame = parseCodexNotification({
    method: 'item/completed',
    params: {
      item: {
        type: 'dynamicToolCall',
        id: 'call-1',
        tool: 'read_file',
        arguments: { path },
        contentItems: [{ type: 'text', text: '# revised plan' }],
        status: 'completed'
      }
    }
  });

  assert.equal(frame.kind, 'tool_result');
  if (frame.kind !== 'tool_result') return;
  assert.deepEqual(frame.input, { path });
  assert.equal(frame.tool, 'read_file');
});

test('official completed agentMessage is the authoritative provider output', () => {
  const payload = {
    kind: 'agent_message',
    schemaVersion: '1.0',
    messageKind: 'summary',
    content: 'done',
    targetAgentIds: []
  };
  const frame = parseCodexNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: Date.now(),
      item: { type: 'agentMessage', id: 'msg-1', text: JSON.stringify(payload) }
    }
  });
  assert.deepEqual(frame, { kind: 'provider_output', payload, source: 'item/completed' });
});

test('completed agentMessage does not repair non-JSON text into an output object', () => {
  const frame = parseCodexNotification({
    method: 'item/completed',
    params: {
      item: { type: 'agentMessage', id: 'msg-1', text: 'plain text is invalid here' }
    }
  });
  assert.deepEqual(frame, {
    kind: 'provider_output',
    payload: 'plain text is invalid here',
    source: 'item/completed'
  });
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
  assert.equal(frame.disposition, 'debug_only');
});

test('internal lifecycle notifications are debug-only', () => {
  for (const method of [
    'thread/started',
    'mcpServer/startupStatus/updated',
    'remoteControl/status/changed'
  ]) {
    const frame = parseCodexNotification({ method, params: { status: 'ready' } });
    assert.equal(frame.kind, 'system');
    if (frame.kind === 'system') assert.equal(frame.disposition, 'debug_only');
  }
});

test('MCP startup failure remains diagnostic because turn completion is authoritative', () => {
  const frame = parseCodexNotification({
    method: 'mcpServer/startupStatus/updated',
    params: { server: 'example', status: 'failed', error: 'spawn EPERM' }
  });
  assert.equal(frame.kind, 'system');
  if (frame.kind === 'system') assert.equal(frame.disposition, 'debug_only');
});

test('malformed params still yield a system frame instead of throwing', () => {
  const msg: JsonRpcMessage = { jsonrpc: '2.0', method: 'item/started', params: null };
  const frame = parseCodexNotification(msg);
  // params 不合规 → 落 system,不抛
  assert.equal(frame.kind, 'system');
});
