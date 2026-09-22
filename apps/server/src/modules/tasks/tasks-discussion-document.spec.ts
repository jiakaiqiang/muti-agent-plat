import assert from 'node:assert/strict';
import test from 'node:test';
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

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    sessionId: 'session-document',
    title: 'Review方案',
    description: 'Review the discussion document',
    status: 'assigned',
    basedOnDiscussionDocument: {
      documentId: 'document-v1',
      revision: 1,
      contentHash: 'hash-v1'
    },
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

test('superseding a discussion document cancels unfinished ordinary tasks and marks them stale', () => {
  const persistence = makePersistence();
  const service = new TasksService(persistence as never);
  const pending = task({ status: 'pending' });
  const running = task({ status: 'running' });
  service.add(pending);
  service.add(running);

  service.markDiscussionDocumentSuperseded('session-document', { id: 'document-v2', revision: 2 });

  for (const candidate of [pending, running]) {
    assert.equal(candidate.status, 'cancelled');
    assert.equal(candidate.stale, true);
    assert.equal(candidate.staleReason, 'discussion_document_superseded');
    assert.match(candidate.resultSummary ?? '', /v1.*v2/);
  }
});

test('completed tasks remain historical while recording the superseded source document', () => {
  const persistence = makePersistence();
  const service = new TasksService(persistence as never);
  const completed = task({ status: 'completed', resultSummary: 'Delivered' });
  service.add(completed);

  service.markDiscussionDocumentSuperseded('session-document', { id: 'document-v2', revision: 2 });

  assert.equal(completed.status, 'completed');
  assert.equal(completed.resultSummary, 'Delivered');
  assert.equal(completed.stale, true);
  assert.equal(completed.staleReason, 'discussion_document_superseded');
});

test('workflow tasks keep their existing WorkflowRun semantics', () => {
  const persistence = makePersistence();
  const service = new TasksService(persistence as never);
  const workflowTask = task({ workflowRunId: 'workflow-run-1', status: 'running' });
  service.add(workflowTask);

  service.markDiscussionDocumentSuperseded('session-document', { id: 'document-v2', revision: 2 });

  assert.equal(workflowTask.status, 'running');
  assert.equal(workflowTask.stale, undefined);
  assert.equal(workflowTask.staleReason, undefined);
});

test('tasks already bound to the new active document are not changed', () => {
  const persistence = makePersistence();
  const service = new TasksService(persistence as never);
  const current = task({
    basedOnDiscussionDocument: { documentId: 'document-v2', revision: 2, contentHash: 'hash-v2' }
  });
  service.add(current);

  service.markDiscussionDocumentSuperseded('session-document', { id: 'document-v2', revision: 2 });

  assert.equal(current.status, 'assigned');
  assert.equal(current.stale, undefined);
});

