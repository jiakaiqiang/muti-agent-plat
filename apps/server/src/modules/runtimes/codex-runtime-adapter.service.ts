import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  InvocationPlan,
  AgentRunResult,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentRuntimeRunHandle,
  RuntimeError,
  RuntimeFileChange,
  RuntimeOutput,
  VerifiedTestResult,
  UUID
} from '@agent-cluster/shared';
import { buildStructuredOutputInstructions, createAgentMessageOutput } from '@agent-cluster/shared';
import {
  runtimeStreamingMode,
  positiveRuntimeTimeoutMs
} from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import {
  runtimeOutputExample,
  runtimeOutputSchema,
  validateRuntimeOutput,
  type RuntimeOutputKind
} from './runtime-output-schema.js';
import { POST_REVIEW_CONTEXT_ACTION_INSTRUCTION } from './post-review-action-normalizer.js';
import {
  startCodexStreaming,
  type StreamingRunHandle,
  type StreamingRunnerOptions
} from './streaming/codex-streaming-runner.js';
import { frameToRuntimeEvent } from './streaming/frame-to-runtime-event.js';
import { WorkdirBriefService, type WorkdirBriefLease } from './streaming/workdir-brief.service.js';
import { InvocationWorkspaceBindingsService } from './invocation-workspace-bindings.service.js';
import { withStructuredTermination } from './structured-termination-run-handle.js';
import { isChildProcessTimeoutError } from '../../common/execution-termination.js';
import { extractRuntimeError } from '../../common/runtime-error.js';
import { resolveCliToolAuthority } from './cli-tool-authority.js';
import { emptyRuntimeSystemEvidence, runtimeSystemEvidence } from './runtime-system-evidence.js';
import { ToolInvocationAuditService } from '../tools/tool-invocation-audit.service.js';
import type { RuntimeStreamFrame } from './streaming/runtime-stream-frame.js';

export function buildCodexStreamingOptions(params: {
  command: string;
  args: string[];
  baseEnv: Record<string, string | undefined>;
  firstFrameTimeoutMs: number;
  idleTimeoutMs: number;
  absoluteTimeoutMs?: number;
  workDir?: string;
  resumeCliSessionId?: string;
  shell?: boolean;
}): StreamingRunnerOptions {
  const {
    command,
    args,
    baseEnv,
    firstFrameTimeoutMs,
    idleTimeoutMs,
    absoluteTimeoutMs,
    workDir,
    resumeCliSessionId,
    shell
  } = params;
  const env: Record<string, string | undefined> = { ...baseEnv };
  return {
    command,
    args,
    cwd: workDir,
    env,
    firstFrameTimeoutMs,
    idleTimeoutMs,
    absoluteTimeoutMs,
    resumeCliSessionId,
    shell
  };
}

export type CodexRunMode = 'buffered' | 'streaming';

const execFileAsync = promisify(execFile);

export function pickCodexRunMode(): CodexRunMode {
  const mode = runtimeStreamingMode();
  return mode === 'off' ? 'buffered' : 'streaming';
}

export function codexBufferedTimeoutMs() {
  const absoluteTimeoutMs = positiveRuntimeTimeoutMs('CODEX_RUNTIME_ABSOLUTE_TIMEOUT_MS', 30 * 60_000);
  const bufferedTimeoutMs = positiveRuntimeTimeoutMs('CODEX_RUNTIME_TIMEOUT_MS', 120_000);
  return Math.min(bufferedTimeoutMs, absoluteTimeoutMs);
}

export function buildCodexExecArgs(input: InvocationPlan, configuredArgs?: string) {
  const authority = resolveCliToolAuthority(input);
  if (configuredArgs?.trim()) {
    const parsed = JSON.parse(configuredArgs);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error('CODEX_RUNTIME_ARGS_JSON must be a JSON string array.');
    }
    return [...parsed, '--sandbox', authority.codexSandbox, '-'];
  }
  return ['exec', '--json', '--sandbox', authority.codexSandbox, '-'];
}

