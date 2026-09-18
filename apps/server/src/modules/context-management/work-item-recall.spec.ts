import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkItem } from '@agent-cluster/shared';
import { buildWorkItemArchiveIndex, recallWorkItems } from './work-item-recall.js';

function workItem(index: number, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `work-${index}`, sessionId: 'session-1', title: `需求 ${index}`, goal: `实现需求 ${index} 的功能`,
    status: 'COMPLETED', revision: 1, createdFromEventId: `event-${index}`, inheritedDecisionIds: [], inheritedArtifactIds: [],
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(), updatedAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    ...overrides
  };
}

const hundred = [
  workItem(0, { title: '登录页改版', goal: '重做登录页并支持手机号验证码登录' }),
  ...Array.from({ length: 97 }, (_, index) => workItem(index + 1)),
  workItem(98, { title: '导出报表', goal: '支持 Excel 导出与分页' }),
  workItem(99, { title: '导出报表 v2', goal: '支持 CSV 与 Excel 导出', status: 'OPEN' })
];

test('an early requirement among a hundred is recalled by lexical match with its source', () => {
  const index = buildWorkItemArchiveIndex(hundred, []);
  assert.equal(index.entries.length, 100);
  const recall = recallWorkItems({ index, message: '之前那个登录页改版，手机号验证码的方案还在吗', limit: 5 });
  assert.equal(recall.availability, 'ok');
  assert.equal(recall.candidates[0]?.workItemId, 'work-0');
  assert.equal(recall.candidates[0]?.matchedBy, 'lexical');
  assert.ok(recall.candidates.length <= 5, 'recall is bounded');
  assert.equal(recall.needsClarification, false);
  assert.ok(recall.candidates[0]?.matchedTerms.includes('登录'), 'the match explains its source terms');
});

test('an explicit reference wins over lexical matches and is marked as explicit', () => {
  const index = buildWorkItemArchiveIndex(hundred, []);
  const recall = recallWorkItems({ index, message: '继续做导出', explicitWorkItemIds: ['work-42'], limit: 5 });
  assert.equal(recall.candidates[0]?.workItemId, 'work-42');
  assert.equal(recall.candidates[0]?.matchedBy, 'explicit');
  assert.equal(recall.needsClarification, false, 'an explicit reference is never ambiguous');
});

test('two similar requirements do not silently switch: the recall asks for clarification', () => {
  const index = buildWorkItemArchiveIndex(hundred, []);
  const recall = recallWorkItems({ index, message: '把导出报表那个继续做完', limit: 5 });
  const ids = recall.candidates.slice(0, 2).map((item) => item.workItemId).sort();
  assert.deepEqual(ids, ['work-98', 'work-99']);
  assert.equal(recall.needsClarification, true);
  assert.equal(recall.clarificationReason, 'multiple_similar_candidates');
});

test('no lexical hit returns no candidates and a clarification reason instead of guessing', () => {
  const index = buildWorkItemArchiveIndex(hundred, []);
  const recall = recallWorkItems({ index, message: '把那个也改一下', limit: 5 });
  assert.deepEqual(recall.candidates, []);
  assert.equal(recall.needsClarification, true);
  assert.equal(recall.clarificationReason, 'no_match');
});

test('an index failure is reported as limited availability, never as "history does not exist"', () => {
  const recall = recallWorkItems({
    index: { entries: [], availability: 'limited', reason: 'ARCHIVE_INDEX_UNAVAILABLE' },
    message: '登录页改版',
    limit: 5
  });
  assert.equal(recall.availability, 'limited');
  assert.equal(recall.needsClarification, true);
  assert.equal(recall.clarificationReason, 'index_unavailable');
});

test('the archive index carries checkpoint references but never full summaries or bodies', () => {
  const index = buildWorkItemArchiveIndex([hundred[0]], [{
    checkpointId: 'checkpoint-1', sessionId: 'session-1', workItemId: 'work-0', logicalKey: 'k', coveredEventSeq: 12,
    workItemRevision: 1, decisionLedgerRevision: 0, policyVersion: 'summary-checkpoint-v2', contentHash: 'h', phase: 'task_execution',
    summaryMemory: { goal: '重做登录页', currentState: 'x', confirmedFacts: ['一段很长很长的摘要正文'], completed: [], decisions: [], openQuestions: [], risks: [], nextSteps: [] },
    sourceEventIds: [], sourceArtifactIds: [], sourceMemoryIds: [], sourceDecisionIds: [], createdAt: '2026-09-17T00:00:00.000Z'
  }]);
  const entry = index.entries[0];
  assert.equal(entry.latestCheckpointId, 'checkpoint-1');
  assert.equal(entry.coveredEventSeq, 12);
  assert.equal(JSON.stringify(entry).includes('很长很长'), false, 'the index stores references, not bodies');
});
