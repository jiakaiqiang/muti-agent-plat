import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHANGE_REQUEST_CONTRACT_VERSION,
  canTransitionChangeRequest,
  changeRequestLogicalKey,
  isChangeAnalysisCurrent,
  splitExecutionMessageSegments,
  type ChangeRequestBase,
  type ChangeRequestStatus
} from './change-request-contracts.js';

function base(overrides: Partial<ChangeRequestBase> = {}): ChangeRequestBase {
  return {
    sessionId: 'session-1',
    workItemId: 'wi-1',
    workItemRevision: 3,
    workflowRunId: 'run-1',
    documentId: 'doc-1',
    documentRevision: 2,
    ...overrides
  };
}

test('the contract version is pinned so a stored request cannot be read under new rules', () => {
  assert.equal(CHANGE_REQUEST_CONTRACT_VERSION, 'change-request-v1');
});

test('one source message is one change request, whatever the retry count', () => {
  const first = changeRequestLogicalKey({ base: base(), sourceEventId: 'event-1' });
  const replay = changeRequestLogicalKey({ base: base(), sourceEventId: 'event-1' });

  assert.equal(first, replay, 'a resubmitted message is the same request, not a second one');
  assert.match(first, /change-request-v1/);
  assert.match(first, /event-1/);
});

test('the same words against a different requirement version are different requests', () => {
  // The analysis is only valid for the version it was produced against, so the
  // key has to carry it; otherwise a revised requirement would reuse an
  // analysis of the old one.
  const before = changeRequestLogicalKey({ base: base({ workItemRevision: 3 }), sourceEventId: 'event-1' });
  const after = changeRequestLogicalKey({ base: base({ workItemRevision: 4 }), sourceEventId: 'event-1' });

  assert.notEqual(before, after);
});

test('a change request only moves forward through its lifecycle', () => {
  const forward: Array<[ChangeRequestStatus, ChangeRequestStatus]> = [
    ['received', 'analyzing'],
    ['analyzing', 'waiting_user'],
    ['waiting_user', 'stopping'],
    ['stopping', 'revising'],
    ['revising', 'waiting_confirmation'],
    ['waiting_confirmation', 'ready']
  ];
  for (const [from, to] of forward) {
    assert.equal(canTransitionChangeRequest(from, to), true, `${from} -> ${to} must be allowed`);
  }

  // Side exits stay reachable while a request is still open.
  assert.equal(canTransitionChangeRequest('waiting_user', 'deferred'), true);
  assert.equal(canTransitionChangeRequest('waiting_user', 'rejected'), true);

  // A resolved request is final: nothing may reopen it, so a late analysis or a
  // replayed click cannot resurrect an abandoned change.
  for (const from of ['ready', 'rejected'] as ChangeRequestStatus[]) {
    assert.equal(canTransitionChangeRequest(from, 'analyzing'), false, `${from} must not reopen`);
    assert.equal(canTransitionChangeRequest(from, 'waiting_user'), false, `${from} must not reopen`);
  }
  // Deferred is the one resolved state the user can pick up again after the
  // current run ends; it reopens only into analysis, never straight to ready.
  assert.equal(canTransitionChangeRequest('deferred', 'analyzing'), true);
  assert.equal(canTransitionChangeRequest('deferred', 'ready'), false);
});

test('an analysis is current only while the versions it was produced against still hold', () => {
  const analysis = { base: base(), analysisRevision: 1 };

  assert.equal(isChangeAnalysisCurrent(analysis, base()), true);
  assert.equal(
    isChangeAnalysisCurrent(analysis, base({ workItemRevision: 4 })),
    false,
    'a revised requirement invalidates the impact analysis'
  );
  assert.equal(
    isChangeAnalysisCurrent(analysis, base({ documentRevision: 3 })),
    false,
    'a republished document invalidates the impact analysis'
  );
  assert.equal(
    isChangeAnalysisCurrent(analysis, base({ workflowRunId: 'run-2' })),
    false,
    'a different run is a different execution to analyse'
  );
});

test('a message carrying a stop and a supplement is split, with the stop first', () => {
  const segments = splitExecutionMessageSegments([
    { intent: 'constraint', content: '顺便加一个导出按钮', priority: 'normal' },
    { intent: 'command', content: '先停下来', priority: 'high' },
    { intent: 'question', content: '现在做到哪一步了', priority: 'normal' }
  ]);

  // A stop buried in the middle of a long message must still be handled first;
  // the rest is persisted as pending work rather than dropped.
  assert.equal(segments[0]?.intent, 'command');
  assert.equal(segments.length, 3, 'no segment may be discarded');
  assert.deepEqual(
    segments.slice(1).map((item) => item.intent),
    ['constraint', 'question']
  );
});

test('segment order is stable for equal priorities so a replay produces the same plan', () => {
  const input = [
    { intent: 'question' as const, content: 'a', priority: 'normal' as const },
    { intent: 'constraint' as const, content: 'b', priority: 'normal' as const }
  ];

  assert.deepEqual(
    splitExecutionMessageSegments(input).map((item) => item.content),
    splitExecutionMessageSegments(input).map((item) => item.content)
  );
  assert.deepEqual(splitExecutionMessageSegments(input).map((item) => item.content), ['a', 'b']);
});

test('an empty message produces no segments instead of an empty placeholder', () => {
  assert.deepEqual(splitExecutionMessageSegments([]), []);
});
