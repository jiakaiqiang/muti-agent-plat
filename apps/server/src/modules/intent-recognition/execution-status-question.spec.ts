import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchExecutionConsultationQuestion,
  matchExecutionScopeChange,
  matchExecutionStatusQuestion
} from './deterministic-command-guard.service.js';

test('a plain progress question is recognised without a model call', () => {
  for (const content of [
    '现在做到哪一步了',
    '做到哪里了？',
    '进度如何',
    '当前进展怎么样',
    'what is the progress',
    'how far along are we?',
    'status?'
  ]) {
    const matched = matchExecutionStatusQuestion(content);
    assert.ok(matched, `expected a status question: ${content}`);
    assert.equal(matched.reasonCode, 'EXECUTION_STATUS_QUESTION');
  }
});

test('a message that also changes scope is not a read-only question', () => {
  // The whole point of the short circuit is that it answers without touching the
  // contract. Anything carrying a requirement must stay on the semantic router.
  for (const content of [
    '进度如何？顺便加一个导出按钮',
    '做到哪一步了，另外把接口改成分页',
    'what is the progress, also add a CSV export'
  ]) {
    assert.equal(matchExecutionStatusQuestion(content), undefined, `must not short circuit: ${content}`);
  }
});

test('a control command is never treated as a status question', () => {
  for (const content of ['停止', '暂停', '取消', 'stop', 'cancel', '继续']) {
    assert.equal(matchExecutionStatusQuestion(content), undefined, `must not short circuit: ${content}`);
  }
});

test('a question about a specific expert stays a consultation, not a status read', () => {
  for (const content of ['@架构 这个改动影响大吗', '架构上会有什么影响？']) {
    assert.equal(matchExecutionStatusQuestion(content), undefined, `must not short circuit: ${content}`);
  }
});

test('an overlong message is not short circuited even if it starts like a question', () => {
  assert.equal(matchExecutionStatusQuestion(`进度如何${'补充说明'.repeat(60)}`), undefined);
});

test('an empty message matches nothing', () => {
  assert.equal(matchExecutionStatusQuestion('   '), undefined);
});

test('an @ question about impact is a consultation, not a scope change', () => {
  for (const content of [
    '这个改动对架构影响大吗？',
    '这样做会不会有性能问题',
    '接口这样改是否可行？',
    'does this affect the api contract?',
    'would this break the export flow'
  ]) {
    const matched = matchExecutionConsultationQuestion(content);
    assert.ok(matched, `expected a consultation question: ${content}`);
    assert.equal(matched.reasonCode, 'EXECUTION_CONSULTATION_QUESTION');
  }
});

test('a message carrying a requirement is not a consultation even when phrased as a question', () => {
  // These change scope, so they must reach the change-request path (AC3) rather
  // than being answered as a read-only consultation.
  for (const content of [
    '能不能顺便加一个导出按钮？',
    '把接口改成分页可以吗',
    'can you also add a CSV export?'
  ]) {
    assert.equal(matchExecutionConsultationQuestion(content), undefined, `must not short circuit: ${content}`);
  }
});

test('a control command or a bare statement is not a consultation', () => {
  for (const content of ['停止', 'cancel', '继续执行', '导出要包含退款明细']) {
    assert.equal(matchExecutionConsultationQuestion(content), undefined, `must not short circuit: ${content}`);
  }
});

test('an overlong consultation message stays on the semantic router', () => {
  assert.equal(matchExecutionConsultationQuestion(`影响大吗？${'补充说明'.repeat(60)}`), undefined);
});

test('a supplement during execution is recognised as a scope change', () => {
  for (const content of [
    '顺便加一个导出按钮',
    '另外把接口改成分页',
    '还要支持退款明细',
    'also add a CSV export',
    'additionally the export needs refunds'
  ]) {
    const matched = matchExecutionScopeChange(content);
    assert.ok(matched, `expected a scope change: ${content}`);
    assert.equal(matched.reasonCode, 'EXECUTION_SCOPE_CHANGE');
  }
});

test('a read-only question or a control command is not a scope change', () => {
  for (const content of ['进度如何', '做到哪一步了', '停止', 'cancel', '这个改动影响大吗？']) {
    assert.equal(matchExecutionScopeChange(content), undefined, `must not raise a change: ${content}`);
  }
});

test('an overlong supplement stays on the semantic router', () => {
  assert.equal(matchExecutionScopeChange(`顺便加一个导出按钮${'补充说明'.repeat(60)}`), undefined);
});
