import type {
  AgentRunInput,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  CollaborationEventType,
  EventMetadata,
  EventRenderType,
  UUID
} from '@agent-cluster/shared';

/**
 * 并发消费一个 adapter 的 stream() iterator,把每一帧翻译成 events.create 调用。
 *
 * 目标(见 docs/task-trans/M1-15-orchestrator-consume-stream.md 与
 * docs/design/multica-refactor-development-design-v1.md §3.7):
 * - tool_called/tool_completed/artifact_created/runtime_progress 帧直接落到时间线
 * - tool_completed 的 output 截断到前 200 字符, 避免时间线爆炸
 * - adapter 无 stream 方法时保持沉默, 由 orchestrator 心跳兜底
 *
 * 该函数不 await 任何长事务, 调用点用 `void consumeRuntimeStream(...)` 并发,
 * 由 adapter iterator 自然终结时 promise resolve。
 */

export type StreamConsumerDeps = {
  events: { create: (arg: StreamEventCreateInput) => unknown };
  createMetadata: <TPayload extends Record<string, unknown>>(
    kind: EventRenderType | undefined,
    extra: TPayload
  ) => EventMetadata<TPayload>;
};

type StreamEventCreateInput = {
  sessionId: UUID;
  type: CollaborationEventType;
  content: string;
  taskId?: UUID;
  fromAgentId?: UUID;
  metadata?: EventMetadata;
};

const TOOL_OUTPUT_PREVIEW_CHARS = 200;

export async function consumeRuntimeStream(
  adapter: AgentRuntimeAdapter | undefined,
  input: AgentRunInput,
  deps: StreamConsumerDeps
): Promise<void> {
  if (!adapter?.stream) return;
  return consumeRuntimeEvents(adapter.stream(input.runId), input, deps);
}

export async function consumeRuntimeEvents(
  iterator: AsyncIterable<AgentRuntimeEvent>,
  input: AgentRunInput,
  deps: StreamConsumerDeps
): Promise<void> {
  try {
    for await (const frame of iterator) {
      const record = frameToEventArg(frame, input, deps);
      if (record) deps.events.create(record);
    }
  } catch {
    // adapter stream 崩溃不应打断主 run promise; adapter.run 结果里会记录错误
  }
}

function frameToEventArg(
  frame: AgentRuntimeEvent,
  input: AgentRunInput,
  deps: StreamConsumerDeps
): StreamEventCreateInput | undefined {
  const base = {
    sessionId: input.sessionId,
    taskId: input.taskId,
    fromAgentId: input.agent.id,
    content: frame.content ?? '',
    metadata: undefined as EventMetadata | undefined
  };

  switch (frame.type) {
    case 'tool_called': {
      const md = (frame.metadata ?? {}) as Record<string, unknown>;
      return {
        ...base,
        type: 'tool_called',
        content: frame.content || `调用工具 ${asString(md.name) || 'unknown'}`,
        metadata: deps.createMetadata('tool_card', {
          runtimeInvocationId: input.runId,
          toolCallId: md.toolCallId,
          name: md.name,
          input: md.input
        })
      };
    }
    case 'tool_completed': {
      const md = (frame.metadata ?? {}) as Record<string, unknown>;
      const outputStr = typeof md.output === 'string' ? md.output : safeJson(md.output);
      const outputPreview = outputStr.slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
      return {
        ...base,
        type: 'tool_completed',
        content: frame.content || `工具 ${asString(md.name) || 'unknown'} 完成`,
        metadata: deps.createMetadata('tool_card', {
          runtimeInvocationId: input.runId,
          toolCallId: md.toolCallId,
          name: md.name,
          isError: md.isError === true,
          outputPreview
        })
      };
    }
    case 'artifact_created': {
      const md = (frame.metadata ?? {}) as Record<string, unknown>;
      return {
        ...base,
        type: 'artifact_created',
        content: frame.content || asString(md.title) || 'artifact',
        metadata: deps.createMetadata('artifact_card', {
          runtimeInvocationId: input.runId,
          ...md
        })
      };
    }
    case 'runtime_progress': {
      const md = (frame.metadata ?? {}) as Record<string, unknown>;
      return {
        ...base,
        type: 'runtime_progress',
        content: frame.content || '',
        metadata: deps.createMetadata('system_notice', {
          runtimeInvocationId: input.runId,
          ...md
        })
      };
    }
    case 'runtime_started':
    case 'runtime_completed':
    case 'runtime_failed':
      // 由 adapter.run 结果统一记录, stream 阶段忽略避免重复
      return undefined;
    default:
      return undefined;
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? '');
  } catch {
    return '';
  }
}
