import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRuntimeEvent } from './contracts.js';
import { usefulRuntimeActivity } from './runtime-activity.js';

test('heartbeats and repeated errors never count as useful activity; replayed output is deduplicated', () => {
  const useful = usefulRuntimeActivity();
  const event: AgentRuntimeEvent = { invocationId: 'run', type: 'runtime_progress', content: 'working', visibility: 'user', createdAt: 'now' };
  assert.equal(useful({ ...event, metadata: { code: 'RUNTIME_HEARTBEAT' } }), false);
  assert.equal(useful({ ...event, content: 'model delta', visibility: 'debug', metadata: { code: 'STREAM_TEXT' } }), true);
  assert.equal(useful({ ...event, type: 'tool_completed', metadata: { isError: true, toolCallId: 'error' } }), false);
  assert.equal(useful(event), true);
  assert.equal(useful({ ...event, createdAt: 'later' }), false);
  assert.equal(useful({ ...event, type: 'tool_completed', metadata: { isError: false, toolCallId: 'tool' } }), true);
});
