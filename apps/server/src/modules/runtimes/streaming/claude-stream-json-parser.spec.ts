import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeStreamJsonParser, parseClaudeLine } from './claude-stream-json-parser.js';

test('parseClaudeLine: assistant text → assistant_text 帧', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '你好' }] }
  });
  const frames = parseClaudeLine(line);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'assistant_text');
  if (frames[0].kind !== 'assistant_text') return;
  assert.equal(frames[0].text, '你好');
});

test('parseClaudeLine: assistant tool_use → tool_use 帧', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'x' } }
      ]
    }
  });
  const frames = parseClaudeLine(line);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'tool_use');
  if (frames[0].kind !== 'tool_use') return;
  assert.equal(frames[0].toolCallId, 't1');
  assert.equal(frames[0].tool, 'read_file');
  assert.deepEqual(frames[0].input, { path: 'x' });
});

test('ClaudeStreamJsonParser: tool_result 帧携带上一步 tool 名', () => {
  const parser = new ClaudeStreamJsonParser();
  parser.feedLine(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'grep', input: { pat: 'x' } }
        ]
      }
    })
  );
  const frames = parser.feedLine(
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'hit', is_error: false }
        ]
      }
    })
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'tool_result');
  if (frames[0].kind !== 'tool_result') return;
  assert.equal(frames[0].toolCallId, 't1');
  assert.equal(frames[0].tool, 'grep');
  assert.equal(frames[0].output, 'hit');
  assert.equal(frames[0].isError, false);
});

test('parseClaudeLine: result success → result 帧带 usage / cliSessionId', () => {
  const line = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'summary',
    usage: { input_tokens: 10, output_tokens: 5 },
    session_id: 's1'
  });
  const frames = parseClaudeLine(line);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'result');
  if (frames[0].kind !== 'result') return;
  assert.deepEqual(frames[0].payload, { content: 'summary', messageKind: 'summary' });
  assert.equal(frames[0].cliSessionId, 's1');
  assert.equal(frames[0].usage?.inputTokens, 10);
  assert.equal(frames[0].usage?.outputTokens, 5);
});

test('parseClaudeLine: result error → failed result frame with CLI errors', () => {
  const frames = parseClaudeLine(
    JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['invalid resume id'],
      session_id: 's-error'
    })
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'result');
  if (frames[0].kind !== 'result') return;
  assert.equal(frames[0].turnStatus, 'failed');
  assert.equal(frames[0].errorMessage, 'invalid resume id');
});

test('parseClaudeLine: system init → system 帧', () => {
  const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' });
  const frames = parseClaudeLine(line);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'system');
  if (frames[0].kind !== 'system') return;
  assert.equal(frames[0].subtype, 'init');
});

test('parseClaudeLine: 空行 / 非 JSON → 空数组', () => {
  assert.deepEqual(parseClaudeLine(''), []);
  assert.deepEqual(parseClaudeLine('   '), []);
  assert.deepEqual(parseClaudeLine('not json'), []);
});
