import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeStreamJsonParser } from './runtime-streaming/claude-stream-json-parser.js';
import { sanitizeRuntimeLine, RuntimeDiagnosticCapture } from './runtime-diagnostic-sanitizer.js';
import { normalizeRuntimeHealthSnapshot, isRuntimeHealthWaitInput } from './runtime-request-health.js';

test('Claude partial thinking is metadata only; signature/empty deltas do not progress', () => {
  const parser = new ClaudeStreamJsonParser();
  const secret = 'private hidden thought';
  const frame = parser.feedLine(JSON.stringify({ type: 'stream_event', uuid: 'delta-1', event: {
    type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: secret }
  } }));
  assert.equal(frame[0]?.kind, 'observation');
  assert.equal((frame[0] as any).observationKind, 'reasoning_progress');
  assert.equal(JSON.stringify(frame).includes(secret), false);
  assert.deepEqual(parser.feedLine(JSON.stringify({ type: 'stream_event', event: {
    type: 'content_block_delta', delta: { type: 'signature_delta', signature: secret }
  } })), []);
  assert.deepEqual(parser.feedLine(JSON.stringify({ type: 'stream_event', event: {
    type: 'content_block_delta', delta: { type: 'text_delta', text: '' }
  } })), []);
});

test('captured provider JSON strips reasoning and signatures without truncating business output', () => {
  const items = Array.from({ length: 300 }, (_, id) => ({ id, text: 'business text' }));
  const sanitized = sanitizeRuntimeLine(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'hidden text', signature: 'secret signature' },
    { type: 'text', text: 'final business output' }
  ], reasoning_content: 'hidden alternate' }, structured_output: { items } }));
  assert.equal(/hidden text|secret signature|hidden alternate/.test(sanitized), false);
  assert.equal(JSON.parse(sanitized).structured_output.items.length, 300);
  assert.match(sanitized, /final business output/);
});

test('untrusted malformed snapshots and wait bodies fail closed', () => {
  assert.equal(normalizeRuntimeHealthSnapshot({ schemaVersion: 1, version: 5, canWait: true }), undefined);
  assert.equal(isRuntimeHealthWaitInput({ expectedVersion: 1, sessionGeneration: 0, idempotencyKey: 'one' }), true);
  for (const expectedVersion of [-1, 0, NaN, '1']) assert.equal(isRuntimeHealthWaitInput({ expectedVersion, sessionGeneration: 0, idempotencyKey: 'one' }), false);
});

test('split stderr JSON and oversized diagnostics cannot leak reasoning into captured output', () => {
  const captured: string[] = [];
  const capture = new RuntimeDiagnosticCapture(line => captured.push(line));
  capture.feed('{"reasoning_content":"private');
  assert.equal(captured.length, 0);
  capture.feed(' thought","signature":"secret","error":"safe error"}\n');
  capture.feed('x'.repeat(70000)); capture.flush();
  assert.equal(/private thought|secret/.test(captured.join('')), false);
  assert.match(captured.join(''), /safe error/);
  assert.match(captured.join(''), /oversized diagnostic omitted/);
});
