import type { AgentRuntimeEvent, UUID } from '../contracts.js';
import { nowIso } from '../time.js';
import {
  isAssistantTextFrame,
  isProviderOutputFrame,
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
export function frameToRuntimeEvent(invocationId: UUID, frame: RuntimeStreamFrame): AgentRuntimeEvent | undefined {
  const createdAt = nowIso();
  if (isToolUseFrame(frame)) {
    return {
      invocationId,
      type: 'tool_called',
      content: `调用工具 ${frame.tool}`,
      visibility: 'user',
      metadata: { toolCallId: frame.toolCallId, name: frame.tool, input: frame.input },
      createdAt
    };
  }
  if (isToolResultFrame(frame)) {
    return {
      invocationId,
      type: 'tool_completed',
      content: `工具 ${frame.tool} 完成`,
      visibility: 'user',
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
      invocationId,
      type: 'runtime_progress',
      content: frame.text,
      visibility: 'debug',
      metadata: { code: 'STREAM_TEXT' },
      createdAt
    };
  }
  if (isResultFrame(frame)) {
    return undefined;
  }
  if (isSystemFrame(frame)) {
    if (frame.disposition === 'runtime_error') {
      return {
        invocationId,
        type: 'runtime_failed',
        content: 'Runtime provider reported an internal service startup failure.',
        visibility: 'user',
        metadata: {
          code: 'RUNTIME_PROVIDER_NOTIFICATION_ERROR',
          runtimeError: {
            code: 'MODEL_ERROR',
            message: `Runtime provider notification failed: ${frame.subtype}`,
            retryable: true,
            details: { providerMethod: frame.subtype }
          }
        },
        createdAt
      };
    }
    return {
      invocationId,
      type: 'runtime_progress',
      content: frame.subtype,
      visibility: 'debug',
      metadata: { code: 'STREAM_SYSTEM', subtype: frame.subtype, raw: frame.raw },
      createdAt
    };
  }
  if (isProviderOutputFrame(frame)) {
    // The completed structured payload belongs to the strict output boundary,
    // not to the user-visible streaming timeline.
    return undefined;
  }
  if (isStderrTailFrame(frame)) {
    return {
      invocationId,
      type: 'runtime_progress',
      content: frame.text,
      visibility: 'debug',
      metadata: { code: 'STREAM_STDERR' },
      createdAt
    };
  }
  return undefined;
}