export function parseCodexExecOutput(stdout: string, expectedKind: RuntimeOutputKind): RuntimeOutput {
  const trimmed = stdout.trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const frames = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const frame = JSON.parse(line) as unknown;
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
          throw new Error('Codex JSONL output contained a non-object frame.');
        }
        return frame as Record<string, unknown>;
      });
    const messageText = frames
      .filter((frame) => frame.type === 'item.completed')
      .map((frame) => frame.item)
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .filter((item) => item.type === 'agent_message' && typeof item.text === 'string')
      .map((item) => item.text as string)
      .at(-1);
    if (!messageText) {
      throw new Error('Codex JSONL output did not contain a completed agent message.');
    }
    parsed = JSON.parse(messageText) as Record<string, unknown>;
  }
  const completedItem = parsed.item;
  if (
    parsed.type === 'item.completed' &&
    completedItem &&
    typeof completedItem === 'object' &&
    (completedItem as Record<string, unknown>).type === 'agent_message' &&
    typeof (completedItem as Record<string, unknown>).text === 'string'
  ) {
    parsed = JSON.parse((completedItem as Record<string, unknown>).text as string) as Record<string, unknown>;
  }
  const candidate = parsed;
  if (!candidate || typeof candidate !== 'object' || typeof candidate.kind !== 'string') {
    throw new Error('Codex output did not contain a RuntimeOutput kind.');
  }
  const validation = validateRuntimeOutput(candidate, expectedKind);
  if (!validation.valid) {
    throw new Error(
      `RUNTIME_OUTPUT_CONTRACT_VIOLATION: Codex buffered output for ${expectedKind}: ${validation.errors.join('; ')}`
    );
  }
  return validation.value as RuntimeOutput;
}

function parseCodexBufferedOutput(stdout: string, expectedKind: RuntimeOutputKind): RuntimeOutput {
  try {
    return parseCodexExecOutput(stdout, expectedKind);
  } catch (error) {
    const originalMessage = error instanceof Error ? error.message : String(error);
    const message = originalMessage.startsWith('RUNTIME_OUTPUT_CONTRACT_VIOLATION:')
      ? originalMessage
      : `RUNTIME_OUTPUT_CONTRACT_VIOLATION: Codex buffered output for ${expectedKind}: ${originalMessage}`;
    const runtimeError: RuntimeError = {
      code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION',
      message,
      retryable: false,
      details: { provider: 'codex', expectedKind }
    };
    throw Object.assign(new Error(message), { cause: runtimeError, runtimeError });
  }
}
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.yml', '.yaml', '.txt']);
const configFileNames = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js', 'nest-cli.json']);
const maxSnapshotFiles = 500;
const maxSnapshotFileBytes = 200_000;

@Injectable()
export class CodexRuntimeAdapterService implements AgentRuntimeAdapter {
  readonly type = 'codex' as const;
  readonly metadata = {
    name: 'codex',
    version: '2.0.0',
    category: 'external' as const,
    provider: 'openai',
    capabilityIds: ['cap-file-read', 'cap-code-search', 'cap-file-write', 'cap-command-run', 'cap-test-report'] as const,
    supportedWorkspaceCapabilities: ['read', 'write', 'command', 'test'] as const,
    supportedWorkspaceProviderKinds: ['server_local'] as const,
    supportedToolNames: ['read_file', 'search_code', 'write_file', 'run_test'] as const
  };

  private readonly streamingHandles = new Map<UUID, StreamingRunHandle>();

  constructor(
    private readonly workspaceBindings: InvocationWorkspaceBindingsService,
    private readonly workdirBrief?: WorkdirBriefService,
    private readonly toolAudit?: ToolInvocationAuditService
  ) {}

