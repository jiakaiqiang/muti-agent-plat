import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionRecord, WorkItem } from '@agent-cluster/shared';
import { effectiveConstraintContents } from './effective-decisions.js';

const work = (id: string, inheritedDecisionIds: string[] = []) => ({ id, inheritedDecisionIds } as WorkItem);
const decision = (id: string, workItemId: string, kind: DecisionRecord['kind'], content: string, extra = {}) =>
  ({ id, workItemId, kind, content, status: 'confirmed', revision: 1, ...extra } as DecisionRecord);

test('inherited constraint corrections remain local through consecutive replacements', () => {
  const decisions = [decision('parent-timeout', 'parent', 'constraint', '10 分钟'),
    decision('child-first', 'child', 'correction', '30 分钟', { overridesDecisionId: 'parent-timeout', status: 'superseded' }),
    decision('child-second', 'child', 'correction', '45 分钟', { supersedesDecisionId: 'child-first', overridesDecisionId: 'parent-timeout' })];
  assert.deepEqual(effectiveConstraintContents(decisions, work('parent')), ['10 分钟']);
  assert.deepEqual(effectiveConstraintContents(decisions, work('sibling', ['parent-timeout'])), ['10 分钟']);
  assert.deepEqual(effectiveConstraintContents(decisions, work('child', ['parent-timeout'])), ['45 分钟']);
});

test('requirement replacements, missing ancestry and cycles never become confirmed constraints', () => {
  const decisions = [decision('goal', 'work', 'requirement', '旧目标', { status: 'superseded' }),
    decision('new-goal', 'work', 'correction', '新目标', { supersedesDecisionId: 'goal' }),
    decision('missing', 'work', 'correction', '缺失来源', { supersedesDecisionId: 'absent' }),
    decision('cycle-a', 'work', 'correction', '循环 A', { supersedesDecisionId: 'cycle-b' }),
    decision('cycle-b', 'work', 'correction', '循环 B', { supersedesDecisionId: 'cycle-a' })];
  assert.deepEqual(effectiveConstraintContents(decisions, work('work')), []);
});
