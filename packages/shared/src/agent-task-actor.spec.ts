import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTask, ActorRef } from './contracts.js';

test('AgentTask.assignee 接受 agent ActorRef', () => {
  const actor: ActorRef = { type: 'agent', id: 'agent-1' };
  const task = { assignee: actor } as unknown as Pick<AgentTask, 'assignee'>;
  assert.equal(task.assignee?.type, 'agent');
  assert.equal(task.assignee?.id, 'agent-1');
});

test('AgentTask.assignee 接受 user ActorRef', () => {
  const actor: ActorRef = { type: 'user', id: 'user-1' };
  const task = { assignee: actor } as unknown as Pick<AgentTask, 'assignee'>;
  assert.equal(task.assignee?.type, 'user');
});

test('AgentTask.assignedBy 接受 system ActorRef (R7 autopilot 预留)', () => {
  const actor: ActorRef = { type: 'system', id: 'coordinator' };
  const task = { assignedBy: actor } as unknown as Pick<AgentTask, 'assignedBy'>;
  assert.equal(task.assignedBy?.type, 'system');
});
