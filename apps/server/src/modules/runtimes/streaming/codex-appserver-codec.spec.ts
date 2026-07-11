import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeJsonRpc, JsonRpcDecoder, type JsonRpcMessage } from './codex-appserver-codec.js';

test('encode writes one JSONL message', () => {
  const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const buf = encodeJsonRpc(msg);
  const raw = buf.toString('utf8');
  assert.ok(raw.endsWith('\n'));
  assert.equal(JSON.parse(raw).method, 'ping');
});

test('decoder reads a single complete frame', () => {
  const dec = new JsonRpcDecoder();
  const buf = encodeJsonRpc({ jsonrpc: '2.0', method: 'agent.text_delta', params: { text: 'hi' } });
  const msgs = dec.feed(buf);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].method, 'agent.text_delta');
});

test('decoder assembles frame across split chunks', () => {
  const dec = new JsonRpcDecoder();
  const buf = encodeJsonRpc({ jsonrpc: '2.0', id: 2, result: { ok: true } });
  const half = Math.floor(buf.length / 2);
  const a = buf.subarray(0, half);
  const b = buf.subarray(half);
  assert.equal(dec.feed(a).length, 0);
  const msgs = dec.feed(b);
  assert.equal(msgs.length, 1);
  assert.equal((msgs[0] as JsonRpcMessage & { id?: number }).id, 2);
});

test('decoder splits back-to-back frames in one chunk', () => {
  const dec = new JsonRpcDecoder();
  const a = encodeJsonRpc({ jsonrpc: '2.0', method: 'a' });
  const b = encodeJsonRpc({ jsonrpc: '2.0', method: 'b' });
  const msgs = dec.feed(Buffer.concat([a, b]));
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].method, 'a');
  assert.equal(msgs[1].method, 'b');
});

test('decoder preserves UTF-8 text', () => {
  const msg: JsonRpcMessage = { jsonrpc: '2.0', method: 'chat', params: { text: '你好世界' } };
  const buf = encodeJsonRpc(msg);
  const dec = new JsonRpcDecoder();
  const decoded = dec.feed(buf);
  assert.equal(decoded.length, 1);
  assert.equal((decoded[0].params as { text: string }).text, '你好世界');
});

test('decoder skips malformed and blank lines', () => {
  const raw = `not-json\n\n${JSON.stringify({ method: 'x' })}\n`;
  const dec = new JsonRpcDecoder();
  const msgs = dec.feed(Buffer.from(raw, 'utf8'));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].method, 'x');
});
