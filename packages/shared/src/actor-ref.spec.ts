import test from 'node:test';
import assert from 'node:assert/strict';
import type { ActorRef, ActorType, CollaborationEvent } from './contracts.js';

test('ActorType 覆盖 user/agent/system', () => {
  const values: ActorType[] = ['user', 'agent', 'system'];
  assert.equal(values.length, 3);
  // @ts-expect-error 非法 actor type 必须被类型系统拒绝
  const invalid: ActorType = 'robot';
  void invalid;
});

test('ActorRef 结构最小字段', () => {
  const a: ActorRef = { type: 'agent', id: 'agent-1' };
  assert.equal(a.type, 'agent');
  assert.equal(a.id, 'agent-1');
  const b: ActorRef = { type: 'user', id: 'user-1', displayName: '张三' };
  assert.equal(b.displayName, '张三');
});

test('CollaborationEvent 可 optional 携带 actor,同时兼容旧 fromAgentId', () => {
  const withActor: CollaborationEvent = {
    id: 'e1',
    sessionId: 's1',
    type: 'agent_message',
    actor: { type: 'agent', id: 'agent-a' },
    fromAgentId: 'agent-a',
    toAgentIds: [],
    content: 'hi',
    metadata: { schemaVersion: '0.1' },
    createdAt: '2026-07-09T00:00:00.000Z'
  };
  assert.equal(withActor.actor?.type, 'agent');
  assert.equal(withActor.fromAgentId, 'agent-a');

  const legacy: CollaborationEvent = {
    id: 'e2',
    sessionId: 's1',
    type: 'user_message',
    fromAgentId: undefined,
    toAgentIds: [],
    content: 'x',
    metadata: { schemaVersion: '0.1' },
    createdAt: '2026-07-09T00:00:00.000Z'
  };
  assert.equal(legacy.actor, undefined);
});
