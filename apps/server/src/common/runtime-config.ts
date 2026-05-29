import type { RuntimeType } from '@agent-cluster/shared';

export type LlmProvider = 'openai-compatible' | 'ollama';

const truthyValues = new Set(['1', 'true', 'yes', 'on']);
const mockFallbackValues = new Set(['1', 'true', 'yes', 'on', 'mock']);
const defaultAgentRuntimeTypes = new Set<RuntimeType>(['mock', 'generic_llm']);
const ollamaProviderValues = new Set(['ollama', 'local-ollama']);
const openAiDefaultBaseUrl = 'https://api.openai.com/v1';
const openAiDefaultModel = 'gpt-4.1-mini';
const ollamaDefaultBaseUrl = 'http://127.0.0.1:11434/v1';
const ollamaDefaultModel = 'llama3.2';

export function envFlag(name: string, fallback = false) {
  const value = process.env[name];
  return value === undefined ? fallback : truthyValues.has(value.trim().toLowerCase());
}

export function defaultAgentRuntimeType(): RuntimeType {
  const configured = process.env.DEFAULT_AGENT_RUNTIME_TYPE ?? process.env.AGENT_RUNTIME_TYPE ?? 'generic_llm';
  if (defaultAgentRuntimeTypes.has(configured as RuntimeType)) {
    return configured as RuntimeType;
  }
  return 'generic_llm';
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

export function mockRuntimeEnabled() {
  return envFlag('MOCK_RUNTIME_ENABLED', false);
}

export function runtimeModeLabel(runtimeType: RuntimeType) {
  return runtimeType === 'mock' ? 'mock simulation' : runtimeType;
}
