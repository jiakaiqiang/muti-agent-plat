import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRuntimeEvent, EventRenderType } from '@agent-cluster/shared';
import { consumeRuntimeEvents } from './runtime-stream-consumer.js';

function makeEventsSpy() {
  const created: Array<Record<string, unknown>> = [];
  return { created, create: (arg: Record<string, unknown>) => created.push(arg) };
}

function makeMetadata<TPayload extends Record<string, unknown>>(kind: EventRenderType | undefined, payload: TPayload) {
  return { schemaVersion: '0.1' as const, renderAs: kind, payload };
}

async function* frames(input: AgentRuntimeEvent[]) {
  yield* input;
}

function plan() {
  return {
    invocationId: 'invocation-a',
    sessionId: 'session-a',
    taskId: 'task-a',
    agent: { agentId: 'agent-a', name: 'Coder' }
  };
}

function event(overrides: Partial<AgentRuntimeEvent> = {}): AgentRuntimeEvent {
  return {
    invocationId: 'invocation-a',
    type: 'runtime_progress',
    visibility: 'user',
    content: 'chunk',
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

test('handle events are forwarded without synthetic heartbeat events', async () => {
  const events = makeEventsSpy();
  await consumeRuntimeEvents(frames([
    event({ type: 'tool_called', metadata: { toolCallId: 't1', name: 'read_file' } }),
    event({ type: 'tool_completed', metadata: { toolCallId: 't1', name: 'read_file', output: 'ok' } }),
    event({ type: 'artifact_created', metadata: { title: 'diff' } })
  ]), plan() as never, { events: events as never, createMetadata: makeMetadata });
  assert.equal(events.created.length, 3);
});

test('published user-visible events refresh Runtime activity', async () => {
  const events = makeEventsSpy();
  const published: AgentRuntimeEvent[] = [];
  await consumeRuntimeEvents(
    frames([
      event({ type: 'runtime_progress', content: 'working' }),
      event({ visibility: 'debug', metadata: { code: 'STREAM_SYSTEM' } })
    ]),
    plan() as never,
    {
      events: events as never,
      createMetadata: makeMetadata,
      onPublished: (frame) => published.push(frame)
    }
  );
  assert.equal(published.length, 1);
  assert.equal(published[0].content, 'working');
});

test('provider output deltas never become collaboration events even when marked user-visible', async () => {
  const events = makeEventsSpy();
  await consumeRuntimeEvents(frames([
    event({ content: 'mentioned', metadata: { code: 'STREAM_TEXT' } }),
    event({ content: 'Agent', metadata: { code: 'STREAM_TEXT' } }),
    event({ content: 'Ids', metadata: { code: 'STREAM_TEXT' } }),
    event({ content: '":[]', metadata: { code: 'STREAM_TEXT' } })
  ]), plan() as never, { events: events as never, createMetadata: makeMetadata });
  assert.deepEqual(events.created, []);
});

test('tool_called preserves the invocation-scoped tool call identity', async () => {
  const events = makeEventsSpy();
  await consumeRuntimeEvents(frames([
    event({ type: 'tool_called', metadata: { toolCallId: 't42', name: 'grep', input: { pattern: 'foo' } } })
  ]), plan() as never, { events: events as never, createMetadata: makeMetadata });
  const metadata = events.created[0].metadata as { payload: Record<string, unknown> };
  assert.equal(metadata.payload.runtimeInvocationId, 'invocation-a');
  assert.equal(metadata.payload.toolCallId, 't42');
});

test('tool_completed truncates output previews to 200 characters', async () => {
  const events = makeEventsSpy();
  await consumeRuntimeEvents(frames([
    event({ type: 'tool_completed', metadata: { toolCallId: 't1', name: 'cat', output: 'x'.repeat(500) } })
  ]), plan() as never, { events: events as never, createMetadata: makeMetadata });
  const metadata = events.created[0].metadata as { payload: Record<string, unknown> };
  assert.equal(String(metadata.payload.outputPreview).length, 200);
});

test('terminal Runtime frames are not duplicated into collaboration events', async () => {
  const events = makeEventsSpy();
  await consumeRuntimeEvents(frames([
    event({ type: 'runtime_started' }),
    event({ type: 'runtime_completed' }),
    event({ type: 'runtime_failed' })
  ]), plan() as never, { events: events as never, createMetadata: makeMetadata });
  assert.deepEqual(events.created, []);
});

test('debug visibility and raw system diagnostics never enter collaboration events', async () => {
  const events = makeEventsSpy();
  await consumeRuntimeEvents(frames([
    event({ visibility: 'debug', metadata: { code: 'STREAM_SYSTEM', subtype: 'thread/started' } }),
    event({ metadata: { code: 'STREAM_STDERR' } })
  ]), plan() as never, { events: events as never, createMetadata: makeMetadata });
  assert.deepEqual(events.created, []);
});

test('workspace preparation diagnostics stay out of collaboration events even when misclassified as user-visible', async () => {
  const events = makeEventsSpy();
  await consumeRuntimeEvents(frames([
    event({ metadata: { code: 'WORKTREE_PREPARED' } })
  ]), plan() as never, { events: events as never, createMetadata: makeMetadata });
  assert.deepEqual(events.created, []);
});
