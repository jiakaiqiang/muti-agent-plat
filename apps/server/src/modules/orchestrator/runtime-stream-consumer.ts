import type {
  AgentRuntimeEvent,
  CollaborationEventType,
  EventMetadata,
  EventRenderType,
  InvocationPlan,
  UUID
} from '@agent-cluster/shared';
import { shouldPublishRuntimeEventToCollaboration } from '@agent-cluster/shared';

export type StreamConsumerDeps = {
  events: { create: (arg: StreamEventCreateInput) => unknown };
  createMetadata: <TPayload extends Record<string, unknown>>(
    kind: EventRenderType | undefined,
    extra: TPayload
  ) => EventMetadata<TPayload>;
  onPublished?: (frame: AgentRuntimeEvent) => void;
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

export async function consumeRuntimeEvents(
  iterator: AsyncIterable<AgentRuntimeEvent>,
  plan: InvocationPlan,
  deps: StreamConsumerDeps
): Promise<void> {
  try {
    for await (const frame of iterator) {
      const record = frameToEventArg(frame, plan, deps);
      if (record) {
        deps.events.create(record);
        deps.onPublished?.(frame);
      }
    }
  } catch {
    // A broken diagnostic stream must not interrupt the adapter result promise.
  }
}

function frameToEventArg(
  frame: AgentRuntimeEvent,
  plan: InvocationPlan,
  deps: StreamConsumerDeps
): StreamEventCreateInput | undefined {
  const metadata = (frame.metadata ?? {}) as Record<string, unknown>;
  if (!shouldPublishRuntimeEventToCollaboration({
    type: frame.type,
    visibility: frame.visibility,
    code: metadata.code
  })) {
    return undefined;
  }

  const base = {
    sessionId: plan.sessionId,
    taskId: plan.taskId,
    fromAgentId: plan.agent.agentId,
    content: frame.content ?? '',
    metadata: undefined as EventMetadata | undefined
  };

  switch (frame.type) {
    case 'tool_called': {
      const md = (frame.metadata ?? {}) as Record<string, unknown>;
      return {
        ...base,
        type: 'tool_called',
        content: frame.content || `Invoke tool ${asString(md.name) || 'unknown'}`,
        metadata: deps.createMetadata('tool_card', {
          runtimeInvocationId: plan.invocationId,
          toolCallId: md.toolCallId,
          name: md.name,
          input: md.input
        })
      };
    }
    case 'tool_completed': {
      const md = (frame.metadata ?? {}) as Record<string, unknown>;
      const output = typeof md.output === 'string' ? md.output : safeJson(md.output);
      return {
        ...base,
        type: 'tool_completed',
        content: frame.content || `Tool ${asString(md.name) || 'unknown'} completed`,
        metadata: deps.createMetadata('tool_card', {
          runtimeInvocationId: plan.invocationId,
          toolCallId: md.toolCallId,
          name: md.name,
          isError: md.isError === true,
          outputPreview: output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS)
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
          runtimeInvocationId: plan.invocationId,
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
          runtimeInvocationId: plan.invocationId,
          ...md
        })
      };
    }
    case 'runtime_started':
    case 'runtime_completed':
    case 'runtime_failed':
      return undefined;
    default:
      return undefined;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}
