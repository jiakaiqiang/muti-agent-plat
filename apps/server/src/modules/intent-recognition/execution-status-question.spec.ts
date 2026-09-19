import assert from 'node:assert/strict';
import test from 'node:test';
import { matchExecutionStatusQuestion } from './deterministic-command-guard.service.js';

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
