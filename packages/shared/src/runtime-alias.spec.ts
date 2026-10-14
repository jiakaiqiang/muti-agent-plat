import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchRuntimeSwitchCommand,
  resolveRuntimeAlias,
  runtimeDisplayName
} from './runtime-alias.js';

test('display names come from one registry shared by every surface', () => {
  assert.equal(runtimeDisplayName('codex'), 'Codex');
  assert.equal(runtimeDisplayName('claude_code'), 'Claude Code');
  assert.equal(runtimeDisplayName('generic_llm'), '通用大模型');
});

test('an alias resolves to a RuntimeType regardless of spacing, case or punctuation', () => {
  for (const alias of ['claude code', 'Claude Code', 'claude-code', 'claudecode', 'claude', 'CC']) {
    assert.equal(resolveRuntimeAlias(alias), 'claude_code', `${alias} names Claude Code`);
  }
  for (const alias of ['codex', 'Codex', 'CODEX']) {
    assert.equal(resolveRuntimeAlias(alias), 'codex', `${alias} names Codex`);
  }
  assert.equal(resolveRuntimeAlias('克劳德'), 'claude_code', 'the common Chinese rendering is an alias too');
});

test('an unknown name is not guessed at', () => {
  // Refusing is what keeps "switch to Cursor" an actionable error instead of a
  // silent switch to whichever Runtime happened to sort first.
  for (const alias of ['cursor', 'copilot', 'gpt', '', '   ', 'claude coder pro max']) {
    assert.equal(resolveRuntimeAlias(alias), undefined, `${JSON.stringify(alias)} is not a known Runtime`);
  }
});

test('a switch command names its target and whether to resume', () => {
  assert.deepEqual(matchRuntimeSwitchCommand('切换到 Claude Code'), {
    targetRuntimeType: 'claude_code',
    resumeAfterSwitch: false,
    fallbackMode: undefined,
    normalizedText: '切换到 claude code',
    reasonCode: 'RUNTIME_SWITCH_COMMAND'
  });
  // The compound form is the one the Spec calls out: switching and resuming are
  // one instruction, so the user never has to click continue afterwards (AC2).
  assert.deepEqual(matchRuntimeSwitchCommand('切换到 Claude Code 继续'), {
    targetRuntimeType: 'claude_code',
    resumeAfterSwitch: true,
    fallbackMode: undefined,
    normalizedText: '切换到 claude code 继续',
    reasonCode: 'RUNTIME_SWITCH_COMMAND'
  });
});

test('every documented switch verb is accepted, in both languages', () => {
  const commands = [
    '切换到 Codex',
    '改用 Codex',
    '换成 Codex',
    '用 Codex 继续',
    '使用 Codex',
    '请切换到 Codex 执行',
    'switch to Codex',
    'use Codex',
    'switch to Codex and continue'
  ];
  for (const content of commands) {
    assert.equal(
      matchRuntimeSwitchCommand(content)?.targetRuntimeType,
      'codex',
      `${content} is a switch command`
    );
  }
  assert.equal(matchRuntimeSwitchCommand('用 Codex 继续')?.resumeAfterSwitch, true);
  assert.equal(matchRuntimeSwitchCommand('switch to Codex and continue')?.resumeAfterSwitch, true);
  assert.equal(matchRuntimeSwitchCommand('使用 Codex')?.resumeAfterSwitch, false);
});

test('only Codex may be used names target_only, because it excludes the rest', () => {
  assert.equal(matchRuntimeSwitchCommand('只用 Codex')?.fallbackMode, 'target_only');
  assert.equal(matchRuntimeSwitchCommand('只能用 Codex')?.fallbackMode, 'target_only');
  assert.equal(matchRuntimeSwitchCommand('only use Codex')?.fallbackMode, 'target_only');
  // Plain switching leaves the mode to the caller's default, which is
  // exclude_previous_once; the parser must not invent it here.
  assert.equal(matchRuntimeSwitchCommand('切换到 Codex')?.fallbackMode, undefined);
});

test('a question about a Runtime is never a switch', () => {
  // Spec §7.1 names these explicitly: answering them by switching would take an
  // irreversible action on a message that asked for an opinion.
  const questions = [
    '为什么使用 Claude Code',
    '为什么用 Claude Code？',
    '比较 Codex 和 Claude Code',
    'Codex 和 Claude Code 有什么区别',
    '能不能切换到 Claude Code',
    '可以用 Codex 吗',
    '是否应该改用 Codex',
    'why are we using Claude Code',
    'should we switch to Codex?',
    'can we use Codex',
    'what is the difference between Codex and Claude Code'
  ];
  for (const content of questions) {
    assert.equal(matchRuntimeSwitchCommand(content), undefined, `${content} is a question, not a command`);
  }
});

test('a requirement that merely mentions a Runtime is not a switch', () => {
  const requirements = [
    '给 Claude Code 的调用加上重试日志',
    '顺便把 Codex 的超时时间调大',
    '修复 Claude Code 适配器的解析错误',
    '文档里补充 Codex 的配置说明'
  ];
  for (const content of requirements) {
    assert.equal(matchRuntimeSwitchCommand(content), undefined, `${content} is work, not a control command`);
  }
});

test('a negated or unknown target is refused rather than half-understood', () => {
  assert.equal(matchRuntimeSwitchCommand('不要切换到 Claude Code'), undefined, 'a refusal is not a request');
  assert.equal(matchRuntimeSwitchCommand('别用 Codex'), undefined);
  assert.equal(matchRuntimeSwitchCommand('切换到 Cursor'), undefined, 'an unknown Runtime cannot be resolved');
  assert.equal(matchRuntimeSwitchCommand('切换到'), undefined, 'no target at all is not a command');
  assert.equal(matchRuntimeSwitchCommand('切换'), undefined);
});

test('an overlong message is left to semantic routing', () => {
  // A deterministic guard exists to catch short explicit control text. A long
  // message that happens to start with a switch verb is far more likely to be a
  // requirement, and misreading it would stop a healthy run.
  const long = `切换到 Codex ${'补充说明'.repeat(60)}`;
  assert.ok(long.length > 200);
  assert.equal(matchRuntimeSwitchCommand(long), undefined);
});

test('the pause command keeps its own meaning', () => {
  // 暂停/继续 are existing exact commands with their own stateful handling; a
  // Runtime switch parser must not absorb them.
  assert.equal(matchRuntimeSwitchCommand('继续'), undefined);
  assert.equal(matchRuntimeSwitchCommand('暂停'), undefined);
  assert.equal(matchRuntimeSwitchCommand('恢复执行'), undefined);
});
