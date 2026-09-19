import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changeQueueView,
  type ChangeQueueInput,
  type ChangeQueueItem
} from './change-queue-projection.js';

function item(overrides: Partial<ChangeQueueItem> = {}): ChangeQueueItem {
  return {
    id: 'change-1',
    summary: '顺便加一个导出按钮',
    status: 'waiting_user',
    raisedAt: '2026-09-19T00:00:00.000Z',
    workItemRevision: 3,
    documentRevision: 2,
    ...overrides
  };
}

function input(overrides: Partial<ChangeQueueInput> = {}): ChangeQueueInput {
  return {
    items: [item()],
    currentWorkItemRevision: 3,
    currentDocumentRevision: 2,
    ...overrides
  };
}

test('the queue is ordered by when each change was raised, newest last', () => {
  const view = changeQueueView(input({
    items: [
      item({ id: 'change-2', raisedAt: '2026-09-19T02:00:00.000Z', summary: '第二条' }),
      item({ id: 'change-1', raisedAt: '2026-09-19T00:00:00.000Z', summary: '第一条' }),
      item({ id: 'change-3', raisedAt: '2026-09-19T01:00:00.000Z', summary: '第三条' })
    ]
  }));

  // Both ends must show the same order; a queue that reshuffles between clients
  // makes "the next requirement" mean two different things.
  assert.deepEqual(view.items.map((entry) => entry.id), ['change-1', 'change-3', 'change-2']);
});

test('a change waiting on the user is separated from one already parked', () => {
  const view = changeQueueView(input({
    items: [
      item({ id: 'waiting', status: 'waiting_user' }),
      item({ id: 'parked', status: 'deferred', raisedAt: '2026-09-19T01:00:00.000Z' })
    ]
  }));

  assert.deepEqual(view.awaitingUser.map((entry) => entry.id), ['waiting']);
  assert.deepEqual(view.deferred.map((entry) => entry.id), ['parked']);
  assert.equal(view.needsDecision, true, 'a change waiting on the user is an open question');
});

test('a queue with nothing waiting asks nothing of the user', () => {
  const view = changeQueueView(input({
    items: [item({ status: 'deferred' })]
  }));

  assert.equal(view.needsDecision, false);
  assert.deepEqual(view.awaitingUser, []);
  assert.equal(view.deferred.length, 1);
});

test('a change raised against a superseded version is marked stale with the reason', () => {
  const view = changeQueueView(input({
    items: [
      item({ id: 'current' }),
      item({ id: 'old-requirement', workItemRevision: 2, raisedAt: '2026-09-19T01:00:00.000Z' }),
      item({ id: 'old-document', documentRevision: 1, raisedAt: '2026-09-19T02:00:00.000Z' })
    ]
  }));

  const byId = new Map(view.items.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('current')?.stale, false);
  assert.equal(byId.get('old-requirement')?.stale, true);
  assert.equal(byId.get('old-requirement')?.staleReason, 'work_item_revision_changed');
  assert.equal(byId.get('old-document')?.stale, true);
  assert.equal(byId.get('old-document')?.staleReason, 'document_revision_changed');
  // A stale analysis must be re-run, not presented as a live choice.
  assert.deepEqual(view.staleItems.map((entry) => entry.id), ['old-requirement', 'old-document']);
});

test('resolved changes are not part of the queue at all', () => {
  const view = changeQueueView(input({
    items: [
      item({ id: 'open', status: 'waiting_user' }),
      item({ id: 'done', status: 'ready', raisedAt: '2026-09-19T01:00:00.000Z' }),
      item({ id: 'dropped', status: 'rejected', raisedAt: '2026-09-19T02:00:00.000Z' })
    ]
  }));

  assert.deepEqual(view.items.map((entry) => entry.id), ['open'], 'a finished change is history, not queue');
  assert.equal(view.total, 1);
});

test('a queued change never reads as authorised to execute', () => {
  const view = changeQueueView(input({
    items: [item({ status: 'deferred' })]
  }));

  // AC6: the queue existing is not an execution grant. Both ends render this
  // from the same flag so neither offers a "start now" shortcut.
  assert.equal(view.grantsExecution, false);
  assert.equal(view.requiresReconfirmation, true);
});

test('an empty queue is empty, not a placeholder row', () => {
  const view = changeQueueView({ items: [], currentWorkItemRevision: 3, currentDocumentRevision: 2 });

  assert.deepEqual(view.items, []);
  assert.equal(view.total, 0);
  assert.equal(view.needsDecision, false);
});

test('the view carries the user summary and versions, never model reasoning', () => {
  const view = changeQueueView(input({
    items: [item({ privateReasoning: 'chain of thought that must not reach a client' } as never)]
  }));

  assert.equal(JSON.stringify(view).includes('chain of thought'), false);
  assert.equal(view.items[0]?.summary, '顺便加一个导出按钮');
});

test('the same state always projects the same view', () => {
  const state = input({
    items: [item({ id: 'a' }), item({ id: 'b', raisedAt: '2026-09-19T01:00:00.000Z', status: 'deferred' })]
  });

  assert.deepEqual(changeQueueView(state), changeQueueView(state));
});
