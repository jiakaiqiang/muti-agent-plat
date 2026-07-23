import type { AgentRunPhase, RuntimeType } from '@agent-cluster/shared';

export type LlmProvider = 'openai-compatible' | 'ollama';
export type LlmStructuredOutputMode = 'auto' | 'json_schema' | 'json_object';

const truthyValues = new Set(['1', 'true', 'yes', 'on']);
const mockFallbackValues = new Set(['1', 'true', 'yes', 'on', 'mock']);
const runtimeTypes = new Set<RuntimeType>([
  'mock',
  'generic_llm',
  'code_reader',
  'test_runner',
  'codex',
  'claude_code',
  'mcp_tool',
  'human'
]);
const ollamaProviderValues = new Set(['ollama', 'local-ollama']);
const openAiDefaultBaseUrl = 'https://api.openai.com/v1';
const openAiDefaultModel = 'gpt-4.1-mini';
const ollamaDefaultBaseUrl = 'http://127.0.0.1:11434/v1';
const ollamaDefaultModel = 'llama3.2';

export function envFlag(name: string, fallback = false) {
  const value = process.env[name];
  return value === undefined ? fallback : truthyValues.has(value.trim().toLowerCase());
}

export function isRuntimeType(value: unknown): value is RuntimeType {
  return typeof value === 'string' && runtimeTypes.has(value as RuntimeType);
}

function configuredRuntimeType(...names: string[]) {
  for (const name of names) {
    const configured = process.env[name]?.trim();
    if (isRuntimeType(configured)) {
      return configured;
    }
  }
  return undefined;
}

export function globalDefaultRuntimeType(): RuntimeType {
  return configuredRuntimeType('GLOBAL_DEFAULT_RUNTIME_TYPE') ?? 'generic_llm';
}

export function projectPolicyRuntimeType(): RuntimeType | undefined {
  return configuredRuntimeType('PROJECT_POLICY_RUNTIME_TYPE');
}

export function llmProvider(): LlmProvider {
  const configured = process.env.LLM_PROVIDER?.trim().toLowerCase();
  return configured && ollamaProviderValues.has(configured) ? 'ollama' : 'openai-compatible';
}

export function llmBaseUrl() {
  const configured = process.env.LLM_BASE_URL?.trim();
  if (llmProvider() === 'ollama' && (!configured || configured === openAiDefaultBaseUrl)) {
    return ollamaDefaultBaseUrl;
  }
  if (configured) {
    return configured;
  }
  return undefined;
}

export function llmApiKey() {
  const configured = process.env.LLM_API_KEY?.trim();
  if (configured) {
    return configured;
  }
  return llmProvider() === 'ollama' ? 'ollama' : undefined;
}

export function llmModel() {
  const configured = process.env.LLM_MODEL?.trim();
  if (llmProvider() === 'ollama' && (!configured || configured === openAiDefaultModel)) {
    return ollamaDefaultModel;
  }
  if (configured) {
    return configured;
  }
  return openAiDefaultModel;
}

export function genericLlmMockFallbackEnabled() {
  const configured = process.env.LLM_MOCK_FALLBACK ?? process.env.LLM_DRY_RUN;
  return configured === undefined ? false : mockFallbackValues.has(configured.trim().toLowerCase());
}

