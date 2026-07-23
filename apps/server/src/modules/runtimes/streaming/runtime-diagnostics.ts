import {
  isKnownRuntimeNotification,
  type RuntimeDiagnostics,
  type RuntimeProvider
} from '@agent-cluster/shared';
import type { RuntimeStreamFrame } from './runtime-stream-frame.js';

export function buildRuntimeDiagnostics(
  provider: RuntimeProvider,
  frames: RuntimeStreamFrame[],
  stderrTail?: string
): RuntimeDiagnostics {
  const providerNotifications = frames
    .filter((frame) => frame.kind === 'system')
    .map((frame) => ({
      method: frame.subtype,
      disposition: frame.disposition,
      payload: frame.raw
    }));

  return {
    providerNotifications,
    unknownNotificationCount: providerNotifications.filter(
      (notification) => !isKnownRuntimeNotification(provider, notification.method)
    ).length,
    stderrTail: stderrTail ?? null
  };
}