  async checkAvailability() {
    return process.env.CODEX_RUNTIME_ENABLED === 'true'
      ? { available: true }
      : { available: false, reason: 'Set CODEX_RUNTIME_ENABLED=true to register Codex.' };
  }

  start(input: InvocationPlan, signal?: AbortSignal): AgentRuntimeRunHandle {
    if (process.env.CODEX_RUNTIME_ENABLED !== 'true') {
      return withStructuredTermination(settledHandle(this.blockedResult(input, 'Codex runtime is disabled. Set CODEX_RUNTIME_ENABLED=true to run controlled local coding agents.')), input, signal);
    }
    const rootPath = this.workspaceBindings.resolveServerRoot(input);
    if (!rootPath) {
      return withStructuredTermination(settledHandle(this.blockedResult(input, 'Codex runtime requires a server_local working directory.')), input, signal);
    }
    if (input.resume?.workDir && resolve(input.resume.workDir) !== resolve(rootPath)) {
      return withStructuredTermination(settledHandle(this.failedResult(input, new Error('Resume workDir does not match the current workspace binding.'))), input, signal);
    }
    if (pickCodexRunMode() !== 'streaming') {
      return withStructuredTermination(promiseHandle(this.execute(input, signal)), input, signal);
    }
    let runner: StreamingRunHandle;
    try {
      runner = this.createStreamingRunnerWithBrief(input, signal);
    } catch (error) {
      return withStructuredTermination(settledHandle(this.failedResult(input, error)), input, signal);
    }
    return withStructuredTermination({
      events: runtimeEvents(input.invocationId, runner),
      result: runner.result,
      cancel: runner.cancel
    }, input, signal);
  }

  private async execute(input: InvocationPlan, signal?: AbortSignal): Promise<AgentRunResult> {
    if (process.env.CODEX_RUNTIME_ENABLED !== 'true') {
      return this.blockedResult(input, 'Codex runtime is disabled. Set CODEX_RUNTIME_ENABLED=true to run controlled local coding agents.');
    }

    const rootPath = this.workspaceBindings.resolveServerRoot(input);
    if (!rootPath) {
      return this.blockedResult(input, 'Codex runtime requires a server_local working directory.');
    }
    if (input.resume?.workDir && resolve(input.resume.workDir) !== resolve(rootPath)) {
      return this.failedResult(input, new Error('Resume workDir does not match the current workspace binding.'));
    }

    if (pickCodexRunMode() === 'streaming') {
      return this.runStreaming(input, signal);
    }

    const command = process.env.CODEX_RUNTIME_COMMAND ?? 'codex';
    const timeout = codexBufferedTimeoutMs();
    let promptFilePath: string | undefined;
    let briefLease: WorkdirBriefLease | undefined;

    try {
      briefLease = this.workdirBrief?.prepare(input, 'codex');
      const prompt = this.prompt(input, briefLease?.taskSidecarPath);
      promptFilePath = await this.writePromptFileIfConfigured(input, prompt);
      const commandArgs = this.commandArgs(input);
      const authority = resolveCliToolAuthority(input);
      const beforeFiles = await this.snapshotTextFiles(rootPath);
      const { stdout, stderr } = await this.runBufferedCommand(
        command,
        commandArgs,
        promptFilePath ?? prompt,
        rootPath,
        timeout,
        input,
        promptFilePath,
        signal
      );
      const parsedOutput = parseCodexBufferedOutput(stdout, input.expectedOutput.kind);
      const actualFileChanges = await this.actualFileChanges(rootPath, beforeFiles);
      const testResult = authority.canRunTests ? await this.runConfiguredTests(rootPath, signal) : undefined;
      return {
        invocationId: input.invocationId,
        runtimeType: this.type,
        status: 'completed',
        output: parsedOutput,
        events: [
          {
            invocationId: input.invocationId,
            type: 'runtime_completed',
            visibility: 'user',
            content: `${input.agent.name} completed ${input.phase} with Codex.`,
            metadata: { stderr: stderr.trim() || undefined },
            createdAt: nowIso()
          }
        ],
        artifacts: this.outputArtifacts(parsedOutput),
        systemEvidence: runtimeSystemEvidence(input, actualFileChanges, testResult ? [testResult] : []),
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          model: 'codex'
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = !signal?.aborted && isChildProcessTimeoutError(error);
      const preservedRuntimeError = extractRuntimeError(error);
      const runtimeError: RuntimeError = signal?.aborted
        ? { code: 'RUNTIME_CANCELLED', message, retryable: false }
        : timedOut
          ? { code: 'RUNTIME_TIMEOUT', message, retryable: true, details: { timeoutMs: timeout } }
          : preservedRuntimeError ?? { code: 'MODEL_ERROR', message, retryable: true };
      return {
        invocationId: input.invocationId,
        runtimeType: this.type,
        status: signal?.aborted ? 'cancelled' : 'failed',
        output: createAgentMessageOutput({
          messageKind: 'risk',
          content: `${input.agent.name} Codex runtime failed: ${message}`
        }),
        events: [
          {
            invocationId: input.invocationId,
            type: 'runtime_failed',
            visibility: 'user',
            content: `${input.agent.name} Codex runtime failed.`,
            metadata: { message, code: runtimeError.code },
            createdAt: nowIso()
          }
        ],
        artifacts: [],
        systemEvidence: emptyRuntimeSystemEvidence(input.invocationId),
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          model: 'codex'
        },
        error: runtimeError
      };
    } finally {
      if (promptFilePath) {
        await rm(promptFilePath, { force: true });
      }
      briefLease?.restore();
    }
  }

