import assert from 'node:assert/strict';
import test from 'node:test';
import {
  documentVersionTimeline,
  documentSectionChanges,
  discussionProgressView,
  type DocumentVersionSummary,
  type DiscussionProgressInput
} from './collaboration-presentation.js';

function version(overrides: Partial<DocumentVersionSummary> = {}): DocumentVersionSummary {
  return {
    documentId: 'doc-1',
    documentRevision: 1,
    workItemRevision: 3,
    contentHash: 'hash-1',
    status: 'formal',
    createdAt: '2026-09-19T00:00:00.000Z',
    ...overrides
  };
}

test('the timeline orders versions newest first and names the one the user must act on', () => {
  const timeline = documentVersionTimeline([
    version({ documentRevision: 1, contentHash: 'hash-1', status: 'superseded' }),
    version({ documentRevision: 3, contentHash: 'hash-3', status: 'formal' }),
    version({ documentRevision: 2, contentHash: 'hash-2', status: 'superseded' })
  ]);

  assert.deepEqual(timeline.versions.map((item) => item.documentRevision), [3, 2, 1]);
  assert.equal(timeline.current?.documentRevision, 3);
  assert.equal(timeline.current?.status, 'formal');
  // A formal-but-unconfirmed current version is what the confirmation card acts on.
  assert.equal(timeline.awaitingConfirmation, true);
});

test('a confirmed current version is not awaiting anything', () => {
  const timeline = documentVersionTimeline([
    version({ documentRevision: 1, status: 'superseded' }),
    version({ documentRevision: 2, status: 'confirmed', confirmationId: 'confirm-2' })
  ]);

  assert.equal(timeline.current?.documentRevision, 2);
  assert.equal(timeline.awaitingConfirmation, false);
  assert.equal(timeline.current?.confirmationId, 'confirm-2');
});

test('a card bound to an older version is shown as stale with the version the user should read', () => {
  const timeline = documentVersionTimeline([
    version({ documentRevision: 2, contentHash: 'hash-2' }),
    version({ documentRevision: 1, contentHash: 'hash-1', status: 'superseded' })
  ]);

  // Both ends must reach the same verdict from the same state, otherwise one
  // client keeps offering a button the server already refuses.
  assert.deepEqual(
    timeline.staleness({ documentId: 'doc-1', documentRevision: 1, contentHash: 'hash-1' }),
    { stale: true, currentRevision: 2, reason: 'revision_superseded' }
  );
  assert.deepEqual(
    timeline.staleness({ documentId: 'doc-1', documentRevision: 2, contentHash: 'hash-2' }),
    { stale: false, currentRevision: 2 }
  );
  // Same revision, different content is still a different document.
  assert.deepEqual(
    timeline.staleness({ documentId: 'doc-1', documentRevision: 2, contentHash: 'other' }),
    { stale: true, currentRevision: 2, reason: 'content_changed' }
  );
});

test('an empty timeline has nothing to confirm and no current version', () => {
  const timeline = documentVersionTimeline([]);

  assert.equal(timeline.current, undefined);
  assert.equal(timeline.awaitingConfirmation, false);
  assert.deepEqual(timeline.versions, []);
});

test('section changes name which parts of the document moved, not the whole body', () => {
  const changes = documentSectionChanges(
    {
      goal: '导出订单',
      scope: ['Excel 导出'],
      outOfScope: [],
      acceptanceCriteria: ['可打开'],
      risks: [],
      pendingItems: []
    },
    {
      goal: '导出订单与退款',
      scope: ['Excel 导出', 'CSV 导出'],
      outOfScope: [],
      acceptanceCriteria: ['可打开'],
      risks: ['列数过多'],
      pendingItems: []
    }
  );

  // Each end renders these with its own diff component; the set of changed
  // sections is business state and must match.
  assert.deepEqual(changes.changed.sort(), ['goal', 'risks', 'scope']);
  assert.deepEqual(changes.unchanged.sort(), ['acceptanceCriteria', 'outOfScope', 'pendingItems']);
  assert.equal(changes.hasChanges, true);
});

test('an identical revision reports no changed sections', () => {
  const sections = {
    goal: '导出订单',
    scope: ['Excel'],
    outOfScope: [],
    acceptanceCriteria: [],
    risks: [],
    pendingItems: []
  };

  const changes = documentSectionChanges(sections, { ...sections, scope: ['Excel'] });
  assert.deepEqual(changes.changed, []);
  assert.equal(changes.hasChanges, false);
});

function progress(overrides: Partial<DiscussionProgressInput> = {}): DiscussionProgressInput {
  return {
    status: 'consulting',
    objective: '确认导出范围',
    exitCondition: '两位专家给出结论',
    round: 1,
    roundLimit: 3,
    delegations: [
      { targetAgentId: 'architect', objective: '评估导出架构', status: 'completed', conclusion: '按 Excel 实现' },
      { targetAgentId: 'backend', objective: '评估导出接口', status: 'running' }
    ],
    ...overrides
  };
}

test('progress shows who is still working and who already answered', () => {
  const view = discussionProgressView(progress());

  assert.equal(view.headline, '正在咨询专家');
  assert.deepEqual(view.pending.map((item) => item.targetAgentId), ['backend']);
  assert.deepEqual(view.answered.map((item) => item.targetAgentId), ['architect']);
  assert.equal(view.roundLabel, '第 1/3 轮');
  assert.equal(view.awaitingUser, false);
});

test('a failed expert is surfaced, never hidden behind a completed round', () => {
  const view = discussionProgressView(progress({
    delegations: [
      { targetAgentId: 'architect', objective: 'a', status: 'completed', conclusion: 'ok' },
      { targetAgentId: 'backend', objective: 'b', status: 'failed', failureReason: 'Runtime 超时' }
    ]
  }));

  assert.deepEqual(view.failed.map((item) => item.targetAgentId), ['backend']);
  assert.equal(view.failed[0]?.failureReason, 'Runtime 超时');
  // A round with a failed required expert must not read as a complete answer.
  assert.equal(view.completeAnswer, false);
});

test('waiting on the user is its own state so neither end shows a spinner forever', () => {
  const view = discussionProgressView(progress({ status: 'waiting_user' }));

  assert.equal(view.awaitingUser, true);
  assert.equal(view.headline, '等待用户决定');
});

test('a closed run reads as ready and carries no pending experts', () => {
  const view = discussionProgressView(progress({
    status: 'ready_for_confirmation',
    delegations: [{ targetAgentId: 'architect', objective: 'a', status: 'completed', conclusion: 'ok' }]
  }));

  assert.equal(view.headline, '已形成综合结论');
  assert.deepEqual(view.pending, []);
  assert.equal(view.completeAnswer, true);
});

test('the view never carries expert prose beyond the conclusion it is asked to show', () => {
  const view = discussionProgressView(progress({
    delegations: [{
      targetAgentId: 'architect',
      objective: 'a',
      status: 'completed',
      conclusion: 'ok',
      privateReasoning: 'chain of thought that must not reach a client'
    } as DiscussionProgressInput['delegations'][number]]
  }));

  assert.equal(
    JSON.stringify(view).includes('chain of thought'),
    false,
    'private model reasoning must not be projected to either client'
  );
});
