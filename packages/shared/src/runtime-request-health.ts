import type { RuntimeType } from './contracts.js';
import { isRuntimeType } from './contracts.js';

export const RUNTIME_HEALTH_POLICY_VERSION = 'request-health-v1';
export type RuntimeHealthCapability = 'supported' | 'unsupported' | 'unknown';
export type RuntimeHealthCapabilities = Record<'progressEvents' | 'reasoningEvents' | 'processProbe' |
  'requestLifecycle' | 'providerRequestQuery', RuntimeHealthCapability>;
export const unknownRuntimeHealthCapabilities = (): RuntimeHealthCapabilities => ({
  progressEvents: 'unknown', reasoningEvents: 'unknown', processProbe: 'unsupported',
  requestLifecycle: 'unknown', providerRequestQuery: 'unsupported'
});
export type RuntimeObservationKind = 'request_started' | 'request_acknowledged' | 'reasoning_progress' |
  'text_progress' | 'tool_input_progress' | 'tool_started' | 'tool_progress' | 'tool_completed' | 'submission_accepted' |
  'transport_alive' | 'provider_retry' | 'provider_error' | 'tool_error' | 'output_contract_error' | 'control_disconnected' | 'process_exited' |
  'terminal_received' | 'probe_result' | 'stop_requested' | 'stop_unconfirmed';
