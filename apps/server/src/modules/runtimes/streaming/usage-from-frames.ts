import type { RuntimeModelProvider, RuntimeUsage } from '@agent-cluster/shared';
import { usageFromStreamFrame } from '../runtime-cache-capability.js';
import type { RawUsage, RuntimeStreamFrame } from './runtime-stream-frame.js';

/**
 * Settled usage for one CLI run, taken from the frames the parser produced.
 *
 * Both CLI runners used to read `inputTokens`/`outputTokens` here and discard
 * the cache counters the parsers had already extracted, so a fully cached
 * prompt settled at full price. The provider decides how the counters relate:
 * Claude's input excludes the cached prefix, Codex's (OpenAI Responses) input
 * includes it as a subset.
 *
 * Codex emits cumulative `usage` frames, so the last one is authoritative; the
 * terminal `result` frame is the fallback when no `usage` frame arrived.
 */
export function runtimeUsageFromFrames(
  frames: readonly RuntimeStreamFrame[],
  target: { provider: RuntimeModelProvider; model: string }
): RuntimeUsage {
  let raw: RawUsage | undefined;
  for (const frame of frames) {
    if (frame.kind === 'usage') raw = frame.usage;
  }
  if (!raw) {
    const result = frames.find((frame) => frame.kind === 'result');
    raw = result?.kind === 'result' ? result.usage : undefined;
  }

  return usageFromStreamFrame({
    provider: target.provider,
    model: target.model,
    frame: raw ?? {}
  });
}
