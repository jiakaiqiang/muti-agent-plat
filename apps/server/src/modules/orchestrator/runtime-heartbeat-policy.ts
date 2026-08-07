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

/**
 * setInterval may fire a few milliseconds early. When the suppression threshold
 * equals the heartbeat interval, that jitter reads as "activity just happened"
 * and swallows a beat, so the elapsed counter jumps (180s straight to 240s).
 * A small tolerance keeps timer drift from dropping heartbeats.
 */
const HEARTBEAT_TIMER_JITTER_TOLERANCE_MS = 1_000;

export function shouldSuppressHeartbeat(
  now: number,
  lastVisibleRuntimeActivityAt: number,
  intervalMs: number
): boolean {
  return now - lastVisibleRuntimeActivityAt < intervalMs - HEARTBEAT_TIMER_JITTER_TOLERANCE_MS;
}
