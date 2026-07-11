import test from 'node:test';
import assert from 'node:assert/strict';
import { RunChannel } from './run-channel.js';
import type { RuntimeStreamFrame } from './runtime-stream-frame.js';

const text = (t: string): RuntimeStreamFrame => ({ kind: 'assistant_text', text: t });
const toolUse = (id: string): RuntimeStreamFrame => ({
  kind: 'tool_use',
  toolCallId: id,
  tool: 'read_file',
  input: {}
});
const result = (): RuntimeStreamFrame => ({ kind: 'result', payload: {} });

async function collect(ch: RunChannel): Promise<RuntimeStreamFrame[]> {
  const out: RuntimeStreamFrame[] = [];
  for await (const f of ch) out.push(f);
  return out;
}

test('RunChannel preserves push order and terminates on close', async () => {
  const ch = new RunChannel({ capacity: 16 });
  ch.push(text('a'));
  ch.push(text('b'));
  ch.push(text('c'));
  ch.close();
  const out = await collect(ch);
  assert.deepEqual(out.map((f) => (f.kind === 'assistant_text' ? f.text : '')), ['a', 'b', 'c']);
});

test('close before consumer starts still delivers buffered frames', async () => {
  const ch = new RunChannel({ capacity: 4 });
  ch.push(text('x'));
  ch.close();
  const out = await collect(ch);
  assert.equal(out.length, 1);
});

test('bounded capacity drops oldest assistant_text frames when full', async () => {
  const ch = new RunChannel({ capacity: 3 });
  ch.push(text('1'));
  ch.push(text('2'));
  ch.push(text('3'));
  ch.push(text('4'));
  ch.push(text('5'));
  ch.close();
  const out = await collect(ch);
  assert.deepEqual(out.map((f) => (f.kind === 'assistant_text' ? f.text : '')), ['3', '4', '5']);
});

test('overflow preserves tool_use and result frames, drops assistant_text', async () => {
  const ch = new RunChannel({ capacity: 3 });
  ch.push(text('t1'));
  ch.push(toolUse('u1'));
  ch.push(text('t2'));
  ch.push(text('t3'));
  ch.push(result());
  ch.close();
  const out = await collect(ch);
  // capacity=3, priority frames retained; text frames dropped as needed
  const kinds = out.map((f) => f.kind);
  assert.ok(kinds.includes('tool_use'), 'tool_use must be retained');
  assert.ok(kinds.includes('result'), 'result must be retained');
  assert.equal(out.length, 3);
});

test('second stream() call throws (single-consumer channel)', async () => {
  const ch = new RunChannel({ capacity: 4 });
  ch.push(text('a'));
  ch.close();
  // 第一次消费
  await collect(ch);
  // 第二次消费应抛错
  assert.throws(() => {
    ch[Symbol.asyncIterator]();
  });
});

test('consumer awaiting empty channel wakes up on close', async () => {
  const ch = new RunChannel({ capacity: 4 });
  const iter = ch[Symbol.asyncIterator]();
  const pending = iter.next();
  // 立即 close,消费者应立刻拿到 done
  ch.close();
  const step = await pending;
  assert.equal(step.done, true);
});
