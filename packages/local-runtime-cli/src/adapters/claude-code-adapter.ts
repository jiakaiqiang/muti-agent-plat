import type { InvocationPlan, LocalRuntimePermissionPolicy, RuntimeOutput, RuntimeUsage } from '@agent-cluster/shared';
import { getRuntimeOutputContract, validateRuntimeOutput } from '@agent-cluster/shared';
import { detectRuntimeVersion, parseConfiguredArgs, runRuntimeCommand } from '../runtime-process.js';
import { localRuntimeError } from '../runtime-error.js';
import type { LocalRuntimeAdapter } from './adapter.js';
import { resolveClaudeCommand } from './claude-command.js';
import { buildLocalRuntimePrompt } from './prompt.js';

type ClaudeResultFrame = {
  output: RuntimeOutput;
  usage: RuntimeUsage;
  cliSessionId?: string;
};

export class ClaudeCodeLocalRuntimeAdapter implements LocalRuntimeAdapter {
  readonly runtimeType = 'claude_code' as const;

  async detectVersion() {
    if (
      process.env.AGENT_RUNTIME_CLAUDE_ENABLED?.trim().toLowerCase() === 'false'
      || process.env.CLAUDE_CODE_ENABLED?.trim().toLowerCase() === 'false'
    ) {
      return undefined;
    }
    const configured = process.env.AGENT_RUNTIME_CLAUDE_VERSION?.trim();
    if (configured) return configured;
    try {
      const command = resolveClaudeCommand();
      return detectRuntimeVersion({ command: command.executable, shell: command.shell });
    } catch {
      return undefined;
    }
  }

  async execute({ plan, cwd, signal, permissions, providerConnection }: Parameters<LocalRuntimeAdapter['execute']>[0]) {
    const command = resolveClaudeCommand();
    const configuredArgs = process.env.AGENT_RUNTIME_CLAUDE_ARGS_JSON?.trim();
    const args = configuredArgs
      ? parseConfiguredArgs(configuredArgs, 'AGENT_RUNTIME_CLAUDE_ARGS_JSON')
      : buildClaudeArgs(plan, permissions);
    const prompt = buildLocalRuntimePrompt('Claude Code', plan, permissions);
    if (providerConnection && providerConnection.provider !== 'anthropic-compatible') {
      throw new Error('MODEL_PROTOCOL_MISMATCH: Claude Code requires an Anthropic-compatible connection.');
    }
    const { stdout, stderr, exitCode } = await runRuntimeCommand({
      command: command.executable,
      args,
      stdin: encodeClaudeUserMessage(prompt),
      cwd,
      signal,
      shell: command.shell,
      envOverrides: providerConnection ? claudeProviderEnvironment(providerConnection) : undefined
    });
    if (exitCode !== 0) {
      const processFailure = formatClaudeProcessFailure(stdout, stderr, exitCode);
      if (isProviderFormatMismatch(processFailure)) {
        throw localRuntimeError({
          code: 'MODEL_ERROR',
          message: 'Claude Code provider is incompatible: it rejected Claude Chat requests and only accepts OpenAI request formats. Configure an Anthropic-compatible endpoint or disable Claude Code Runtime.',
          retryable: false,
          details: {
            provider: 'claude_code',
            providerFailure: true,
            stage: 'provider_response',
            httpStatus: 400,
            failureKind: 'provider_format_mismatch',
            requestedFormat: 'claude_chat',
            acceptedFormats: ['openai_chat', 'openai_responses']
          }
        });
      }
      throw new Error(processFailure);
    }
    const result = parseClaudeOutput(stdout, plan.expectedOutput.kind);
    return {
      output: result.output,
      usage: { ...result.usage, model: plan.executionTarget.modelId ?? result.usage.model ?? 'claude_code' },
      runtimeSession: result.cliSessionId ? { cliSessionId: result.cliSessionId } : undefined
    };
  }
}

function claudeProviderEnvironment(connection: NonNullable<Parameters<LocalRuntimeAdapter['execute']>[0]['providerConnection']>) {
  return {
    ANTHROPIC_BASE_URL: connection.baseUrl,
    ANTHROPIC_AUTH_TOKEN: connection.apiKey,
    ANTHROPIC_MODEL: connection.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: connection.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: connection.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: connection.model
  };
}

function isProviderFormatMismatch(message: string) {
  return /API Error:\s*400/i.test(message)
    && /Format mismatch/i.test(message)
    && /\bclaude_chat\b/i.test(message)
    && /\bopenai_(?:chat|responses)\b/i.test(message);
}

