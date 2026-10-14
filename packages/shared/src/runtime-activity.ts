import type { AgentRuntimeEvent } from './contracts.js';

export type RuntimeActivityKind = 'transport' | 'model_output' | 'reasoning' | 'tool_input' | 'tool_started' | 'tool_progress' | 'tool_result' | 'submission' | 'diagnostic';

export function runtimeActivityKind(event: AgentRuntimeEvent): RuntimeActivityKind {
  const metadata = event.metadata ?? {};
  if (metadata.progressReplay === true) return 'diagnostic';
  if (metadata.code === 'RUNTIME_REQUEST_OBSERVATION') {
    if (metadata.count === 0) return 'diagnostic';
    if (metadata.observationKind === 'reasoning_progress') return 'reasoning';
    if (metadata.observationKind === 'text_progress') return 'model_output';
    if (metadata.observationKind === 'tool_input_progress') return 'tool_input';
    if (metadata.observationKind === 'tool_progress') return 'tool_progress';
    return 'diagnostic';
  }
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
    const md = event.metadata ?? {};
    // Equal text alone is not replay identity: repeated tokens can be legitimate deltas.
    const nativeIdentity = md.eventId ?? md.sequence;
    const key = JSON.stringify([event.invocationId, event.type, md.toolCallId,
      nativeIdentity, nativeIdentity === undefined ? event.createdAt : undefined,
      nativeIdentity === undefined ? event.content : undefined]);
    if (seen.has(key)) return false;
    if (seen.size >= 4096) seen.delete(seen.values().next().value!);
    seen.add(key);
    return true;
  };
}
