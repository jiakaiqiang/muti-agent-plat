export type RuntimeProvider = 'codex' | 'claude_code' | 'generic_llm' | 'mock' | 'internal';

export type RuntimeNotificationDisposition =
  | 'user_progress'
  | 'tool_event'
  | 'result'
  | 'usage'
  | 'debug_only'
  | 'runtime_error';

export const RUNTIME_DIAGNOSTIC_EVENT_CODES = [
  'STREAM_TEXT',
  'STREAM_SYSTEM',
  'STREAM_STDERR',
  'WORKTREE_PREPARED'
] as const;

export type RuntimeDiagnosticEventCode = (typeof RUNTIME_DIAGNOSTIC_EVENT_CODES)[number];

const RUNTIME_DIAGNOSTIC_EVENT_CODE_SET = new Set<string>(RUNTIME_DIAGNOSTIC_EVENT_CODES);

const CODEX_DISPOSITIONS: Readonly<Record<string, RuntimeNotificationDisposition>> = {
  'item/agentMessage/delta': 'debug_only',
  'item/started': 'tool_event',
  'item/completed': 'tool_event',
  'thread/tokenUsage/updated': 'usage',
  'turn/completed': 'result',
  'thread/started': 'debug_only',
  'mcpServer/startupStatus/updated': 'debug_only',
  'remoteControl/status/changed': 'debug_only'
};

export function classifyRuntimeNotification(
  provider: RuntimeProvider,
  method: string,
  _payload: unknown
): RuntimeNotificationDisposition {
  if (provider !== 'codex') return 'debug_only';
  return CODEX_DISPOSITIONS[method] ?? 'debug_only';
}

export function isKnownRuntimeNotification(provider: RuntimeProvider, method: string): boolean {
  return provider === 'codex' && Object.prototype.hasOwnProperty.call(CODEX_DISPOSITIONS, method);
}

export function isRuntimeDiagnosticEventCode(code: unknown): code is RuntimeDiagnosticEventCode {
  return typeof code === 'string' && RUNTIME_DIAGNOSTIC_EVENT_CODE_SET.has(code);
}

export function shouldPublishRuntimeEventToCollaboration(input: {
  type: string;
  visibility?: unknown;
  code?: unknown;
}): boolean {
  if (input.visibility === 'debug') return false;
  if (input.type !== 'runtime_progress') return true;
  return !isRuntimeDiagnosticEventCode(input.code);
}
