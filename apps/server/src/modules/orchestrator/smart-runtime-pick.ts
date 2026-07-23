import type { AgentRunPhase, RuntimeType } from '@agent-cluster/shared';

export type SmartRuntimePickInput = {
  phase: AgentRunPhase;
  requiresCodeChanges: boolean;
};

/**
 * codex/claude_code 属于"落地代码"的执行时运行时，其他阶段（讨论、契约生成、复盘、
 * 交付、消息路由等）都是产结构化 JSON 的 LLM 工作，应该走 generic_llm。
 * 早期实现只看 requiresCodeChanges，会把 brief_generation 也丢给 codex CLI，
 * 触发 CODEX_RUNTIME_TIMEOUT_MS（默认 600s）阻塞，见事故记忆。
 */
export function smartRuntimePick(input: SmartRuntimePickInput): RuntimeType {
  if (input.phase !== 'task_execution') return 'generic_llm';
  if (input.requiresCodeChanges) return 'codex';
  return 'code_reader';
}
