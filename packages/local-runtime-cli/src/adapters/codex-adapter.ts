import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeOutput, MinimalTaskSubmission } from '@agent-cluster/shared';
import { getVersionedRuntimeOutputContract, validateRuntimeOutput } from '@agent-cluster/shared';
import { detectRuntimeVersion, parseConfiguredArgs, runRuntimeCommand } from '../runtime-process.js';
import type { LocalRuntimeAdapter } from './adapter.js';
import { buildLocalRuntimePrompt } from './prompt.js';
import { SubmissionError } from './submission-error.js';

export class CodexLocalRuntimeAdapter implements LocalRuntimeAdapter {
  readonly runtimeType = 'codex' as const;

  async detectVersion() {
    const configured = process.env.AGENT_RUNTIME_CODEX_VERSION?.trim();
    if (configured) return configured;
    return detectRuntimeVersion({
      command: process.env.AGENT_RUNTIME_CODEX_COMMAND?.trim() || 'codex',
      shell: process.platform === 'win32'
    });
  }

  async execute({ plan, cwd, signal, permissions, providerConnection }: Parameters<LocalRuntimeAdapter['execute']>[0]) {
    const command = process.env.AGENT_RUNTIME_CODEX_COMMAND?.trim() || 'codex';
    const configuredArgs = process.env.AGENT_RUNTIME_CODEX_ARGS_JSON?.trim();
    const baseArgs = configuredArgs
      ? parseConfiguredArgs(configuredArgs, 'AGENT_RUNTIME_CODEX_ARGS_JSON')
      : buildCodexArgs(plan.submissionRepair);
    if (providerConnection && providerConnection.provider !== 'openai-compatible') {
      throw new Error('MODEL_PROTOCOL_MISMATCH: Codex requires an OpenAI-compatible connection.');
    }
    const schemaDirectory = await mkdtemp(join(tmpdir(), 'agent-cluster-codex-schema-'));
    const schemaPath = join(schemaDirectory, 'runtime-output.schema.json');
    await writeFile(
      schemaPath,
      JSON.stringify(getVersionedRuntimeOutputContract(plan.expectedOutput.kind, plan.expectedOutput.schemaVersion).schema),
      'utf8'
    );

    try {
      const { stdout, stderr, exitCode } = await runRuntimeCommand({
        command,
        args: withCodexOutputSchema(baseArgs, schemaPath),
        stdin: buildLocalRuntimePrompt('Codex', plan, permissions),
        cwd,
        signal,
        shell: process.platform === 'win32',
        envOverrides: providerConnection ? {
          OPENAI_BASE_URL: providerConnection.baseUrl,
          OPENAI_API_KEY: providerConnection.apiKey,
          CODEX_MODEL: providerConnection.model
        } : undefined
      });
      if (exitCode !== 0) throw new Error(formatCodexProcessFailure(stdout, stderr, exitCode));
      const output = parseCodexOutput(stdout, plan.expectedOutput.kind, plan.expectedOutput.schemaVersion);
      return {
        output,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: plan.executionTarget.modelId ?? 'codex' }
      };
    } finally {
      await rm(schemaDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function buildCodexArgs(readOnly = false) {
  return ['exec', '--json', '--sandbox', readOnly ? 'read-only' : 'workspace-write', '--skip-git-repo-check', '-'];
}

/**
 * `codex exec --json` 把失败原因写在 stdout 的 JSONL 帧里,stderr 常常是空的。
 * 只读 stderr 会得到没有原因的 "exited with code 1:",因此这里按
 * 结构化帧 → stderr → stdout 末行的顺序取详情。
 */
export function formatCodexProcessFailure(stdout: string, stderr: string, exitCode: number | null) {
  const structuredError = extractCodexStreamError(stdout);
  const stderrMessage = stderr.trim();
  const stdoutFallback = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const detail = structuredError || stderrMessage || stdoutFallback;
  return `Codex exited with code ${exitCode}${detail ? `: ${detail.slice(-4000)}` : '.'}`;
}

function extractCodexStreamError(stdout: string) {
  let reportedError: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const frame = JSON.parse(trimmed) as Record<string, unknown>;
      const frameError = codexFrameError(frame);
      if (frameError) reportedError = frameError;
    } catch {
      // 非 JSON 的状态行只作为最后的兜底。
    }
  }
  return reportedError;
}

function codexFrameError(frame: Record<string, unknown>): string | undefined {
  const nested = errorText(frame.error);
  if (nested) return nested;
  if (frame.type === 'error' || frame.type === 'turn.failed') {
    const message = errorText(frame.message);
    if (message) return message;
  }
  for (const nestedKey of ['payload', 'item'] as const) {
    const nestedFrame = frame[nestedKey];
    if (!nestedFrame || typeof nestedFrame !== 'object' || Array.isArray(nestedFrame)) continue;
    const nestedMessage = codexFrameError(nestedFrame as Record<string, unknown>);
    if (nestedMessage) return nestedMessage;
  }
  return undefined;
}

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  const code = typeof record.code === 'string' || typeof record.code === 'number' ? String(record.code) : '';
  if (message) return code ? `${message} (${code})` : message;
  return code || undefined;
}

export function withCodexOutputSchema(args: string[], schemaPath: string) {
  const withoutSchema: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output-schema') {
      index += 1;
      continue;
    }
    if (argument.startsWith('--output-schema=')) continue;
    withoutSchema.push(argument);
  }
  const promptArgumentIndex = withoutSchema.lastIndexOf('-');
  if (promptArgumentIndex < 0) return [...withoutSchema, '--output-schema', schemaPath];
  return [
    ...withoutSchema.slice(0, promptArgumentIndex),
    '--output-schema',
    schemaPath,
    ...withoutSchema.slice(promptArgumentIndex)
  ];
}

export function parseCodexOutput(stdout: string, expectedKind: Parameters<typeof validateRuntimeOutput>[0], version = '1.0'): RuntimeOutput | MinimalTaskSubmission {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let candidate: unknown;
  for (const line of lines) {
    try {
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame.type === 'item.completed' && frame.item && typeof frame.item === 'object') {
        const item = frame.item as Record<string, unknown>;
        if (item.type === 'agent_message' && typeof item.text === 'string') candidate = JSON.parse(item.text);
      }
    } catch {
      // Non-JSON status lines are ignored; contract validation below is authoritative.
    }
  }
  if (!candidate) {
    try { candidate = JSON.parse(stdout.trim()); } catch { /* handled below */ }
  }
  const validation = getVersionedRuntimeOutputContract(expectedKind, version).validate(candidate);
  if (!validation.valid) {
    throw new SubmissionError(candidate, validation.errors);
  }
  return validation.value;
}
