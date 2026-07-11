import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeRuntimeStream } from './runtime-stream-consumer.js';
import type { AgentRuntimeEvent, EventRenderType } from '@agent-cluster/shared';

type CreateArg = Parameters<{ create: (arg: unknown) => void }['create']>[0] & Record<string, unknown>;

function makeEventsSpy() {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    create(arg: Record<string, unknown>) {
      created.push(arg);
    }
  };
}

function makeMetadata<TPayload extends Record<string, unknown>>(
  kind: EventRenderType | undefined,
  extra: TPayload
) {
  return { schemaVersion: '0.1' as const, renderAs: kind, payload: extra };
}

async function* framesGen(frames: AgentRuntimeEvent[]) {
  for (const f of frames) yield f;
}

function makeInput() {
  return {
    runId: 'run-a',
    sessionId: 'ses-a',
    taskId: 'task-a',
    agent: { id: 'agent-a', name: 'Coder' }
  };
}

function textEvent(overrides: Partial<AgentRuntimeEvent> = {}): AgentRuntimeEvent {
  return {
    runId: 'run-a',
    type: 'runtime_progress',
    content: 'chunk',
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

test('consumeRuntimeStream: 转发至少 3 条真实事件(非 heartbeat)', async () => {
  const events = makeEventsSpy();
  const frames: AgentRuntimeEvent[] = [
    textEvent({ type: 'runtime_progress', content: 'hi', metadata: { code: 'STREAM_TEXT' } }),
    textEvent({
      type: 'tool_called',
      metadata: { toolCallId: 't1', name: 'read_file', input: { path: 'a.ts' } }
    }),
    textEvent({
      type: 'tool_completed',
      metadata: { toolCallId: 't1', name: 'read_file', output: '/*c*/', isError: false }
    }),
    textEvent({ type: 'artifact_created', metadata: { title: 'diff' } }),
    textEvent({ type: 'runtime_progress', content: 'done' })
  ];
  const adapter = { stream: (_id: string) => framesGen(frames) };
  await consumeRuntimeStream(adapter as never, makeInput() as never, {
    events: events as never,
    createMetadata: makeMetadata
  });
  const real = events.created.filter(
    (e) => ((e.metadata as { payload?: Record<string, unknown> })?.payload?.code) !== 'RUNTIME_HEARTBEAT'
  );
  assert.ok(real.length >= 3, `expected >=3 real events, got ${real.length}`);
});

test('consumeRuntimeStream: tool_use 帧 → tool_called 事件保留 toolCallId', async () => {
  const events = makeEventsSpy();
  const frames: AgentRuntimeEvent[] = [
    textEvent({
      type: 'tool_called',
      metadata: { toolCallId: 't42', name: 'grep', input: { pat: 'foo' } }
    })
  ];
  const adapter = { stream: (_id: string) => framesGen(frames) };
  await consumeRuntimeStream(adapter as never, makeInput() as never, {
    events: events as never,
    createMetadata: makeMetadata
  });
  const call = events.created.find((e) => e.type === 'tool_called');
  assert.ok(call);
  const md = call.metadata as { payload: Record<string, unknown> };
  assert.equal(md.payload.toolCallId, 't42');
  assert.equal(md.payload.name, 'grep');
});

test('consumeRuntimeStream: tool_completed 帧 output 截断到前 200 字符', async () => {
  const events = makeEventsSpy();
  const big = 'x'.repeat(500);
  const frames: AgentRuntimeEvent[] = [
    textEvent({
      type: 'tool_completed',
      metadata: { toolCallId: 't1', name: 'cat', output: big, isError: false }
    })
  ];
  const adapter = { stream: (_id: string) => framesGen(frames) };
  await consumeRuntimeStream(adapter as never, makeInput() as never, {
    events: events as never,
    createMetadata: makeMetadata
  });
  const done = events.created.find((e) => e.type === 'tool_completed');
  assert.ok(done);
  const md = done.metadata as { payload: Record<string, unknown> };
  assert.equal((md.payload.outputPreview as string).length, 200);
});

test('consumeRuntimeStream: adapter 无 stream 方法 → 不产生任何事件', async () => {
  const events = makeEventsSpy();
  await consumeRuntimeStream({} as never, makeInput() as never, {
    events: events as never,
    createMetadata: makeMetadata
  });
  assert.equal(events.created.length, 0);
});