export function buildClaudeArgs(plan: InvocationPlan, permissions: LocalRuntimePermissionPolicy) {
  const schema = getRuntimeOutputContract(plan.expectedOutput.kind).schema;
  const tools = resolveClaudeTools(plan, permissions);
  const maxBudget = process.env.AGENT_RUNTIME_CLAUDE_MAX_BUDGET_USD?.trim();
  return [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--setting-sources', 'user',
    '--permission-mode', permissions.workspace_write === 'allow' ? 'acceptEdits' : 'plan',
    '--tools', tools.join(','),
    '--allowedTools', tools.join(','),
    '--json-schema', JSON.stringify(schema),
    ...(maxBudget ? ['--max-budget-usd', maxBudget] : [])
  ];
}

function resolveClaudeTools(plan: InvocationPlan, permissions: LocalRuntimePermissionPolicy) {
  const tools = new Set(['Read', 'Grep', 'Glob']);
  const allowedToolNames = new Set(
    plan.toolCatalog.decisions
      .filter((decision) => decision.status === 'allowed')
      .map((decision) => decision.toolKey)
  );
  const catalogToolNames = new Set(plan.toolCatalog.tools.map((tool) => tool.name));
  const hasTool = (name: string) => allowedToolNames.has(name) || catalogToolNames.has(name);
  if (
    permissions.workspace_write === 'allow'
    && plan.executionTarget.writeMode !== 'none'
    && hasTool('write_file')
  ) {
    tools.add('Edit');
    tools.add('Write');
  }
  if (permissions.test_execute === 'allow' && hasTool('run_test')) {
    tools.add('Bash(npm test*)');
    tools.add('Bash(npm run test*)');
    tools.add('Bash(pnpm test*)');
    tools.add('Bash(pnpm run test*)');
  }
  return [...tools];
}

function encodeClaudeUserMessage(prompt: string) {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] }
  })}\n`;
}

function parseClaudeOutput(
  stdout: string,
  expectedKind: Parameters<typeof validateRuntimeOutput>[0]
): ClaudeResultFrame {
  let terminal: Record<string, unknown> | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const frame = JSON.parse(trimmed) as Record<string, unknown>;
      if (frame.type === 'result') terminal = frame;
    } catch {
      // Non-JSON status lines are ignored; the terminal result frame is authoritative.
    }
  }
  if (!terminal) throw new Error('RUNTIME_OUTPUT_CONTRACT_VIOLATION: Claude Code returned no result frame.');
  const failed = terminal.is_error === true
    || (typeof terminal.subtype === 'string' && terminal.subtype !== 'success');
  if (failed) {
    const reportedError = claudeFrameError(terminal);
    throw new Error(`Claude Code result reported an error${reportedError ? `: ${reportedError}` : '.'}`);
  }
  const candidate = parseClaudeResultPayload(terminal.structured_output ?? terminal.result);
  const validation = validateRuntimeOutput(expectedKind, candidate);
  if (!validation.valid) {
    throw new Error(
      `RUNTIME_OUTPUT_CONTRACT_VIOLATION: expected output kind ${expectedKind}: ${validation.errors.join('; ')}`
    );
  }
  const usage = asRecord(terminal.usage);
  const inputTokens = numericValue(usage.input_tokens);
  const outputTokens = numericValue(usage.output_tokens);
  return {
    output: validation.value,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      model: 'claude_code'
    },
    cliSessionId: typeof terminal.session_id === 'string' ? terminal.session_id : undefined
  };
}

function formatClaudeProcessFailure(stdout: string, stderr: string, exitCode: number | null) {
  const structuredError = extractClaudeStreamError(stdout);
  const stderrMessage = stderr.trim();
  const stdoutFallback = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const detail = structuredError || stderrMessage || stdoutFallback;
  return `Claude Code exited with code ${exitCode}${detail ? `: ${detail.slice(-4000)}` : '.'}`;
}

function extractClaudeStreamError(stdout: string) {
  let reportedError: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const frame = JSON.parse(trimmed) as Record<string, unknown>;
      const frameError = claudeFrameError(frame);
      if (frameError) reportedError = frameError;
    } catch {
      // A non-JSON stdout line is used only as the final fallback.
    }
  }
  return reportedError;
}

function claudeFrameError(frame: Record<string, unknown>) {
  if (Array.isArray(frame.errors)) {
    const errors = frame.errors.filter((item): item is string => typeof item === 'string').join('\n').trim();
    if (errors) return errors;
  }
  if (frame.type === 'result' && frame.is_error === true && typeof frame.result === 'string' && frame.result.trim()) {
    return frame.result.trim();
  }
  if (frame.type !== 'assistant' || (typeof frame.error !== 'string' && frame.is_api_error_message !== true)) {
    return undefined;
  }
  const message = asRecord(frame.message);
  if (!Array.isArray(message.content)) return typeof frame.error === 'string' ? frame.error : undefined;
  const text = message.content
    .map((item) => asRecord(item).text)
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .join('\n')
    .trim();
  return text || (typeof frame.error === 'string' ? frame.error : undefined);
}

function parseClaudeResultPayload(value: unknown) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numericValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
