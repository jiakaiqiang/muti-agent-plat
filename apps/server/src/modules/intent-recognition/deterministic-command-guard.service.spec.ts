import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchCompoundExecutionControl,
  matchExactUserCommand,
  matchWorkflowAgentDirective,
  matchWorkflowAgentSkipCommand
} from './deterministic-command-guard.service.js';

test('a compound pause keeps the non-control suffix for the follow-up path', () => {
  assert.deepEqual(matchCompoundExecutionControl('先停下来，另外把接口改成分页'), {
    command: 'pause',
    remainder: '另外把接口改成分页',
    normalizedText: '先停下来,另外把接口改成分页',
    reasonCode: 'COMPOUND_PAUSE_BEFORE_FOLLOW_UP'
  });
  assert.equal(matchCompoundExecutionControl('暂停'), undefined);
  assert.equal(matchCompoundExecutionControl('请不要暂停，继续执行'), undefined);
});

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

test('matches only bounded workflow Agent skip-and-continue instructions', () => {
  assert.ok(matchWorkflowAgentSkipCommand('跳过这个 Agent，继续执行'));
  assert.ok(matchWorkflowAgentSkipCommand('请跳过测试工程师然后继续后续流程。'));
  assert.ok(matchWorkflowAgentSkipCommand('Skip the current agent and continue execution'));
  assert.equal(matchWorkflowAgentSkipCommand('不要跳过这个 Agent，继续执行'), undefined);
  assert.equal(matchWorkflowAgentSkipCommand('讨论一下是否应该跳过测试 Agent'), undefined);
  assert.equal(matchWorkflowAgentSkipCommand('跳过这个 Agent 后修改原需求'), undefined);
});

test('extracts the target Agent from bounded assignment directives', () => {
  const zh = matchWorkflowAgentDirective('让前端工程师执行');
  assert.equal(zh?.kind, 'assign_agent');
  assert.equal(zh?.targetText, '前端工程师');
  assert.equal(matchWorkflowAgentDirective('改派给测试工程师')?.targetText, '测试工程师');
  assert.equal(matchWorkflowAgentDirective('请让架构师来处理这个节点')?.targetText, '架构师');
  assert.equal(matchWorkflowAgentDirective('交给后端工程师负责')?.targetText, '后端工程师');
  assert.equal(matchWorkflowAgentDirective('换成 reviewer 执行')?.targetText, 'reviewer');
  const en = matchWorkflowAgentDirective('assign it to the frontend engineer');
  assert.equal(en?.kind, 'assign_agent');
  assert.equal(en?.targetText, 'frontend engineer');
  assert.equal(matchWorkflowAgentDirective('have the architect run')?.targetText, 'architect');
});

test('extracts the target node from bounded upstream rerun directives', () => {
  const zh = matchWorkflowAgentDirective('退回架构设计节点重新执行');
  assert.equal(zh?.kind, 'rerun_upstream');
  assert.equal(zh?.targetText, '架构设计');
  assert.equal(matchWorkflowAgentDirective('回到需求分析阶段重新执行')?.targetText, '需求分析');
  assert.equal(matchWorkflowAgentDirective('让架构师重新执行')?.kind, 'assign_agent');
  const en = matchWorkflowAgentDirective('go back to the architecture node and rerun');
  assert.equal(en?.kind, 'rerun_upstream');
  assert.equal(en?.targetText, 'architecture');
});

test('does not capture questions, negations, or ordinary requirements', () => {
  assert.equal(matchWorkflowAgentDirective('让前端工程师执行吗？'), undefined);
  assert.equal(matchWorkflowAgentDirective('不要让前端工程师执行'), undefined);
  assert.equal(matchWorkflowAgentDirective('讨论一下是否让架构师执行'), undefined);
  assert.equal(matchWorkflowAgentDirective('为什么让前端工程师执行'), undefined);
  assert.equal(matchWorkflowAgentDirective('让登录页面支持记住密码'), undefined);
  assert.equal(matchWorkflowAgentDirective('让系统在超时后自动重试三次并记录日志'), undefined);
  assert.equal(matchWorkflowAgentDirective(`让${'超长'.repeat(80)}执行`), undefined);
});
