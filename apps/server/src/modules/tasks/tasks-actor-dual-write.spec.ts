import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTask } from '@agent-cluster/shared';
import { TasksService } from './tasks.service.js';

function makePersistence() {
  const collections = new Map<string, unknown>();
  return {
    collections,
    getCollection<T>(_key: string, fallback: T): T {
      return fallback;
    },
    setCollection(key: string, value: unknown) {
      collections.set(key, value);
    }
  };
}

test('TasksService creates ActorRef and legacy assignment fields together', () => {
  const service = new TasksService(makePersistence() as never);
  const [task] = service.createFromSuggestions(
    'session-1',
    [
      {
        title: 'Implement API',
        description: 'Implement the endpoint',
        suggestedAgentKey: 'backend',
        acceptanceCriteria: []
      }
    ],
    new Map([['backend', 'agent-backend']]),
    { assignedByAgentId: 'agent-coordinator' }
  );

  assert.deepEqual(task.assignee, { type: 'agent', id: 'agent-backend' });
  assert.deepEqual(task.assignedBy, { type: 'agent', id: 'agent-coordinator' });
  assert.equal(task.assigneeAgentId, 'agent-backend');
  assert.equal(task.assignedByAgentId, 'agent-coordinator');
});

test('TasksService update backfills the matching legacy field from ActorRef', () => {
  const service = new TasksService(makePersistence() as never);
  const task: AgentTask = {
    id: 'task-1',
    sessionId: 'session-1',
    title: 'Task',
    description: 'Task',
    status: 'assigned',
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  service.add(task);
  service.update(task, { assignee: { type: 'agent', id: 'agent-2' } });

  assert.equal(task.assigneeAgentId, 'agent-2');
});
