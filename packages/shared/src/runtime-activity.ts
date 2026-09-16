import type { AgentRuntimeEvent } from './contracts.js';

export type RuntimeActivityKind = 'transport' | 'model_output' | 'tool_started' | 'tool_progress' | 'tool_result' | 'submission' | 'diagnostic';

export function runtimeActivityKind(event: AgentRuntimeEvent): RuntimeActivityKind {
  const metadata = event.metadata ?? {};
  if (metadata.code === 'RUNTIME_HEARTBEAT' || /heartbeat|keepalive/i.test(String(metadata.method ?? ''))) return 'transport';
  if (metadata.code === 'STREAM_TEXT' && event.type === 'runtime_progress' && event.content.trim()) return 'model_output';
  if (event.visibility === 'debug' || event.type === 'runtime_failed' || metadata.isError === true) return 'diagnostic';
  if (metadata.name === 'StructuredOutput' && event.type === 'tool_completed') return 'submission';
  if (event.type === 'tool_called') return 'tool_started';
  if (event.type === 'tool_completed') return 'tool_result';
  if (event.type === 'runtime_progress' && metadata.toolCallId) return 'tool_progress';
  if (event.type === 'runtime_progress' && event.content.trim() && !metadata.code) return 'model_output';
  return 'diagnostic';
}

export function usefulRuntimeActivity() {
  const seen = new Set<string>();
  return (event: AgentRuntimeEvent) => {
    const kind = runtimeActivityKind(event);
    if (kind === 'transport' || kind === 'diagnostic') return false;
    const key = JSON.stringify([event.invocationId, event.type, event.metadata?.toolCallId,
      event.metadata?.sequence, event.metadata?.eventId, event.content]);
    if (seen.has(key)) return false;
    if (seen.size >= 4096) seen.delete(seen.values().next().value!);
    seen.add(key);
    return true;
  };
}
