import {
  assertIntentInvocationScope, getVersionedRuntimeOutputContract,
  type InvocationPlan, type RuntimeError, type RuntimeUsage, type RuntimeOutput
} from '@agent-cluster/shared';

export function assertClaudeClassification(input: InvocationPlan) {
  assertIntentInvocationScope(input);
  if (input.admissionClass !== 'routing' || input.executionTarget.runtimeType !== 'claude_code' ||
      input.executionTarget.executionLocation !== 'server' || input.resume || input.submissionRepair) {
    throw classificationError('CAPABILITY_BLOCKED', 'RESTRICTED_ROUTING_CAPABILITY_UNAVAILABLE');
  }
}

export function claudeClassificationArgs(input: InvocationPlan, providerModel?: string): string[] {
  assertClaudeClassification(input);
  return ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--safe-mode',
    '--restricted', '--disable-slash-commands', '--no-session-persistence', '--no-chrome',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--max-turns', '1',
    '--system-prompt', 'Classify only the supplied message and context. Return one JSON object. Do not execute actions.',
    // executionTarget.modelId is a platform connection ID, not a provider model.
    // The worker resolves credentials and supplies the real model via its environment.
    ...(providerModel ? ['--model', providerModel] : [])];
}

export function claudeClassificationPrompt(input: InvocationPlan): string {
  const contract = getVersionedRuntimeOutputContract(input.expectedOutput.kind, input.expectedOutput.schemaVersion);
  // No workdir sidecars or runtime resume context: all evidence is the saved envelope.
  // Validate ourselves; --json-schema adds StructuredOutput and its own repair loop.
  return JSON.stringify({ systemRules: input.contextEnvelope.L0.systemRules, agent: input.agent,
    contextEnvelope: input.contextEnvelope, expectedOutput: input.expectedOutput, outputSchema: contract.schema });
}

export function claudeClassificationEnv(input: InvocationPlan, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, CLAUDE_CODE_SAFE_MODE: '1', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_RETRY_WATCHDOG: '0',
    MAX_STRUCTURED_OUTPUT_RETRIES: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.budget.maxOutputTokens ?? 3000),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_AUTO_CONNECT_IDE: '0', CLAUDE_CODE_PLUGIN_DIRS: '', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' };
}

export function parseClaudeClassification(stdout: string, input: InvocationPlan) {
  assertClaudeClassification(input);
  let frame: Record<string, unknown>;
  try { frame = JSON.parse(stdout); } catch { throw invalidOutput('', ['Invalid CLI result frame']); }
  if (!frame || frame.type !== 'result' || frame.is_error === true || frame.subtype !== 'success') {
    throw classificationError('MODEL_ERROR', 'Claude classification did not finish successfully.');
  }
  let candidate: unknown;
  const raw = typeof frame.result === 'string' ? frame.result : '';
  try { candidate = JSON.parse(raw); } catch { throw invalidOutput(raw, ['Expected a single JSON object']); }
  const validation = getVersionedRuntimeOutputContract(input.expectedOutput.kind, input.expectedOutput.schemaVersion).validate(candidate);
  if (!validation.valid) throw invalidOutput(raw, validation.errors);
  const counters = frame.usage as Record<string, unknown> | undefined;
  const measured = counters && ['input_tokens', 'output_tokens'].every(key =>
    typeof counters[key] === 'number' && Number.isFinite(counters[key]) && Number(counters[key]) >= 0);
  const inputTokens = measured ? Number(counters.input_tokens) : 0;
  const outputTokens = measured ? Number(counters.output_tokens) : 0;
  const usage: RuntimeUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    model: input.executionTarget.modelId ?? 'claude_code', measurement: measured ? 'actual' : 'unknown' };
  if (measured) {
    const read = Number(counters.cache_read_input_tokens ?? 0), write = Number(counters.cache_creation_input_tokens ?? 0);
    if (Number.isFinite(read) && Number.isFinite(write) && read >= 0 && write >= 0) {
      usage.cacheReadInputTokens = read; usage.cacheWriteInputTokens = write;
      usage.logicalInputTokens = inputTokens + read + write;
    }
  }
  return { output: validation.value as RuntimeOutput, usage };
}

function invalidOutput(raw: string, errors: string[]) {
  // This feedback is untrusted and bounded; the durable classifier owns the only repair.
  return classificationError('RUNTIME_OUTPUT_CONTRACT_VIOLATION', 'Claude classification output failed schema validation.', {
    schemaRepairOwner: 'intent_classifier', previousOutput: raw.slice(0, 8000), validationErrors: errors.slice(0, 20).map(error => error.slice(0, 500))
  });
}

export function classificationError(code: RuntimeError['code'], message: string, details: Record<string, unknown> = {}) {
  const runtimeError: RuntimeError = { code, message, retryable: false, details: { provider: 'claude_code', ...details } };
  return Object.assign(new Error(message), { runtimeError });
}
