import type { AgentRuntimeEvent } from './contracts.js';
import { frameToRuntimeEvent } from './runtime-streaming/frame-to-runtime-event.js';
import type { RuntimeObservationKind } from './runtime-request-health.js';

/** exec JSONL has no provider request-query endpoint. Only observed events are reported. */
export function codexExecObserver(invocationId: string, emit: (event: AgentRuntimeEvent) => void) {
  let sequence = 0;
  const lengths = new Map<string, number>();
  return (line: string) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;
    const item = message.item && typeof message.item === 'object' ? message.item as Record<string, unknown> : {};
    const type = String(message.type ?? '');
    let kind: RuntimeObservationKind | undefined;
    let count: number | undefined;
    if (type === 'turn.started') kind = 'request_started';
    else if (type === 'turn.failed' || type === 'error') kind = 'provider_error';
    else if (type.startsWith('item.') && item.type === 'reasoning' && typeof item.text === 'string' && item.text) {
      kind = 'reasoning_progress'; count = item.text.length;
    } else if (type.startsWith('item.') && item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
      kind = 'text_progress'; count = item.text.length;
    } else if (type.startsWith('item.') && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(String(item.type))) {
      kind = type === 'item.started' ? 'tool_started' : type === 'item.completed' ? 'tool_completed' : 'tool_progress';
    }
    if (!kind) return;
    const itemId = typeof item.id === 'string' ? item.id : undefined;
    if (itemId && count !== undefined) {
      const previous = lengths.get(`${kind}:${itemId}`) ?? 0;
      if (count <= previous) return; // exec updates are cumulative; final replay is not fresh activity.
      if (lengths.size >= 4096) lengths.delete(lengths.keys().next().value!);
      lengths.set(`${kind}:${itemId}`, count);
      count -= previous;
    }
    if (kind === 'tool_progress') {
      const text = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      const previous = itemId ? lengths.get(`tool:${itemId}`) ?? 0 : 0;
      if (text.length <= previous) return;
      count = text.length - previous;
      if (itemId) {
        if (lengths.size >= 4096) lengths.delete(lengths.keys().next().value!);
        lengths.set(`tool:${itemId}`, text.length);
      }
    }
    const event = frameToRuntimeEvent(invocationId, { kind: 'observation', observationKind: kind, count, sequence: ++sequence,
      toolCallId: typeof item.id === 'string' ? item.id : undefined,
      eventId: typeof message.id === 'string' ? message.id : typeof item.id === 'string' && type !== 'item.updated'
        ? `exec:${type}:${item.id}` : `exec:${sequence}` });
    if (event) emit(event);
  };
}