  private async writePromptFileIfConfigured(input: InvocationPlan, prompt: string) {
    if (process.env.CODEX_RUNTIME_PROMPT_MODE !== 'file') {
      return undefined;
    }
    const promptFilePath = join(tmpdir(), `agent-cluster-codex-${input.invocationId}.prompt.txt`);
    await writeFile(promptFilePath, prompt, 'utf8');
    return promptFilePath;
  }

  private useShell() {
    const configured = process.env.CODEX_RUNTIME_SHELL?.trim();
    if (configured) {
      return configured === 'true';
    }
    return process.platform === 'win32';
  }

  private commandArgs(input: InvocationPlan) {
    return buildCodexExecArgs(input, process.env.CODEX_RUNTIME_ARGS_JSON);
  }

  private runBufferedCommand(
    command: string,
    args: string[],
    prompt: string,
    cwd: string,
    timeout: number,
    input: InvocationPlan,
    promptFilePath?: string,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolveCommand, rejectCommand) => {
      const child = execFile(command, args, {
        cwd,
        timeout,
        shell: this.useShell(),
        signal,
        env: this.runtimeEnv(input, promptFilePath),
        maxBuffer: Number(process.env.CODEX_RUNTIME_MAX_BUFFER ?? 8 * 1024 * 1024),
        encoding: 'utf8'
      }, (error, stdout, stderr) => {
        if (error) {
          rejectCommand(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolveCommand({ stdout, stderr });
      });
      child.stdin?.end(prompt, 'utf8');
    });
  }

  private runtimeEnv(input: InvocationPlan, promptFilePath?: string) {
    return {
      ...process.env,
      AGENT_CLUSTER_RUNTIME_TYPE: this.type,
      AGENT_CLUSTER_RUNTIME_PHASE: input.phase,
      AGENT_CLUSTER_SESSION_ID: input.sessionId,
      AGENT_CLUSTER_TASK_ID: input.taskId ?? '',
      AGENT_CLUSTER_AGENT_ID: input.agent.agentId,
      AGENT_CLUSTER_AGENT_KEY: input.agent.key,
      AGENT_CLUSTER_EXPECTED_OUTPUT_KIND: input.expectedOutput.kind,
      AGENT_CLUSTER_PROMPT_FILE: promptFilePath
    };
  }

