/**
 * 内部统一帧类型:各 CLI adapter 的原生事件都归一化到本类型,再由
 * `frame-to-output.mapper` 与 `run-channel` 消费。**不进 shared 合同**——
 * 合同层只暴露 `AgentRuntimeEvent`。
 *
 * 详见 docs/design/multica-refactor-development-design-v1.md §3.2 与
 * docs/contracts/runtime-contract-v0.1.md §3.b。
 */

export type RawUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
};

export type AssistantTextFrame = { kind: 'assistant_text'; text: string };
/**
 * Authoritative structured output emitted by a provider before its terminal
 * lifecycle notification. Codex app-server v2 sends this as the completed
 * `agentMessage` item; `turn/completed` is authoritative for status/session,
 * but is not guaranteed to repeat the item body.
 */
export type ProviderOutputFrame = {
  kind: 'provider_output';
  payload: unknown;
  source: 'item/completed';
};
export type ToolUseFrame = {
  kind: 'tool_use';
  toolCallId: string;
  tool: string;
  input: unknown;
};
export type ToolResultFrame = {
  kind: 'tool_result';
  toolCallId: string;
  tool: string;
  output: string;
  isError?: boolean;
};
export type ResultFrame = {
  kind: 'result';
  payload: unknown;
  usage?: RawUsage;
  cliSessionId?: string;
  turnId?: string;
  turnStatus?: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  errorMessage?: string;
};
export type UsageFrame = { kind: 'usage'; usage: RawUsage };
export type SystemFrame = {
  kind: 'system';
  subtype: string;
  raw: unknown;
  disposition: 'debug_only' | 'runtime_error';
};
export type StderrTailFrame = { kind: 'stderr_tail'; text: string };

export type RuntimeStreamFrame =
  | AssistantTextFrame
  | ProviderOutputFrame
  | ToolUseFrame
  | ToolResultFrame
  | UsageFrame
  | ResultFrame
  | SystemFrame
  | StderrTailFrame;

export const isAssistantTextFrame = (f: RuntimeStreamFrame): f is AssistantTextFrame =>
  f.kind === 'assistant_text';
export const isProviderOutputFrame = (f: RuntimeStreamFrame): f is ProviderOutputFrame =>
  f.kind === 'provider_output';
export const isToolUseFrame = (f: RuntimeStreamFrame): f is ToolUseFrame => f.kind === 'tool_use';
export const isToolResultFrame = (f: RuntimeStreamFrame): f is ToolResultFrame =>
  f.kind === 'tool_result';
export const isResultFrame = (f: RuntimeStreamFrame): f is ResultFrame => f.kind === 'result';
export const isUsageFrame = (f: RuntimeStreamFrame): f is UsageFrame => f.kind === 'usage';
export const isSystemFrame = (f: RuntimeStreamFrame): f is SystemFrame => f.kind === 'system';
export const isStderrTailFrame = (f: RuntimeStreamFrame): f is StderrTailFrame =>
  f.kind === 'stderr_tail';

/**
 * Provider diagnostics prove that the transport is alive, but they do not
 * prove that the invocation is making progress. Repeated debug notifications
 * must not keep the idle watchdog alive forever.
 */
export const isRuntimeActivityFrame = (frame: RuntimeStreamFrame): boolean =>
  frame.kind !== 'system' && frame.kind !== 'stderr_tail';
