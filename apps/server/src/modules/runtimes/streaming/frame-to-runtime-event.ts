import type { AgentRuntimeEvent, UUID } from '@agent-cluster/shared';
import { nowIso } from '../../../common/time.js';
import {
  isAssistantTextFrame,
  isResultFrame,
  isStderrTailFrame,
  isSystemFrame,
  isToolResultFrame,
  isToolUseFrame,
  type RuntimeStreamFrame
} from './runtime-stream-frame.js';

/**
 * 将内部 `RuntimeStreamFrame` 翻译成 orchestrator 时间线用的
 * `AgentRuntimeEvent`。仅 adapter 侧使用,合同层不感知帧类型。
 */
export function frameToRuntimeEvent(runId: UUID, frame: RuntimeStreamFrame): AgentRuntimeEvent | undefined {
  const createdAt = nowIso();
  if (isToolUseFrame(frame)) {
    return {
      runId,
      type: 'tool_called',
      content: `调用工具 ${frame.tool}`,
      metadata: { toolCallId: frame.toolCallId, name: frame.tool, input: frame.input },
      createdAt
    };
  }
  if (isToolResultFrame(frame)) {
    return {
      runId,
      type: 'tool_completed',
      content: `工具 ${frame.tool} 完成`,
      metadata: {
        toolCallId: frame.toolCallId,
        name: frame.tool,
        output: frame.output,
        isError: frame.isError === true
      },
      createdAt
    };
  }
  if (isAssistantTextFrame(frame)) {
    if (!frame.text) return undefined;
    return {
      runId,
      type: 'runtime_progress',
      content: frame.text,
      metadata: { code: 'STREAM_TEXT' },
      createdAt
    };
  }
  if (isResultFrame(frame)) {
    return undefined;
  }
  if (isSystemFrame(frame)) {
    return {
      runId,
      type: 'runtime_progress',
      content: frame.subtype,
      metadata: { code: 'STREAM_SYSTEM', subtype: frame.subtype },
      createdAt
    };
  }
  if (isStderrTailFrame(frame)) {
    return {
      runId,
      type: 'runtime_progress',
      content: frame.text,
      metadata: { code: 'STREAM_STDERR' },
      createdAt
    };
  }
  return undefined;
}
