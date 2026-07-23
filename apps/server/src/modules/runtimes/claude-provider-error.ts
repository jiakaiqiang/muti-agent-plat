import type { RuntimeError } from '@agent-cluster/shared';

export type ClaudeProcessFailure = {
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
  exitCode?: unknown;
  code?: unknown;
  signal?: unknown;
};

type ProviderPayload = Record<string, unknown>;

export function classifyClaudeProviderFailure(
  failure: ClaudeProcessFailure,
  diagnosticRef: string
): RuntimeError | undefined {
  for (const text of providerErrorTexts(failure)) {
    const match = /API Error:\s*(\d{3})/i.exec(text);
    if (!match) continue;
    const httpStatus = Number(match[1]);
    if (!Number.isInteger(httpStatus)) continue;
    const payload = providerPayload(text, match.index + match[0].length);
    const retryable = providerRetryable(httpStatus, payload);
    const retryAfterMs = retryAfterMilliseconds(payload);
    return {
      code: isTimeoutStatus(httpStatus) ? 'RUNTIME_TIMEOUT' : 'MODEL_ERROR',
      message: providerSafeMessage(httpStatus),
      retryable,
      details: {
        provider: 'claude_code',
        providerFailure: true,
        stage: 'provider_response',
        diagnosticRef,
        httpStatus,
        exitCode: numericExitCode(failure),
        signal: typeof failure.signal === 'string' ? failure.signal : null,
        ...(typeof payload?.error_name === 'string' ? { errorName: payload.error_name } : {}),
        ...(typeof payload?.error_category === 'string' ? { errorCategory: payload.error_category } : {}),
        ...(typeof payload?.zone === 'string' ? { gatewayZone: payload.zone } : {}),
        ...(typeof payload?.ray_id === 'string' ? { rayId: payload.ray_id } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
      }
    };
  }
  return undefined;
}

function providerErrorTexts(failure: ClaudeProcessFailure) {
  const texts = new Set<string>();
  for (const value of [failure.stderr, failure.stdout, failure.message]) {
    collectStrings(value, texts, 0);
  }
  return [...texts];
}

function collectStrings(value: unknown, output: Set<string>, depth: number) {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        collectStrings(JSON.parse(trimmed) as unknown, output, depth + 1);
      } catch {
        // Provider error text is often followed by a JSON object and prose.
      }
    }
    output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 32)) collectStrings(item, output, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (['result', 'error', 'errors', 'message', 'content', 'detail'].includes(key)) {
        collectStrings(item, output, depth + 1);
      }
    }
  }
}

function providerPayload(text: string, searchFrom: number): ProviderPayload | undefined {
  const start = text.indexOf('{', searchFrom);
  if (start < 0) return undefined;
  const json = balancedJsonObject(text, start);
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ProviderPayload
      : undefined;
  } catch {
    return undefined;
  }
}

function balancedJsonObject(text: string, start: number) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function providerRetryable(status: number, payload: ProviderPayload | undefined) {
  if (typeof payload?.retryable === 'boolean') return payload.retryable;
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(payload: ProviderPayload | undefined) {
  const seconds = payload?.retry_after;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.round(seconds * 1_000), 10 * 60_000);
}

function numericExitCode(failure: ClaudeProcessFailure) {
  if (typeof failure.exitCode === 'number') return failure.exitCode;
  return typeof failure.code === 'number' ? failure.code : null;
}

function isTimeoutStatus(status: number) {
  return status === 408 || status === 504 || status === 524;
}

function providerSafeMessage(status: number) {
  if (status === 524) return 'Claude model gateway timed out (HTTP 524).';
  if (status === 504) return 'Claude model gateway timed out (HTTP 504).';
  if (status === 408) return 'Claude model request timed out before completion (HTTP 408).';
  if (status === 429) return 'Claude model provider rate limited the request (HTTP 429).';
  if (status === 401 || status === 403) return `Claude model provider rejected authentication (HTTP ${status}).`;
  return status >= 500
    ? `Claude model provider failed temporarily (HTTP ${status}).`
    : `Claude model provider rejected the request (HTTP ${status}).`;
}
