// 帧定义已移到 @agent-cluster/shared/runtime-streaming,供 server 与
// local-runtime-cli 共用。保留此处 re-export,现有 import 路径不受影响。
export type {
  AssistantTextFrame,
  ProviderOutputFrame,
  RawUsage,
  ResultFrame,
  RuntimeStreamFrame,
  StderrTailFrame,
  SystemFrame,
  ToolResultFrame,
  ToolUseFrame,
  UsageFrame
} from '@agent-cluster/shared';
export {
  isAssistantTextFrame,
  isProviderOutputFrame,
  isResultFrame,
  isRuntimeActivityFrame,
  isStderrTailFrame,
  isSystemFrame,
  isToolResultFrame,
  isToolUseFrame,
  isUsageFrame
} from '@agent-cluster/shared';
