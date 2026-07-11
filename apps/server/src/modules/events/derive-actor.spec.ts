import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveActor } from './derive-actor.js';

test('deriveActor: user_message + sessionUserId → user actor', () => {
  const actor = deriveActor({ type: 'user_message', sessionUserId: 'u-1' });
  assert.deepEqual(actor, { type: 'user', id: 'u-1' });
});

test('deriveActor: user_message 无 sessionUserId → user 兜底 system', () => {
  const actor = deriveActor({ type: 'user_message' });
  assert.deepEqual(actor, { type: 'user', id: 'system' });
});

test('deriveActor: 带 fromAgentId → agent actor', () => {
  const actor = deriveActor({ type: 'agent_message', fromAgentId: 'a-1' });
  assert.deepEqual(actor, { type: 'agent', id: 'a-1' });
});

test('deriveActor: runtime_progress + fromAgentId → agent actor', () => {
  const actor = deriveActor({ type: 'runtime_progress', fromAgentId: 'a-2' });
  assert.deepEqual(actor, { type: 'agent', id: 'a-2' });
});

test('deriveActor: session_status_changed 无 fromAgentId → system actor', () => {
  const actor = deriveActor({ type: 'session_status_changed' });
  assert.deepEqual(actor, { type: 'system', id: 'system' });
});

test('deriveActor: error_reported 无 fromAgentId → system actor', () => {
  const actor = deriveActor({ type: 'error_reported' });
  assert.deepEqual(actor, { type: 'system', id: 'system' });
});

test('deriveActor: 未分类 type 无 fromAgentId → system 兜底', () => {
  const actor = deriveActor({ type: 'task_created' });
  assert.deepEqual(actor, { type: 'system', id: 'system' });
});
