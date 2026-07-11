import type { AgentRunInput, RuntimeType } from '@agent-cluster/shared';
import type { WatchdogTimeoutObservation } from './liveness-watchdog.js';

const STDERR_SUMMARY_CHARS = 1_000;
const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b(\s*[:=]\s*)[^\r\n]+/gi;
const COMMON_SECRET_PATTERN = /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi;

export function buildWatchdogTimeoutDetails(params: {
  runtimeType: RuntimeType;
  input: AgentRunInput;
  observation: WatchdogTimeoutObservation;
  stderrTail?: string;
}) {
  const { runtimeType, input, observation } = params;
  return {
    watchdog: observation.reason,
    runtimeType,
    runId: input.runId,
    phase: input.phase,
    thresholdMs: observation.thresholdMs,
    startedAt: new Date(observation.startedAtMs).toISOString(),
    lastActivityAt: new Date(observation.lastActivityAtMs).toISOString(),
    timedOutAt: new Date(observation.timedOutAtMs).toISOString(),
    elapsedMs: observation.elapsedMs,
    idleForMs: observation.idleForMs,
    firstFrameSeen: observation.firstFrameSeen,
    stderrTailSummary: summarizeStderrTail(params.stderrTail)
  };
}

export function summarizeStderrTail(stderrTail: string | undefined): string | undefined {
  const sanitized = stderrTail
    ?.replace(ANSI_OSC_PATTERN, '')
    ?.replace(ANSI_PATTERN, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1$2[REDACTED]')
    .replace(COMMON_SECRET_PATTERN, '[REDACTED]')
    .trim();
  return sanitized ? sanitized.slice(-STDERR_SUMMARY_CHARS) : undefined;
}