export function llmTimeoutMs() {
  const parsed = Number(process.env.LLM_TIMEOUT_MS ?? 60_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

export function llmMaxRetries() {
  const parsed = Number(process.env.LLM_MAX_RETRIES ?? 2);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 2;
}

export function llmRemoteMaxOutputTokens() {
  const parsed = Number(process.env.LLM_REMOTE_MAX_OUTPUT_TOKENS ?? 4_096);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 4_096;
}

export function llmInputSafetyMarginRatio() {
  const parsed = Number(process.env.LLM_INPUT_SAFETY_MARGIN_RATIO ?? 0.1);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0.5 ? parsed : 0.1;
}

export function llmRemoteStreamingEnabled() {
  return envFlag('LLM_REMOTE_STREAMING', true);
}

export function llmStructuredOutputMode(): LlmStructuredOutputMode {
  const configured = process.env.LLM_STRUCTURED_OUTPUT_MODE?.trim().toLowerCase();
  return configured === 'json_schema' || configured === 'json_object' ? configured : 'auto';
}

export function llmSchemaRepairAttempts() {
  const parsed = Number(process.env.LLM_SCHEMA_REPAIR_ATTEMPTS ?? 1);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(2, Math.floor(parsed))) : 1;
}

export function llmDiagnosticPreviewChars() {
  const parsed = Number(process.env.LLM_DIAGNOSTIC_PREVIEW_CHARS ?? 512);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(2_000, Math.floor(parsed))) : 512;
}

export function llmLocalMaxInputTokens() {
  const parsed = Number(process.env.LLM_LOCAL_MAX_INPUT_TOKENS ?? 4_000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 4_000;
}

export function llmLocalMaxOutputTokens() {
  const parsed = Number(process.env.LLM_LOCAL_MAX_OUTPUT_TOKENS ?? 1_024);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1_024;
}

export function llmLocalNumCtx() {
  const parsed = Number(process.env.LLM_LOCAL_NUM_CTX ?? 8_192);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 8_192;
}

export function discussionTimeoutMs() {
  const parsed = Number(process.env.DISCUSSION_TIMEOUT_MS ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export function phaseTimeoutMs(phase: AgentRunPhase) {
  const name = `PHASE_TIMEOUT_${phase.toUpperCase()}_MS`;
  const configured = process.env[name]?.trim();
  if (configured !== undefined && configured !== '') {
    const parsed = Number(configured);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  }
  return phase === 'discussion' ? discussionTimeoutMs() : 0;
}

export function reworkMaxRounds() {
  const parsed = Number(process.env.REWORK_MAX_ROUNDS ?? 1);
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return Math.max(0, Math.min(3, Math.floor(parsed)));
}

export function mockRuntimeEnabled() {
  return envFlag('MOCK_RUNTIME_ENABLED', false);
}

export type RuntimeStreamingMode = 'off' | 'codex' | 'all';

const runtimeStreamingValues = new Set<RuntimeStreamingMode>(['off', 'codex', 'all']);
const MAX_RUNTIME_TIMEOUT_MS = 2_147_483_647;

export function runtimeStreamingMode(): RuntimeStreamingMode {
  const raw = process.env.RUNTIME_STREAMING?.trim().toLowerCase();
  if (raw && runtimeStreamingValues.has(raw as RuntimeStreamingMode)) {
    return raw as RuntimeStreamingMode;
  }
  return 'off';
}

export function positiveRuntimeTimeoutMs(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  const normalized = Math.floor(parsed);
  return Number.isFinite(parsed) && normalized > 0 && normalized <= MAX_RUNTIME_TIMEOUT_MS ? normalized : fallback;
}

export function optionalRuntimeTimeoutMs(name: string) {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  const normalized = Math.floor(parsed);
  return Number.isFinite(parsed) && normalized > 0 && normalized <= MAX_RUNTIME_TIMEOUT_MS ? normalized : undefined;
}

export function runtimeStreamingEnabledFor(runtimeType: RuntimeType): boolean {
  const mode = runtimeStreamingMode();
  return runtimeType === 'codex' ? mode === 'codex' || mode === 'all' : runtimeType === 'claude_code' && mode === 'all';
}

export function runtimeModeLabel(runtimeType: RuntimeType) {
  return (
    {
      mock: '模拟运行时',
      generic_llm: '通用大模型',
      code_reader: 'Code Reader',
      test_runner: 'Test Runner',
      codex: 'Codex',
      claude_code: 'Claude Code',
      mcp_tool: 'MCP 工具',
      human: '人工处理'
    } satisfies Record<RuntimeType, string>
  )[runtimeType];
}
