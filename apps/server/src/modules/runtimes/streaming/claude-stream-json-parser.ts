import type { RuntimeStreamFrame } from './runtime-stream-frame.js';

/**
 * 把 Claude Code CLI `--output-format stream-json` 的一行 JSON 事件翻译成
 * 一或多个 `RuntimeStreamFrame`。见 docs/task-trans/M2-01。
 *
 * - 一行 assistant 可能同时含多个 content(text + tool_use),需要展开
 * - tool_result 帧需要根据 tool_use_id 回填 tool 名(便于时间线展示)
 * - 空行 / 非 JSON 行返回空数组
 */

export function parseClaudeLine(line: string): RuntimeStreamFrame[] {
  return new ClaudeStreamJsonParser().feedLine(line);
}

export class ClaudeStreamJsonParser {
  private readonly toolNames = new Map<string, string>();

  feedLine(line: string): RuntimeStreamFrame[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
      msg = parsed as Record<string, unknown>;
    } catch {
      return [];
    }
    const type = typeof msg.type === 'string' ? msg.type : '';
    switch (type) {
      case 'assistant':
        return this.fromAssistant(msg);
      case 'user':
        return this.fromUser(msg);
      case 'result':
        return this.fromResult(msg);
      case 'system':
        return [
          {
            kind: 'system',
            subtype: typeof msg.subtype === 'string' ? msg.subtype : 'unknown',
            raw: msg,
            disposition: 'debug_only'
          }
        ];
      default:
        return [];
    }
  }

  private fromAssistant(msg: Record<string, unknown>): RuntimeStreamFrame[] {
    const message = (msg.message ?? {}) as Record<string, unknown>;
    const contents = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
    const out: RuntimeStreamFrame[] = [];
    for (const item of contents) {
      const itemType = typeof item.type === 'string' ? item.type : '';
      if (itemType === 'text') {
        out.push({ kind: 'assistant_text', text: typeof item.text === 'string' ? item.text : '' });
      } else if (itemType === 'tool_use') {
        const id = typeof item.id === 'string' ? item.id : '';
        const name = typeof item.name === 'string' ? item.name : '';
        if (id && name) this.toolNames.set(id, name);
        out.push({
          kind: 'tool_use',
          toolCallId: id,
          tool: name,
          input: item.input
        });
      }
    }
    return out;
  }

  private fromUser(msg: Record<string, unknown>): RuntimeStreamFrame[] {
    const message = (msg.message ?? {}) as Record<string, unknown>;
    const contents = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
    const out: RuntimeStreamFrame[] = [];
    for (const item of contents) {
      if (item.type !== 'tool_result') continue;
      const id = typeof item.tool_use_id === 'string' ? item.tool_use_id : '';
      const contentField = item.content;
      const output =
        typeof contentField === 'string'
          ? contentField
          : Array.isArray(contentField)
            ? contentField
                .map((c: unknown) => (c && typeof c === 'object' && 'text' in (c as Record<string, unknown>) ? String((c as Record<string, unknown>).text ?? '') : ''))
                .join('')
            : '';
      out.push({
        kind: 'tool_result',
        toolCallId: id,
        tool: this.toolNames.get(id) ?? '',
        output,
        isError: item.is_error === true
      });
    }
    return out;
  }

  private fromResult(msg: Record<string, unknown>): RuntimeStreamFrame[] {
    const usageRaw = (msg.usage ?? {}) as Record<string, unknown>;
    const inputTokens = typeof usageRaw.input_tokens === 'number' ? usageRaw.input_tokens : undefined;
    const outputTokens = typeof usageRaw.output_tokens === 'number' ? usageRaw.output_tokens : undefined;
    const cacheRead = typeof usageRaw.cache_read_input_tokens === 'number' ? usageRaw.cache_read_input_tokens : undefined;
    const cacheWrite = typeof usageRaw.cache_creation_input_tokens === 'number' ? usageRaw.cache_creation_input_tokens : undefined;
    const errors = Array.isArray(msg.errors)
      ? msg.errors.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    const failed = msg.is_error === true || typeof msg.subtype === 'string' && msg.subtype !== 'success';
    return [
      {
        kind: 'result',
        payload: parseResultPayload(msg.result),
        usage:
          inputTokens !== undefined || outputTokens !== undefined || cacheRead !== undefined || cacheWrite !== undefined
            ? {
                inputTokens,
                outputTokens,
                cacheReadInputTokens: cacheRead,
                cacheWriteInputTokens: cacheWrite
              }
            : undefined,
        cliSessionId: typeof msg.session_id === 'string' ? msg.session_id : undefined,
        turnStatus: failed ? 'failed' : 'completed',
        errorMessage: failed ? errors.join('\n') || 'Claude Code result reported an error.' : undefined
      }
    ];
  }
}

function parseResultPayload(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { content: value, messageKind: 'summary' };
  }
}
