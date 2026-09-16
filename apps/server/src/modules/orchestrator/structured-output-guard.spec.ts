import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRuntimeEvent, RuntimeError } from '@agent-cluster/shared';
import { structuredOutputGuard } from './structured-output-guard.js';

function frame(id: string, isError: boolean): AgentRuntimeEvent {
  return { invocationId: 'one', type: 'tool_completed', createdAt: new Date().toISOString(),
    content: '', visibility: 'user',
    metadata: { name: 'StructuredOutput', toolCallId: id, isError } };
}
test('allows one correction, ignores duplicates, and fails once on a second rejection', () => {
  const failures: RuntimeError[] = [];
  const guard = structuredOutputGuard({ maxCorrections: 1, timeoutMs: 1000, fail: e => failures.push(e) });
  try {
    guard.observe(frame('first', true));
    guard.observe(frame('first', true));
    assert.equal(failures.length, 0);
    guard.observe(frame('second', true));
    guard.observe(frame('third', true));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, 'RUNTIME_OUTPUT_CONTRACT_VIOLATION');
    assert.equal(failures[0].retryable, false);
  } finally { guard.dispose(); }
});
test('heartbeats do not extend correction deadline', async () => {
  const failures: RuntimeError[] = [];
  const guard = structuredOutputGuard({ maxCorrections: 1, timeoutMs: 15, fail: e => failures.push(e) });
  guard.observe(frame('first', true));
  guard.observe({ ...frame('heartbeat', false), type: 'runtime_progress' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(failures[0]?.code, 'RUNTIME_TIMEOUT');
  guard.dispose();
});
test('successful correction and disposal clear pending deadlines', async () => {
  const failures: RuntimeError[] = [];
  const guard = structuredOutputGuard({ maxCorrections: 1, timeoutMs: 15, fail: e => failures.push(e) });
  guard.observe(frame('first', true));
  guard.observe(frame('second', false));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(failures, []);
  guard.dispose();
  guard.observe(frame('late', true));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(failures, []);
});
