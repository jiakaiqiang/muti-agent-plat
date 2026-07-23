import type { JsonRpcMessage } from './codex-appserver-codec.js';
import type { RawUsage, RuntimeStreamFrame } from './runtime-stream-frame.js';
import { classifyRuntimeNotification } from '@agent-cluster/shared';

/**
 * 把 Codex app-server 的 JSON-RPC notification 翻译成 `RuntimeStreamFrame`。
 * 未知 method 或参数不合规 → `system` 帧兜底,不抛错(forward 兼容)。
 *
 * 详见 docs/design/multica-refactor-development-design-v1.md §3.4。
 */

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asRawUsage(v: unknown): RawUsage | undefined {
  const r = asRecord(v);
  if (!r) return undefined;
  return {
    inputTokens: typeof r.inputTokens === 'number' ? r.inputTokens : undefined,
    outputTokens: typeof r.outputTokens === 'number' ? r.outputTokens : undefined,
    cacheReadInputTokens:
      typeof r.cacheReadInputTokens === 'number' ? r.cacheReadInputTokens : undefined,
    cacheWriteInputTokens:
      typeof r.cacheWriteInputTokens === 'number' ? r.cacheWriteInputTokens : undefined
  };
}

function parseStructuredOutput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function threadItem(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return asRecord(params?.item);
}

function itemToolName(item: Record<string, unknown>): string {
  const type = asString(item.type) ?? 'unknown';
  if (type === 'commandExecution') return 'shell_command';
  if (type === 'fileChange') return 'apply_patch';
  if (type === 'mcpToolCall') {
    return `${asString(item.server) ?? 'mcp'}/${asString(item.tool) ?? 'tool'}`;
  }
  if (type === 'dynamicToolCall') return asString(item.tool) ?? 'dynamic_tool';
  return type;
}

function itemInput(item: Record<string, unknown>): unknown {
  switch (asString(item.type)) {
    case 'commandExecution':
      return { command: item.command, cwd: item.cwd };
    case 'fileChange':
      return { changes: item.changes };
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return item.arguments;
    default:
      return item;
  }
}

function itemOutput(item: Record<string, unknown>): string {
  const type = asString(item.type);
  if (type === 'commandExecution') return asString(item.aggregatedOutput) ?? '';
  if (type === 'fileChange') return JSON.stringify(item.changes ?? []);
  if (type === 'mcpToolCall') return JSON.stringify(item.result ?? item.error ?? {});
  if (type === 'dynamicToolCall') return JSON.stringify(item.contentItems ?? []);
  return JSON.stringify(item);
}

function isToolItem(item: Record<string, unknown>): boolean {
  return ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(
    asString(item.type) ?? ''
  );
}

function turnPayload(params: Record<string, unknown> | undefined): {
  payload: unknown;
  turnId?: string;
  status?: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  errorMessage?: string;
} {
  const turn = asRecord(params?.turn);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const agentMessages = items
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item?.type === 'agentMessage');
  const finalMessage = agentMessages.at(-1);
  const status = asString(turn?.status);
  const error = asRecord(turn?.error);
  return {
    payload: parseStructuredOutput(finalMessage?.text),
    turnId: asString(turn?.id),
    status:
      status === 'completed' || status === 'interrupted' || status === 'failed' || status === 'inProgress'
        ? status
        : undefined,
    errorMessage: asString(error?.message) ?? asString(error?.additionalDetails)
  };
}

export function parseCodexNotification(msg: JsonRpcMessage): RuntimeStreamFrame {
  const method = msg.method ?? '';
  const params = asRecord(msg.params);

  switch (method) {
    case 'item/agentMessage/delta': {
      const text = asString(params?.delta);
      if (text === undefined) break;
      return { kind: 'assistant_text', text };
    }
    case 'item/started': {
      const item = threadItem(params);
      const id = asString(item?.id);
      if (!item || !id || !isToolItem(item)) break;
      return {
        kind: 'tool_use',
        toolCallId: id,
        tool: itemToolName(item),
        input: itemInput(item)
      };
    }
    case 'item/completed': {
      const item = threadItem(params);
      const id = asString(item?.id);
      if (!item || !id) break;
      if (asString(item.type) === 'agentMessage') {
        return {
          kind: 'provider_output',
          payload: parseStructuredOutput(item.text),
          source: 'item/completed'
        };
      }
      if (!isToolItem(item)) break;
      const status = asString(item.status);
      return {
        kind: 'tool_result',
        toolCallId: id,
        tool: itemToolName(item),
        output: itemOutput(item),
        isError: status === 'failed' || status === 'declined'
      };
    }
    case 'thread/tokenUsage/updated': {
      const tokenUsage = asRecord(params?.tokenUsage);
      const last = asRecord(tokenUsage?.last);
      if (!last) break;
      return {
        kind: 'usage',
        usage: {
          inputTokens: typeof last.inputTokens === 'number' ? last.inputTokens : undefined,
          outputTokens: typeof last.outputTokens === 'number' ? last.outputTokens : undefined,
          cacheReadInputTokens:
            typeof last.cachedInputTokens === 'number' ? last.cachedInputTokens : undefined
        }
      };
    }
    case 'turn/completed': {
      if (!params) break;
      const parsed = turnPayload(params);
      return {
        kind: 'result',
        payload: parsed.payload,
        cliSessionId: asString(params.threadId),
        turnId: parsed.turnId,
        turnStatus: parsed.status,
        errorMessage: parsed.errorMessage
      };
    }
    default:
      // 落 system 分支
      break;
  }

  const subtype = method || 'unknown';
  const disposition = classifyRuntimeNotification('codex', subtype, params);
  return {
    kind: 'system',
    subtype,
    raw: msg,
    disposition: disposition === 'runtime_error' ? 'runtime_error' : 'debug_only'
  };
}
