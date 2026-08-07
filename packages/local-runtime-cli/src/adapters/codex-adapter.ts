import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeOutput } from '@agent-cluster/shared';
import { getRuntimeOutputContract, validateRuntimeOutput } from '@agent-cluster/shared';
import { detectRuntimeVersion, parseConfiguredArgs, runRuntimeCommand } from '../runtime-process.js';
import type { LocalRuntimeAdapter } from './adapter.js';
import { buildLocalRuntimePrompt } from './prompt.js';

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
      : buildCodexArgs();
    if (providerConnection && providerConnection.provider !== 'openai-compatible') {
      throw new Error('MODEL_PROTOCOL_MISMATCH: Codex requires an OpenAI-compatible connection.');
    }
    const schemaDirectory = await mkdtemp(join(tmpdir(), 'agent-cluster-codex-schema-'));
    const schemaPath = join(schemaDirectory, 'runtime-output.schema.json');
    await writeFile(
      schemaPath,
      JSON.stringify(getRuntimeOutputContract(plan.expectedOutput.kind).schema),
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
      if (exitCode !== 0) throw new Error(`Codex exited with code ${exitCode}: ${stderr.trim().slice(-4000)}`);
      const output = parseCodexOutput(stdout, plan.expectedOutput.kind);
      return {
        output,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: plan.executionTarget.modelId ?? 'codex' }
      };
    } finally {
      await rm(schemaDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function buildCodexArgs() {
  return ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-'];
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

export function parseCodexOutput(stdout: string, expectedKind: Parameters<typeof validateRuntimeOutput>[0]): RuntimeOutput {
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
  const validation = validateRuntimeOutput(expectedKind, candidate);
  if (!validation.valid) {
    throw new Error(
      `RUNTIME_OUTPUT_CONTRACT_VIOLATION: expected output kind ${expectedKind}: ${validation.errors.join('; ')}`
    );
  }
  return validation.value;
}
