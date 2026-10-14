import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalRuntimeConnectionService } from './local-runtime-connection.service.js';

test('long tools and subsequent idle thresholds only report observations, never cancel', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const previousIdle = process.env.LOCAL_RUNTIME_IDLE_TIMEOUT_MS;
  const previousTool = process.env.LOCAL_RUNTIME_TOOL_TIMEOUT_MS;
  process.env.LOCAL_RUNTIME_IDLE_TIMEOUT_MS = '100';
  process.env.LOCAL_RUNTIME_TOOL_TIMEOUT_MS = '300';
  try {
    const service = new LocalRuntimeConnectionService({} as never, {} as never, {} as never, {} as never);
    const subject = service as any;
    const stopped: any[] = [];
    subject.requestInvocationStop = (_active: unknown, reason: unknown) => stopped.push(reason);
    const observations: any[] = [];
    const active = { invocationId: 'call', queue: { push: (event: unknown) => observations.push(event) } };
    const event = { type: 'tool_called', visibility: 'user', content: 'Run tests', metadata: { toolCallId: 'tool', name: 'Bash' } };
    subject.observeInvocationActivity(active, event);
    context.mock.timers.tick(150);
    assert.equal(stopped.length, 0, 'a bounded running tool must not be mistaken for model silence');
    subject.observeInvocationActivity(active, event);
    context.mock.timers.tick(150);
    assert.equal(stopped.length, 0);
    assert.equal(observations[0]?.metadata.observationKind, 'observation_due');
    stopped.length = 0;
    subject.observeInvocationActivity(active, { ...event, type: 'tool_completed', metadata: { ...event.metadata, isError: true } });
    context.mock.timers.tick(100);
    assert.equal(stopped.length, 0);
    assert.equal(observations.at(-1)?.metadata.observationKind, 'observation_due');
  } finally {
    if (previousIdle === undefined) delete process.env.LOCAL_RUNTIME_IDLE_TIMEOUT_MS;
    else process.env.LOCAL_RUNTIME_IDLE_TIMEOUT_MS = previousIdle;
    if (previousTool === undefined) delete process.env.LOCAL_RUNTIME_TOOL_TIMEOUT_MS;
    else process.env.LOCAL_RUNTIME_TOOL_TIMEOUT_MS = previousTool;
    context.mock.timers.reset();
  }
});
