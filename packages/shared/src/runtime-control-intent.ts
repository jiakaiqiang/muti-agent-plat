import { matchRuntimeSwitchCommand, resolveRuntimeAlias } from './runtime-alias.js';
import type { RuntimeSwitchInput } from './runtime-switch-contracts.js';

export type RuntimeControlIntent =
  | { kind: 'switch'; source: 'chat_command' | 'natural_language'; input: Omit<RuntimeSwitchInput, 'idempotencyKey'> }
  | { kind: 'clarify'; message: string };

// Only generic references to the existing task count as execution control.
// A concrete requirement after the Runtime name must still reach intent routing.
const CONTINUATION_SUFFIX = /[,，\s]*(?:(?:继续|恢复)\s*(?:(?:执行|运行|进行|处理)\s*)?(?:(?:当前|原来|之前|剩余|剩下的)?(?:任务|工作)|把剩下的(?:做完|完成))?|进行处理)$/u;

/** Closed control grammar: never let a business classifier cancel a running process. */
export function parseRuntimeControlIntent(content: string): RuntimeControlIntent | undefined {
  let text = content.normalize('NFKC').trim().replace(/[。！!]+$/u, '').trim();
  if (text.startsWith('/runtime')) {
    const parts = text.split(/\s+/u);
    const target = parts[2] === 'fallback' ? 'fallback' : resolveRuntimeAlias(parts[2] ?? '');
    const flags = parts.slice(3);
    if (parts[0] !== '/runtime' || parts[1] !== 'switch' || !target ||
        flags.some(flag => !['--continue', '--pause', '--after-step', '--session', '--target-only'].includes(flag)) ||
        (flags.includes('--continue') && flags.includes('--pause'))) {
      return { kind: 'clarify', message: '请使用 /runtime switch codex|claude_code|fallback，可添加 --continue、--pause、--after-step 或 --session。' };
    }
    return { kind: 'switch', source: 'chat_command', input: {
      targetRuntimeType: target, resumeAfterSwitch: flags.includes('--continue') ? true : flags.includes('--pause') ? false : undefined,
      timing: flags.includes('--after-step') ? 'after_step' : 'immediate',
      scope: flags.includes('--session') ? 'session' : 'work_item',
      fallbackMode: flags.includes('--target-only') ? 'target_only' : 'exclude_previous_once'
    } };
  }
  if (!text || text.length > 200 || /[?？“”"`]|是否|要不要|会不会|假如|如果|比如|例如|比较|对比|不要切|别切|不切换/u.test(text)) return undefined;
  text = text.replace(/^(?:请帮我|帮我|现在请|现在|我想要|我要)[,，\s]*/u, '');
  text = text.replace(/^(?:请)?你\s*/u, '');
  const scope = /^(?:后面|以后)?(?:整个|本次)?会话(?:都)?/u.test(text) ? 'session' : 'work_item';
  text = text.replace(/^(?:后面|以后)?(?:整个|本次)?会话(?:都)?[,，\s]*/u, '');
  const afterStep = /^(?:下一步(?:开始)?|当前(?:这)?一步(?:完成|结束)后|这一步(?:完成|结束)后)/u.test(text);
  text = text.replace(/^(?:下一步(?:开始)?|当前(?:这)?一步(?:完成|结束)后|这一步(?:完成|结束)后)[,，\s]*/u, '');
  text = text.replace(/^(?:codex|claude(?: code)?|主(?:运行时|runtime))\s*(?:卡住了|失效了|出错了|不可用了)[,，\s]*/iu, '');
  const pause = /[,，\s]*(?:先)?(?:不要|别)(?:执行|运行|继续)$/u.test(text);
  text = text.replace(/[,，\s]*(?:先)?(?:不要|别)(?:执行|运行|继续)$/u, '');
  const continuing = CONTINUATION_SUFFIX.test(text);
  text = text.replace(CONTINUATION_SUFFIX, '');
  const fallback = /^(?:请)?(?:切换到|切到|改用|换成|换到|用|使用)(?:下一个)?备用(?:的|运行时|runtime)?$/iu.test(text);
  const match = matchRuntimeSwitchCommand(text);
  if (!fallback && !match) {
    if (/^(?:请)?(?:切换到|切到|换成|改用)\s*[\p{L}\p{N}_ .-]{1,30}$/u.test(text) || /^(?:请)?换(?:一个|个)(?:模型|运行时|runtime)$/iu.test(text)) {
      return { kind: 'clarify', message: '请明确要切换到 Codex、Claude Code，还是已配置的备用 Runtime。模型名称与 Runtime 名称需要分别指定。' };
    }
    return undefined;
  }
  return { kind: 'switch', source: 'natural_language', input: {
    targetRuntimeType: fallback ? 'fallback' : match!.targetRuntimeType,
    resumeAfterSwitch: pause ? false : continuing || afterStep || match?.resumeAfterSwitch ? true : undefined,
    scope, timing: afterStep ? 'after_step' : 'immediate',
    fallbackMode: match?.fallbackMode ?? 'exclude_previous_once'
  } };
}
