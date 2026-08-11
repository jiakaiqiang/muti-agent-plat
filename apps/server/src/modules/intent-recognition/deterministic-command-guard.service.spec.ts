import assert from 'node:assert/strict';
import test from 'node:test';
import { matchExactUserCommand } from './deterministic-command-guard.service.js';

test('matches exact command aliases after bounded normalization', () => {
  assert.equal(matchExactUserCommand('继续')?.command, 'resume');
  assert.equal(matchExactUserCommand(' 继续！ ')?.command, 'resume');
  assert.equal(matchExactUserCommand('CONTINUE')?.command, 'resume');
  assert.equal(matchExactUserCommand('重新执行。')?.command, 'retry');
  assert.equal(matchExactUserCommand('取消')?.command, 'cancel');
  assert.equal(matchExactUserCommand('确认')?.command, 'confirm');
});

test('does not capture natural-language messages containing command words', () => {
  assert.equal(matchExactUserCommand('继续补充实现审计日志'), undefined);
  assert.equal(matchExactUserCommand('继续之前先修改方案'), undefined);
  assert.equal(matchExactUserCommand('不要继续'), undefined);
  assert.equal(matchExactUserCommand('为什么不能继续？'), undefined);
});
