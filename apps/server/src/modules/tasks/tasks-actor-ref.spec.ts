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

test('TasksService creates assignee and assigner ActorRefs', () => {
  const service = new TasksService(makePersistence() as never);
  const [task] = service.createFromSuggestions(
    'session-1',
    [{
      title: 'Implement API',
      description: 'Implement the endpoint',
      suggestedAgentKey: 'backend',
      routingMode: null,
      assignmentReason: null,
      contextRequirements: [],
      verificationPlan: [],
      riskNotes: [],
      requiresUserConfirmation: false,
      dependsOnTaskTitles: [],
      acceptanceCriteria: []
    }],
    new Map([['backend', 'agent-backend']]),
    { assignedBy: { type: 'agent', id: 'agent-coordinator' } }
  );
  assert.deepEqual(task.assignee, { type: 'agent', id: 'agent-backend' });
  assert.deepEqual(task.assignedBy, { type: 'agent', id: 'agent-coordinator' });
});

test('TasksService persists ActorRef updates directly', () => {
  const persistence = makePersistence();
  const service = new TasksService(persistence as never);
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
  assert.deepEqual(task.assignee, { type: 'agent', id: 'agent-2' });
  assert.deepEqual((persistence.collections.get('tasksBySession') as Record<string, AgentTask[]>)['session-1'][0].assignee, task.assignee);
});
