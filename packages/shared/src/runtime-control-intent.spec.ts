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

test('explicit runtime continuation accepts task wording and a direct address', () => {
  for (const text of [
    '你使用codex 进行处理\n', '使用codex继续进行任务', '使用 Codex 继续执行当前任务',
    '请你使用 Codex 恢复当前任务', '用 Codex 继续处理剩下的任务', '使用 Codex 继续工作'
  ]) {
    const result = parseRuntimeControlIntent(text);
    assert.equal(result?.kind, 'switch', text);
    if (result?.kind !== 'switch') continue;
    assert.equal(result.input.targetRuntimeType, 'codex', text);
    assert.equal(result.input.resumeAfterSwitch, true, text);
    assert.equal(result.input.scope, 'work_item', text);
  }
  const claude = parseRuntimeControlIntent('你使用 Claude Code 继续进行任务');
  assert.equal(claude?.kind === 'switch' && claude.input.targetRuntimeType, 'claude_code');
  const paused = parseRuntimeControlIntent('你使用 Codex 继续执行当前任务，先不要执行');
  assert.equal(paused?.kind === 'switch' && paused.input.resumeAfterSwitch, false);
});

test('task continuation grammar does not claim new requirements, questions or refusals', () => {
  for (const text of [
    '你不要使用 Codex 进行处理', '请你别用 Codex 继续进行任务',
    '你使用 Codex 进行处理可以吗', '如果使用 Codex 继续执行当前任务',
    '使用 Codex 继续实现登录功能', '使用 Codex 继续处理支付任务',
    '使用 Codex 继续当前任务并删除数据库', '请你使用 Claude 编写登录页面',
    '使用 Codex 继续任务，但不要执行', '你使用 Codex 进行处理是否合适'
  ]) assert.equal(parseRuntimeControlIntent(text), undefined, text);
});
