import type { AgentRuntimeAdapter } from '@agent-cluster/shared';

/**
 * Keep a low-frequency heartbeat fallback for every Runtime handle.
 * Streaming activity suppresses individual heartbeats at the call site.
 */
export function shouldEmitHeartbeat(
  _adapter: AgentRuntimeAdapter | undefined,
  _hasStreamingEvents = false
): boolean {
  return true;
}
