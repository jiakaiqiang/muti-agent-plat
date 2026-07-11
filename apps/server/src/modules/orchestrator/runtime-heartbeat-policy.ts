import type { AgentRuntimeAdapter } from '@agent-cluster/shared';

/**
 * 决定 orchestrator 是否需要合成 `RUNTIME_HEARTBEAT` 事件。
 *
 * 见 docs/task-trans/M1-16-orchestrator-heartbeat-fallback.md 与
 * docs/design/multica-refactor-development-design-v1.md §3.7:
 * - adapter 提供 stream() 时, 时间线由真事件驱动, 心跳属于噪音
 * - adapter 未提供 stream() 时(mock / generic_llm / codex legacy 分支),
 *   仍需心跳让用户知道慢模型还活着
 */
export function shouldEmitHeartbeat(
  adapter: AgentRuntimeAdapter | undefined,
  hasStreamingEvents = typeof adapter?.stream === 'function'
): boolean {
  if (!adapter) return true;
  return !hasStreamingEvents;
}