  private prompt(input: InvocationPlan, taskSidecarPath?: string) {
    if (taskSidecarPath) {
      return [
        'You are running as an Agent Cluster Codex coding runtime.',
        `Act as the ${input.agent.role} agent for the current task.`,
        `Read the workdir AGENTS.md block and task sidecar at: ${taskSidecarPath}`,
        `Return exactly one JSON object of kind ${input.expectedOutput.kind}.`,
        buildStructuredOutputInstructions(input.expectedOutput.kind),
        input.expectedOutput.kind === 'post_review_report' ? POST_REVIEW_CONTEXT_ACTION_INSTRUCTION : ''
      ].filter(Boolean).join('\n');
    }
    return [
      'You are running as an Agent Cluster Codex coding runtime.',
      'Work inside the allowed server_local directory only.',
      'Return one JSON object and no markdown fences.',
      `Required output kind: ${input.expectedOutput.kind}.`,
      buildStructuredOutputInstructions(input.expectedOutput.kind),
      'Use ContextEnvelopeV2 L1/L2 for navigation and L3 for readable evidence.',
      'If selected evidence is insufficient, return a blocked task_execution_result or runtime error with code CONTEXT_INSUFFICIENT and requestedContext; do not fabricate unread file contents, APIs, logs, or test results.',
      'For task_acceptance_decision, return the schema fields directly and do not reassign the task yourself.',
      'For task_execution_result, include changedArtifacts with metadata.fileChanges for every file you changed or propose to change.',
      'For validation task_execution_result, include a test_report changedArtifact with metadata.validationEvidence mapping each taskContext.validationRules item to verdict status, evidenceRefs, notes, and missingEvidence, plus validatorAgentKey, validatorAgentId, and independentFromAgentKeys from taskContext.agentResponsibilities.',
      'For task_execution_result, include optional agentMessages when you need to communicate progress, risks, questions, or handoffs to other agents. Use targetAgentKeys such as coordinator, frontend, backend, test, review.',
      input.expectedOutput.kind === 'post_review_report' ? POST_REVIEW_CONTEXT_ACTION_INSTRUCTION : '',
      'If you run tests, include the test result summary in completedItems or risks.',
      '',
      'Runtime input JSON:',
      JSON.stringify(
        {
          phase: input.phase,
          agent: input.agent,
          contextEnvelope: input.contextEnvelope,
          executionTarget: input.executionTarget,
          toolCatalog: input.toolCatalog,
          expectedOutput: input.expectedOutput,
          outputSchema: runtimeOutputSchema(input.expectedOutput.kind),
          outputExample: runtimeOutputExample(input.expectedOutput.kind)
        },
        null,
        2
      )
    ].filter(Boolean).join('\n');
  }

  private outputArtifacts(output: RuntimeOutput) {
    return output.kind === 'task_execution_result' ? output.changedArtifacts : [];
  }

  private async snapshotTextFiles(rootPath: string) {
    const files = new Map<string, string>();

    const scan = async (currentPath: string) => {
      if (files.size >= maxSnapshotFiles) {
        return;
      }
      const entries = await readdir(currentPath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (files.size >= maxSnapshotFiles) {
          return;
        }
        const absolutePath = join(currentPath, entry.name);
        const path = relative(rootPath, absolutePath).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          if (!ignoredDirectories.has(entry.name)) {
            await scan(absolutePath);
          }
          continue;
        }
        if (!this.shouldReadTextFile(path)) {
          continue;
        }
        const fileStat = await stat(absolutePath);
        if (fileStat.size > maxSnapshotFileBytes) {
          continue;
        }
        files.set(path, await readFile(absolutePath, 'utf8'));
      }
    };

