import type { AgentRuntimeEvent } from './contracts.js';
import { runtimeActivityKind } from './runtime-activity.js';
import { normalizeRuntimeFailureDetails, type RuntimeFailureDetails, type RuntimeObservation, type RuntimeObservationKind } from './runtime-request-health.js';

const kinds = new Set<RuntimeObservationKind>(['request_started', 'request_acknowledged', 'reasoning_progress',
  'text_progress', 'tool_input_progress', 'tool_started', 'tool_progress', 'tool_completed', 'submission_accepted',
  'transport_alive', 'provider_retry', 'provider_error', 'tool_error', 'output_contract_error', 'control_disconnected',
  'process_exited', 'terminal_received', 'probe_result', 'stop_requested', 'stop_unconfirmed']);
const activities: Partial<Record<ReturnType<typeof runtimeActivityKind>, RuntimeObservationKind>> = {
  model_output: 'text_progress', reasoning: 'reasoning_progress', tool_input: 'tool_input_progress',
  tool_started: 'tool_started', tool_progress: 'tool_progress', tool_result: 'tool_completed',
  submission: 'submission_accepted', transport: 'transport_alive'
};
type ObservationFields = Pick<RuntimeObservation, 'kind'> & Partial<Pick<RuntimeObservation,
  'eventId' | 'count' | 'toolCallId' | 'failure'>>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const integer = (values: unknown[], min: number, max: number) => values.find(value =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) as number | undefined;
function contentIdentity(content: string) {
  let hash = 2166136261;
  for (let index = 0; index < Math.min(content.length, 8192); index++) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
  return `${content.length}:${hash >>> 0}`;
}

/** Extract only bounded diagnostic facts, never provider text, credentials or reasoning. */
function failureDetails(md: Record<string, unknown>, kind: RuntimeObservationKind): RuntimeFailureDetails {
  const explicit = normalizeRuntimeFailureDetails(md.failure);
  if (explicit) return explicit;
  if (kind === 'output_contract_error') return { code: 'output_contract' };
  if (kind === 'tool_error') return { code: 'tool_error' };
  if (kind === 'control_disconnected') return { code: 'control_disconnected' };
  const raw = record(md.raw), error = record(raw.error), details = record(record(md.runtimeError).details);
  const message = [error.message, error.formatted, record(error.connection).code, record(md.runtimeError).message]
    .filter(value => typeof value === 'string').join(' ').slice(0, 8192);
  const statusMatch = /(?:^|\s)([45]\d\d)(?:\s|\b)/.exec(message);
  const httpStatus = integer([md.httpStatus, raw.status_code, raw.status, error.status, details.httpStatus], 100, 599)
    ?? (statusMatch ? Number(statusMatch[1]) : undefined);
  return { code: httpStatus === 429 ? 'rate_limit' : httpStatus === 401 || httpStatus === 403 ? 'authentication'
    : /StreamTruncated|stream.*(?:ended|closed)|response.*(?:incomplete|finished)/i.test(message) ? 'stream_interrupted'
    : httpStatus && httpStatus >= 500 ? 'upstream_error' : 'provider_error',
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...optionalNumber('retryAttempt', [md.retryAttempt, raw.retryAttempt, raw.attempt], 1, 1000),
    ...optionalNumber('maxRetries', [md.maxRetries, raw.maxRetries, raw.max_retries], 0, 1000),
    ...optionalNumber('retryDelayMs', [md.retryDelayMs, raw.retryInMs, raw.retry_delay_ms], 0, 86_400_000) };
}
function optionalNumber(key: string, values: unknown[], min: number, max: number) {
  const value = integer(values, min, max);
  return value === undefined ? {} : { [key]: value };
}

/** One event classification for supervision, health display and budget fallback. */
export function runtimeEventObservation(event: AgentRuntimeEvent): ObservationFields | undefined {
  const md = event.metadata ?? {};
  if (md.progressReplay === true) return;
  let kind = activities[runtimeActivityKind(event)];
  if (md.code === 'RUNTIME_REQUEST_OBSERVATION') kind = kinds.has(md.observationKind as RuntimeObservationKind)
    ? md.observationKind as RuntimeObservationKind : undefined;
  if (md.code === 'STREAM_SYSTEM' && ['api_retry', 'api_error'].includes(String(md.subtype))) {
    kind = md.subtype === 'api_retry' ? 'provider_retry' : 'provider_error';
  }
  if (event.type === 'runtime_failed' || md.isError === true) kind = md.name === 'StructuredOutput'
    ? 'output_contract_error' : event.type === 'tool_completed' ? 'tool_error' : 'provider_error';
  if (!kind) return;
  const toolCallId = typeof md.toolCallId === 'string' && md.toolCallId.length <= 512 ? md.toolCallId : undefined;
  const nativeId = md.eventId ?? record(md.raw).uuid;
  const sequence = integer([md.sequence], 0, Number.MAX_SAFE_INTEGER);
  const onePerTool = ['tool_started', 'tool_completed', 'submission_accepted', 'tool_error', 'output_contract_error'].includes(kind);
  const eventId = typeof nativeId === 'string' && nativeId.length <= 512 ? nativeId
    : toolCallId && onePerTool ? `${kind}:${toolCallId}`
    : `${kind}:${toolCallId ?? ''}:${event.createdAt}:${sequence ?? contentIdentity(event.content)}`;
  return { kind, eventId, ...(toolCallId ? { toolCallId } : {}),
    ...(typeof md.count === 'number' ? { count: md.count } : {}),
    ...(['provider_retry', 'provider_error', 'tool_error', 'output_contract_error', 'control_disconnected'].includes(kind)
      ? { failure: failureDetails(md, kind) } : {}) };
}
