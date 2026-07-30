import type {
  AgentRunResult,
  AgentRunPhase,
  ExecutionTermination,
  ExecutionTerminationDisposition,
  ExecutionTerminationKind,
  ExecutionTerminationScope,
  ExecutionTerminationSource,
  RuntimeError
} from '@agent-cluster/shared';
import { createAgentMessageOutput } from '@agent-cluster/shared';
import { randomUUID } from 'node:crypto';
import { nowIso } from './time.js';

export type CreateExecutionTerminationInput = {
  kind: ExecutionTerminationKind;
  source: ExecutionTerminationSource;
  scope: ExecutionTerminationScope;
  phase?: AgentRunPhase;
  timeout?: ExecutionTermination['timeout'];
  graceful?: boolean;
  replacementInvocationId?: string;
  maintenanceId?: string;
  diagnosticRef?: string;
};

const safeMessages: Record<ExecutionTerminationKind, string> = {
  user_cancelled: '执行已由用户取消。',
  frontend_disconnected: '前端连接已断开，会话执行已停止。',
  runtime_disconnected: 'Runtime 连接已断开，本次调用已中断且不会自动续跑。',
  phase_timeout: '当前阶段执行超时，已停止本次调用。',
  runtime_timeout: '运行时执行超时，已停止本次调用。',
  service_shutdown: '服务正在关闭，本次执行已中断且不会自动续跑。',
  superseded: '本次执行已被更新的需求或计划替代。',
  maintenance: '系统进入维护，本次执行已中断且不会自动续跑。'
};

export function createExecutionTermination(input: CreateExecutionTerminationInput): ExecutionTermination {
  return {
    schemaVersion: '1.0',
    terminationId: randomUUID(),
    kind: input.kind,
    source: input.source,
    scope: input.scope,
    occurredAt: nowIso(),
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.timeout ? { timeout: input.timeout } : {}),
    ...(input.graceful !== undefined ? { graceful: input.graceful } : {}),
    ...(input.replacementInvocationId ? { replacementInvocationId: input.replacementInvocationId } : {}),
    ...(input.maintenanceId ? { maintenanceId: input.maintenanceId } : {}),
    ...(input.diagnosticRef ? { diagnosticRef: input.diagnosticRef } : {})
  };
}

export function isExecutionTermination(value: unknown): value is ExecutionTermination {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ExecutionTermination>;
  return (
    candidate.schemaVersion === '1.0' &&
    typeof candidate.terminationId === 'string' &&
    typeof candidate.occurredAt === 'string' &&
    ['user_cancelled', 'frontend_disconnected', 'runtime_disconnected', 'phase_timeout', 'runtime_timeout', 'service_shutdown', 'superseded', 'maintenance'].includes(
      candidate.kind ?? ''
    ) &&
    ['user', 'orchestrator', 'runtime', 'system', 'operator'].includes(candidate.source ?? '') &&
    ['session', 'phase', 'invocation', 'service'].includes(candidate.scope ?? '')
  );
}

export function terminationFromSignal(signal?: AbortSignal): ExecutionTermination | undefined {
  return signal?.aborted && isExecutionTermination(signal.reason) ? signal.reason : undefined;
}

export function abortWithTermination(controller: AbortController, termination: ExecutionTermination): boolean {
  if (controller.signal.aborted) return false;
  controller.abort(termination);
  return true;
}

export function isChildProcessTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; killed?: unknown; signal?: unknown };
  return (
    candidate.code === 'ETIMEDOUT' ||
    (candidate.killed === true && typeof candidate.signal === 'string' && candidate.signal.length > 0)
  );
}

export function safeTerminationMessage(termination: ExecutionTermination): string {
  const base = safeMessages[termination.kind];
  if (!termination.timeout) return base;
  return `${base.replace(/。$/, '')}（${termination.timeout.timeoutMs}ms）。`;
}

export function terminationDisposition(termination: ExecutionTermination): ExecutionTerminationDisposition {
  if (
    termination.kind === 'user_cancelled' ||
    termination.kind === 'frontend_disconnected' ||
    termination.kind === 'runtime_disconnected' ||
    termination.kind === 'service_shutdown' ||
    termination.kind === 'maintenance'
  ) return 'stop';
  if (termination.kind === 'superseded') return 'replace';
  return 'retry';
}

export function terminationErrorCode(termination: ExecutionTermination): RuntimeError['code'] {
  return termination.kind === 'phase_timeout' || termination.kind === 'runtime_timeout'
    ? 'RUNTIME_TIMEOUT'
    : 'RUNTIME_CANCELLED';
}

export function terminationRetryable(termination: ExecutionTermination): boolean {
  return terminationDisposition(termination) !== 'stop';
}

export function normalizeTerminatedResult(
  result: AgentRunResult,
  termination: ExecutionTermination
): AgentRunResult {
  const message = safeTerminationMessage(termination);
  const retryable = terminationRetryable(termination);
  const code = terminationErrorCode(termination);
  return {
    ...result,
    status: code === 'RUNTIME_TIMEOUT' ? 'failed' : 'cancelled',
    output: createAgentMessageOutput({ messageKind: 'risk', content: message }),
    termination,
    error: {
      code,
      message,
      retryable,
      termination,
      details: {
        ...result.error?.details,
        terminationKind: termination.kind,
        terminationScope: termination.scope,
        terminationSource: termination.source,
        ...(termination.phase ? { phase: termination.phase } : {}),
        ...(termination.timeout ? { timeout: termination.timeout } : {})
      }
    }
  };
}

export function ensureStructuredTermination(
  result: AgentRunResult,
  context: { phase: AgentRunPhase; signal?: AbortSignal; termination?: ExecutionTermination }
): AgentRunResult {
  const existing = result.termination ?? result.error?.termination;
  if (existing) return normalizeTerminatedResult(result, existing);

  const upstream = context.termination ?? terminationFromSignal(context.signal);
  if (upstream) return normalizeTerminatedResult(result, upstream);

  if (result.error?.code === 'RUNTIME_TIMEOUT') {
    const timeoutMs = numericTimeout(result.error.details);
    return normalizeTerminatedResult(
      result,
      createExecutionTermination({
        kind: 'runtime_timeout',
        source: 'runtime',
        scope: 'invocation',
        phase: context.phase,
        ...(timeoutMs
          ? { timeout: { mode: timeoutMode(result.error.details), timeoutMs } }
          : {})
      })
    );
  }

  if (result.status === 'cancelled' || result.error?.code === 'RUNTIME_CANCELLED') {
    return normalizeTerminatedResult(
      result,
      createExecutionTermination({
        kind: 'user_cancelled',
        source: 'user',
        scope: 'invocation',
        phase: context.phase
      })
    );
  }
  return result;
}

function numericTimeout(details?: Record<string, unknown>) {
  const candidate = details?.thresholdMs ?? details?.timeoutMs;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0 ? candidate : undefined;
}

function timeoutMode(details?: Record<string, unknown>): NonNullable<ExecutionTermination['timeout']>['mode'] {
  const watchdog = String(details?.watchdog ?? '').toLowerCase();
  if (watchdog.includes('first')) return 'first_frame';
  if (watchdog.includes('idle')) return 'idle';
  if (watchdog.includes('absolute')) return 'absolute';
  return 'deadline';
}