    await scan(rootPath);
    return files;
  }

  private async actualFileChanges(rootPath: string, beforeFiles: Map<string, string>): Promise<RuntimeFileChange[]> {
    const afterFiles = await this.snapshotTextFiles(rootPath);
    const changes: RuntimeFileChange[] = [];

    for (const [path, beforeContent] of beforeFiles.entries()) {
      if (!afterFiles.has(path)) {
        changes.push({
          path,
          operation: 'delete',
          previousContent: beforeContent,
          encoding: 'utf-8',
          source: 'actual_filesystem_snapshot'
        });
        continue;
      }
      const afterContent = afterFiles.get(path);
      if (afterContent !== beforeContent) {
        changes.push({
          path,
          operation: 'update',
          previousContent: beforeContent,
          content: afterContent,
          encoding: 'utf-8',
          source: 'actual_filesystem_snapshot'
        });
      }
    }

    for (const [path, afterContent] of afterFiles.entries()) {
      if (!beforeFiles.has(path)) {
        changes.push({
          path,
          operation: 'create',
          previousContent: null,
          content: afterContent,
          encoding: 'utf-8',
          source: 'actual_filesystem_snapshot'
        });
      }
    }

    return changes;
  }

  private async runConfiguredTests(rootPath: string, signal?: AbortSignal): Promise<VerifiedTestResult | undefined> {
    const testCommand = process.env.CODEX_RUNTIME_TEST_COMMAND?.trim();
    if (!testCommand) {
      return undefined;
    }
    const startedAt = nowIso();
    try {
      const { stdout, stderr } = await execFileAsync(testCommand, {
        cwd: rootPath,
        shell: true,
        signal,
        timeout: Number(process.env.CODEX_RUNTIME_TEST_TIMEOUT_MS ?? 120_000),
        maxBuffer: Number(process.env.CODEX_RUNTIME_MAX_BUFFER ?? 8 * 1024 * 1024)
      });
      return {
        command: testCommand,
        status: 'passed',
        exitCode: 0,
        stdout,
        stderr,
        startedAt,
        completedAt: nowIso()
      };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      return {
        command: testCommand,
        status: 'failed',
        exitCode: typeof failure.code === 'number' ? failure.code : null,
        stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
        stderr: typeof failure.stderr === 'string' ? failure.stderr : error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: nowIso()
      };
    }
  }

  private shouldReadTextFile(path: string) {
    const name = path.split('/').at(-1) ?? path;
    return configFileNames.has(name) || textExtensions.has(extname(path).toLowerCase());
  }

  private async runStreaming(input: InvocationPlan, signal?: AbortSignal): Promise<AgentRunResult> {
    const handle = this.createStreamingRunnerWithBrief(input, signal);
    this.streamingHandles.set(input.invocationId, handle);
    try {
      return await handle.result;
    } finally {
      this.streamingHandles.delete(input.invocationId);
    }
  }

  private createStreamingRunnerWithBrief(input: InvocationPlan, signal?: AbortSignal): StreamingRunHandle {
    const briefLease = this.workdirBrief?.prepare(input, 'codex');
    try {
      const runner = this.createStreamingRunner(input, signal, briefLease?.taskSidecarPath);
      return {
        ...runner,
        result: runner.result.finally(() => briefLease?.restore())
      };
    } catch (error) {
      briefLease?.restore();
      throw error;
    }
  }

  private createStreamingRunner(
    input: InvocationPlan,
    signal?: AbortSignal,
    taskSidecarPath?: string
  ): StreamingRunHandle {
    const command = process.env.CODEX_RUNTIME_COMMAND ?? 'codex';
    const argsJson = process.env.CODEX_RUNTIME_ARGS_JSON?.trim();
    const args = argsJson
      ? (JSON.parse(argsJson) as string[])
      : ['app-server', '--listen', 'stdio://'];
    const pendingTools = new Map<string, { toolName: string; argumentsValue: unknown; startedAt: string }>();
    const auditWrites = new Set<Promise<boolean>>();
    const scheduleAudit = (write: Promise<boolean> | undefined) => {
      if (!write) return;
      let tracked: Promise<boolean>;
      tracked = write.catch(() => false).finally(() => auditWrites.delete(tracked));
      auditWrites.add(tracked);
    };
    const streamingOptions: StreamingRunnerOptions = {
      ...buildCodexStreamingOptions({
        command,
        args,
        baseEnv: this.runtimeEnv(input),
        firstFrameTimeoutMs: positiveRuntimeTimeoutMs('CODEX_RUNTIME_FIRST_FRAME_TIMEOUT_MS', 30_000),
        idleTimeoutMs: positiveRuntimeTimeoutMs('CODEX_RUNTIME_IDLE_TIMEOUT_MS', 600_000),
        absoluteTimeoutMs: positiveRuntimeTimeoutMs('CODEX_RUNTIME_ABSOLUTE_TIMEOUT_MS', 30 * 60_000),
        workDir: this.workspaceBindings.resolveServerRoot(input),
        shell: this.useShell()
      }),
      prompt: this.prompt(input, taskSidecarPath),
      outputSchema: runtimeOutputSchema(input.expectedOutput.kind),
      model: input.executionTarget.modelId,
      resumeCliSessionId: input.resume?.cliSessionId,
      sandbox: resolveCliToolAuthority(input).codexSandbox
    };
    streamingOptions.onFrame = (frame: RuntimeStreamFrame) => {
      if (frame.kind === 'tool_use') {
        pendingTools.set(frame.toolCallId, { toolName: frame.tool, argumentsValue: frame.input, startedAt: nowIso() });
        return;
      }
      if (frame.kind !== 'tool_result') return;
      const pending = pendingTools.get(frame.toolCallId);
      if (!pending) return;
      pendingTools.delete(frame.toolCallId);
      const mcp = parseMcpToolName(pending.toolName);
      if (mcp) {
        scheduleAudit(this.toolAudit?.recordMcp({
          serverExternalId: `mcp:${mcp.server}`,
          serverName: mcp.server,
          toolName: mcp.tool,
          providerCallId: frame.toolCallId,
          runtimeInvocationExternalId: input.invocationId,
          sessionExternalId: input.sessionId,
          agentExternalId: input.agent.agentId,
          arguments: pending.argumentsValue,
          result: frame.output,
          success: !frame.isError,
          startedAt: pending.startedAt,
          completedAt: nowIso(),
          errorMessage: frame.isError ? frame.output : undefined
        }));
      } else {
        scheduleAudit(this.toolAudit?.record({
          externalId: `tool:${input.invocationId}:${frame.toolCallId}`,
          runtimeInvocationExternalId: input.invocationId,
          sessionExternalId: input.sessionId,
          toolName: pending.toolName || frame.tool || 'unknown',
          providerCallId: frame.toolCallId,
          provider: this.type,
          arguments: pending.argumentsValue,
          result: frame.output,
          success: !frame.isError,
          errorMessage: frame.isError ? frame.output : undefined,
          agentExternalId: input.agent.agentId,
          startedAt: pending.startedAt,
          completedAt: nowIso()
        }));
      }
    };
    const runner = startCodexStreaming(input, streamingOptions, signal);
    const settleAudits = async () => {
      for (const [toolCallId, pending] of pendingTools) {
        const mcp = parseMcpToolName(pending.toolName);
        if (mcp) {
          scheduleAudit(this.toolAudit?.recordMcp({
            serverExternalId: `mcp:${mcp.server}`,
            serverName: mcp.server,
            toolName: mcp.tool,
            providerCallId: toolCallId,
            runtimeInvocationExternalId: input.invocationId,
            sessionExternalId: input.sessionId,
            agentExternalId: input.agent.agentId,
            arguments: pending.argumentsValue,
            success: false,
            errorMessage: 'Runtime ended before the MCP Tool returned a result.',
            startedAt: pending.startedAt,
            completedAt: nowIso()
          }));
        } else {
          scheduleAudit(this.toolAudit?.record({
            externalId: `tool:${input.invocationId}:${toolCallId}`,
            runtimeInvocationExternalId: input.invocationId,
            sessionExternalId: input.sessionId,
            toolName: pending.toolName || 'unknown',
            providerCallId: toolCallId,
            provider: this.type,
            arguments: pending.argumentsValue,
            success: false,
            errorMessage: 'Runtime ended before the Tool returned a result.',
            agentExternalId: input.agent.agentId,
            startedAt: pending.startedAt,
            completedAt: nowIso()
          }));
        }
      }
      pendingTools.clear();
      await Promise.allSettled([...auditWrites]);
    };
    return { ...runner, result: runner.result.finally(settleAudits) };
  }

  stream(invocationId: UUID): AsyncIterable<AgentRuntimeEvent> {
    const handle = this.streamingHandles.get(invocationId);
    const runtimeType = this.type;
    if (!handle) {
      return {
        async *[Symbol.asyncIterator]() {
          /* empty */
        }
      };
    }
    return {
      async *[Symbol.asyncIterator]() {
        for await (const frame of handle.channel) {
          const event = frameToRuntimeEvent(invocationId, frame);
          if (event) yield event;
        }
      }
    };
  }

  async cancel(invocationId: UUID): Promise<void> {
    const handle = this.streamingHandles.get(invocationId);
    await handle?.cancel();
  }

  private blockedResult(input: InvocationPlan, message: string): AgentRunResult {
    return {
      invocationId: input.invocationId,
      runtimeType: this.type,
      status: 'blocked',
      output: createAgentMessageOutput({ messageKind: 'risk', content: message }),
      events: [
        {
          invocationId: input.invocationId,
          type: 'runtime_failed',
          visibility: 'user',
          content: message,
          metadata: { code: 'CAPABILITY_BLOCKED', message },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      systemEvidence: emptyRuntimeSystemEvidence(input.invocationId),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: 'codex'
      },
      error: {
        code: 'CAPABILITY_BLOCKED',
        message,
        retryable: false
      }
    };
  }

  private failedResult(input: InvocationPlan, error: unknown): AgentRunResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      invocationId: input.invocationId,
      runtimeType: this.type,
      status: 'failed',
      output: createAgentMessageOutput({ messageKind: 'risk', content: message }),
      events: [
        {
          invocationId: input.invocationId,
          type: 'runtime_failed',
          visibility: 'user',
          content: message,
          metadata: { code: 'MODEL_ERROR', message },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      systemEvidence: emptyRuntimeSystemEvidence(input.invocationId),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'codex' },
      error: { code: 'MODEL_ERROR', message, retryable: true }
    };
  }
}

function runtimeEvents(invocationId: UUID, handle: StreamingRunHandle): AsyncIterable<AgentRuntimeEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const frame of handle.channel) {
        const event = frameToRuntimeEvent(invocationId, frame);
        if (event) yield event;
      }
    }
  };
}

function emptyEvents(): AsyncIterable<AgentRuntimeEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      // Legacy and blocked runs do not expose intermediate frames.
    }
  };
}

function settledHandle(result: AgentRunResult): AgentRuntimeRunHandle {
  return {
    events: emptyEvents(),
    result: Promise.resolve(result),
    cancel: async () => {}
  };
}

function promiseHandle(result: Promise<AgentRunResult>): AgentRuntimeRunHandle {
  return {
    events: emptyEvents(),
    result,
    cancel: async () => {}
  };
}

function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
  if (toolName.startsWith('mcp__')) {
    const [server, ...toolParts] = toolName.slice(5).split('__');
    const tool = toolParts.join('__');
    if (server && tool) return { server, tool };
  }
  if (toolName.includes('/')) {
    const [server, ...toolParts] = toolName.split('/');
    const tool = toolParts.join('/');
    if (server && tool) return { server, tool };
  }
  return undefined;
}