export type RuntimeHealthIdentity = {
  sessionId: string; operationId: string; invocationId: string; sessionGeneration: number; observerEpoch: string;
};
export type RuntimeFailureDetails = {
  code: 'rate_limit' | 'upstream_error' | 'stream_interrupted' | 'authentication' | 'provider_error' |
    'tool_error' | 'output_contract' | 'control_disconnected' | 'process_exited';
  httpStatus?: number; retryAttempt?: number; maxRetries?: number; retryDelayMs?: number;
};
export function normalizeRuntimeFailureDetails(value: unknown): RuntimeFailureDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (!['rate_limit', 'upstream_error', 'stream_interrupted', 'authentication', 'provider_error',
    'tool_error', 'output_contract', 'control_disconnected', 'process_exited'].includes(String(v.code))) return;
  const result: RuntimeFailureDetails = { code: v.code as RuntimeFailureDetails['code'] };
  for (const key of ['httpStatus', 'retryAttempt', 'maxRetries', 'retryDelayMs'] as const) {
    const min = key === 'httpStatus' ? 100 : key === 'retryAttempt' ? 1 : 0;
    const max = key === 'httpStatus' ? 599 : key === 'retryDelayMs' ? 86_400_000 : 1000;
    if (typeof v[key] === 'number' && Number.isSafeInteger(v[key]) && v[key] >= min && v[key] <= max) result[key] = v[key];
  }
  return result;
}
/** Metadata only. Never put prompt, reasoning text/signatures or provider raw payloads here. */
export type RuntimeObservation = RuntimeHealthIdentity & {
  sequence: number; observedAt: string; source: string; kind: RuntimeObservationKind;
  eventId?: string; count?: number; toolCallId?: string; requestAttemptId?: string; providerRequestId?: string;
  processStatus?: 'alive' | 'exited' | 'unknown'; requestStatus?: 'pending' | 'receiving' | 'ended' | 'unknown';
  probeStatus?: 'ok' | 'unsupported' | 'timeout';
  failure?: RuntimeFailureDetails;
};
export type RuntimeHealthSnapshot = RuntimeHealthIdentity & {
  schemaVersion: 1; policyVersion: typeof RUNTIME_HEALTH_POLICY_VERSION; version: number;
  phase: string; agentId: string; runtimeType: RuntimeType;
  stage: 'starting' | 'awaiting_response' | 'reasoning' | 'responding' | 'tool_running' |
    'retrying' | 'unknown_wait' | 'stopping' | 'terminal';
  health: 'progressing' | 'unknown' | 'abnormal' | 'terminal'; reasonCode: string;
  capabilities: RuntimeHealthCapabilities;
  processStatus: 'alive' | 'exited' | 'unknown'; requestStatus: 'pending' | 'receiving' | 'ended' | 'unknown';
  startedAt: string; updatedAt: string; deadlineAt?: string; lastProgressAt?: string; lastTransportAt?: string;
  lastProbeAt?: string; unknownSince?: string; lastWaitAcknowledgedAt?: string; lastWaitKey?: string;
  observationDue: boolean; canWait: boolean; canStop: boolean; pendingSync?: boolean; historical?: boolean;
  failure?: RuntimeFailureDetails; failureAt?: string;
  budgetFallbackReason?: 'runtime_disconnected' | 'provider_or_tool_error';
};
export type RuntimeHealthWaitInput = { expectedVersion: number; sessionGeneration: number; idempotencyKey: string };
/** Untrusted API/SSE/persistence input: validate and project only public metadata. */
export function normalizeRuntimeHealthSnapshot(value: unknown): RuntimeHealthSnapshot | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  const strings = ['sessionId', 'operationId', 'invocationId', 'observerEpoch', 'phase', 'agentId', 'reasonCode', 'startedAt', 'updatedAt'] as const;
  if (strings.some(key => typeof v[key] !== 'string' || !(v[key] as string).length || (v[key] as string).length > 512) ||
    v.schemaVersion !== 1 || v.policyVersion !== RUNTIME_HEALTH_POLICY_VERSION ||
    !Number.isSafeInteger(v.version) || Number(v.version) < 1 ||
    !Number.isSafeInteger(v.sessionGeneration) || Number(v.sessionGeneration) < 0 ||
    !isRuntimeType(v.runtimeType) ||
    !['starting', 'awaiting_response', 'reasoning', 'responding', 'tool_running', 'retrying', 'unknown_wait', 'stopping', 'terminal'].includes(String(v.stage)) ||
    !['progressing', 'unknown', 'abnormal', 'terminal'].includes(String(v.health)) ||
    !['alive', 'exited', 'unknown'].includes(String(v.processStatus)) ||
    !['pending', 'receiving', 'ended', 'unknown'].includes(String(v.requestStatus)) ||
    ['observationDue', 'canWait', 'canStop'].some(key => typeof v[key] !== 'boolean')) return;
  const caps = v.capabilities as Record<string, unknown> | undefined;
  const keys = Object.keys(unknownRuntimeHealthCapabilities()) as Array<keyof RuntimeHealthCapabilities>;
  if (!caps || keys.some(key => !['supported', 'unsupported', 'unknown'].includes(String(caps[key])))) return;
  const result: Record<string, unknown> = {};
  for (const key of [...strings, 'schemaVersion', 'policyVersion', 'version', 'sessionGeneration', 'runtimeType', 'stage', 'health',
    'processStatus', 'requestStatus', 'observationDue', 'canWait', 'canStop']) result[key] = v[key];
  result.capabilities = Object.fromEntries(keys.map(key => [key, caps[key]]));
  for (const key of ['deadlineAt', 'lastProgressAt', 'lastTransportAt', 'lastProbeAt', 'unknownSince', 'lastWaitAcknowledgedAt', 'lastWaitKey', 'failureAt']) {
    if (typeof v[key] === 'string' && v[key].length <= 512) result[key] = v[key];
  }
  for (const key of ['pendingSync', 'historical']) if (typeof v[key] === 'boolean') result[key] = v[key];
  const failure = normalizeRuntimeFailureDetails(v.failure);
  if (failure) result.failure = failure;
  if (['runtime_disconnected', 'provider_or_tool_error'].includes(String(v.budgetFallbackReason))) result.budgetFallbackReason = v.budgetFallbackReason;
  return result as RuntimeHealthSnapshot;
}
export const isRuntimeHealthWaitInput = (value: unknown): value is RuntimeHealthWaitInput => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Number.isSafeInteger(v.expectedVersion) && Number(v.expectedVersion) > 0 &&
    Number.isSafeInteger(v.sessionGeneration) && Number(v.sessionGeneration) >= 0 &&
    typeof v.idempotencyKey === 'string' && v.idempotencyKey.length > 0 && v.idempotencyKey.length <= 128;
};
export function runtimeHealthLabel(snapshot: RuntimeHealthSnapshot) {
  if (snapshot.historical) return '历史调用／当前状态未知';
  if (snapshot.stage === 'unknown_wait') return '等待模型响应／状态未知';
  if (snapshot.stage === 'reasoning') return '正在思考';
  if (snapshot.stage === 'responding') return '正在输出';
  if (snapshot.stage === 'tool_running') return '工具执行中';
  if (snapshot.stage === 'retrying') return snapshot.reasonCode === 'output_contract_error' ? '输出格式不符合要求／等待纠正'
    : snapshot.failure?.code === 'rate_limit' ? '模型服务限流／等待恢复'
    : snapshot.failure?.code === 'stream_interrupted' ? '模型响应连接中断／等待恢复'
    : snapshot.failure?.code === 'process_exited' ? '运行程序已退出／等待结束确认'
    : snapshot.reasonCode === 'tool_error' ? '工具执行异常／等待恢复'
    : snapshot.reasonCode === 'control_disconnected' ? 'Runtime 连接中断／等待核实'
    : '模型服务异常／等待恢复';
  if (snapshot.stage === 'stopping') return snapshot.budgetFallbackReason ? '异常未恢复／等待停止确认' : '正在等待可信停止确认';
  if (snapshot.stage === 'terminal') return '调用已结束';
  return '等待模型响应';
}
