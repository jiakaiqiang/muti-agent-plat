import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionRecord, SummaryMemory } from '@agent-cluster/shared';
import { deriveSummaryMemory, reconcileOpenQuestions } from './summary-memory-derivation.js';

function decision(overrides: Partial<DecisionRecord>): DecisionRecord {
  return {
    id: 'decision-1', sessionId: 'session-1', workItemId: 'work-1', kind: 'constraint', status: 'confirmed',
    content: '导出支持 CSV', sourceEventId: 'event-1', revision: 1,
    createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z', ...overrides
  };
}

const base = {
  goal: '实现导出',
  currentState: 'EXECUTING / task_execution',
  confirmedFacts: ['Session status: EXECUTING'],
  completed: [],
  nextSteps: ['继续实现'],
  risks: []
};

test('superseded decisions never survive into the effective summary, even when a prior checkpoint carried them', () => {
  const previous: SummaryMemory = {
    goal: '实现导出', currentState: 'old', confirmedFacts: [], completed: [],
    decisions: ['[decision-1] 导出支持 CSV'], openQuestions: [], risks: [], nextSteps: []
  };
  const derived = deriveSummaryMemory({
    ...base,
    previous,
    decisions: [
      decision({ id: 'decision-1', status: 'superseded' }),
      decision({ id: 'decision-2', content: '导出只支持 Excel', supersedesDecisionId: 'decision-1' })
    ]
  });
  assert.deepEqual(derived.decisions, ['[decision-2] 导出只支持 Excel']);
  assert.deepEqual(derived.sourceDecisionIds, ['decision-2']);
  assert.equal(JSON.stringify(derived).includes('支持 CSV'), false, 'the old decision must not leak back via the previous checkpoint');
});

test('proposed decisions are not promoted to confirmed facts', () => {
  const derived = deriveSummaryMemory({
    ...base,
    decisions: [decision({ id: 'decision-9', status: 'proposed', content: '可能改用向量检索' })]
  });
  assert.deepEqual(derived.decisions, []);
  assert.equal(JSON.stringify(derived.confirmedFacts).includes('向量检索'), false);
});

test('open questions distinguish add, update and resolve instead of accumulating', () => {
  const reconciled = reconcileOpenQuestions({
    previous: ['是否支持 CSV？', '是否需要分页？'],
    current: ['是否需要分页？', '分页大小多少？'],
    resolvedBy: [decision({ id: 'decision-2', content: '导出只支持 Excel，不支持 CSV' })]
  });
  assert.deepEqual(reconciled.open, ['是否需要分页？', '分页大小多少？']);
  assert.deepEqual(reconciled.added, ['分页大小多少？']);
  assert.deepEqual(reconciled.resolved, ['是否支持 CSV？']);
});

test('event prose is not accepted as a confirmed fact without a DecisionRecord', () => {
  const derived = deriveSummaryMemory({ ...base, decisions: [] });
  assert.deepEqual(derived.decisions, []);
  assert.equal(derived.confirmedFacts.some((fact) => fact.startsWith('Event:')), false);
});

test('revised requirements drop stale facts and retain only current confirmed constraints and acceptance', () => {
  const previous: SummaryMemory = {
    goal: '导出 CSV', currentState: 'old', confirmedFacts: ['旧版只需 CSV'], completed: [],
    decisions: ['[decision-1] 导出 CSV'], openQuestions: [], risks: [], nextSteps: []
  };
  const derived = deriveSummaryMemory({
    ...base,
    previous,
    requirementChanged: true,
    constraints: ['只能导出 Excel'],
    acceptanceCriteria: ['Excel 文件可下载'],
    decisions: [decision({ id: 'decision-1', status: 'superseded' }),
      decision({ id: 'decision-2', content: '只允许 Excel', supersedesDecisionId: 'decision-1' })]
  });
  assert.equal(JSON.stringify(derived).includes('旧版只需 CSV'), false);
  assert.ok(derived.confirmedFacts.includes('Constraint: 只能导出 Excel'));
  assert.ok(derived.confirmedFacts.includes('Acceptance: Excel 文件可下载'));
  assert.deepEqual(derived.decisions, ['[decision-2] 只允许 Excel']);
});
