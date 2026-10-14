import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntimeControlIntent } from './runtime-control-intent.js';

test('commands and explicit natural language preserve target, timing, scope and continuation', () => {
  for (const text of ['/runtime switch claude_code --continue', '换成 Claude，继续把剩下的做完', '切换到 Claude Code 继续']) {
    const result = parseRuntimeControlIntent(text);
    assert.equal(result?.kind, 'switch', text);
    if (result?.kind === 'switch') {
      assert.equal(result.input.targetRuntimeType, 'claude_code');
      assert.equal(result.input.resumeAfterSwitch, true);
      assert.equal(result.input.scope, 'work_item');
    }
  }
  const next = parseRuntimeControlIntent('下一步开始用 Claude');
  assert.equal(next?.kind === 'switch' && next.input.timing, 'after_step');
  const pause = parseRuntimeControlIntent('切到 Claude，先不要执行');
  assert.equal(pause?.kind === 'switch' && pause.input.resumeAfterSwitch, false);
  const fallback = parseRuntimeControlIntent('Codex 卡住了，用备用的继续');
  assert.equal(fallback?.kind === 'switch' && fallback.input.targetRuntimeType, 'fallback');
  const session = parseRuntimeControlIntent('整个会话都用 Claude');
  assert.equal(session?.kind === 'switch' && session.input.scope, 'session');
});

test('questions, quotes, negation and business requirements cannot switch execution', () => {
  for (const text of ['Claude 会不会更适合这个任务？', '不要切换到 Claude', '如果切换到 Claude 会怎么样',
    '请实现一个切换到 Claude 的按钮', '“切换到 Claude”', '比较 Codex 和 Claude', '使用 Claude 编写登录页面']) {
    assert.equal(parseRuntimeControlIntent(text), undefined, text);
  }
  assert.equal(parseRuntimeControlIntent('/runtime switch typo --continue')?.kind, 'clarify');
  assert.equal(parseRuntimeControlIntent('/runtime switch codex --continue --pause')?.kind, 'clarify');
});
