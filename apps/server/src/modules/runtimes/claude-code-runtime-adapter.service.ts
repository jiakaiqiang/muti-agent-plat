import { Injectable, Optional } from '@nestjs/common';
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
import { createAgentMessageOutput } from '@agent-cluster/shared';
import {
  runtimeStreamingMode,
  optionalRuntimeTimeoutMs,
  positiveRuntimeTimeoutMs
} from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import { POST_REVIEW_CONTEXT_ACTION_INSTRUCTION } from './post-review-action-normalizer.js';
import {
  startClaudeStreaming,
  type ClaudeStreamingRunHandle,
  type ClaudeStreamingRunnerOptions
} from './streaming/claude-streaming-runner.js';
import { frameToRuntimeEvent } from './streaming/frame-to-runtime-event.js';
import type { RuntimeStreamFrame } from './streaming/runtime-stream-frame.js';
import { WorkdirBriefService, type WorkdirBriefLease } from './streaming/workdir-brief.service.js';
import { InvocationWorkspaceBindingsService } from './invocation-workspace-bindings.service.js';
import { withStructuredTermination } from './structured-termination-run-handle.js';
import { isChildProcessTimeoutError } from '../../common/execution-termination.js';
import { extractRuntimeError } from '../../common/runtime-error.js';
import { resolveCliToolAuthority } from './cli-tool-authority.js';
import {
  runtimeOutputExample,
  runtimeOutputSchema,
  validateRuntimeOutput,
  type RuntimeOutputKind
} from './runtime-output-schema.js';
import { emptyRuntimeSystemEvidence, runtimeSystemEvidence } from './runtime-system-evidence.js';
import {
  resolveClaudeCommand,
  sanitizeClaudeProcessError
} from './claude-cli-launcher.js';
import { ToolInvocationAuditService } from '../tools/tool-invocation-audit.service.js';

export function buildClaudeStreamingOptions(params: {
  command: string;
  args: string[];
  baseEnv: Record<string, string | undefined>;
  firstFrameTimeoutMs: number;
  idleTimeoutMs: number;
  absoluteTimeoutMs?: number;
  workDir?: string;
  resumeCliSessionId?: string;
}): ClaudeStreamingRunnerOptions {
  const {
    command,
    args,
    baseEnv,
    firstFrameTimeoutMs,
    idleTimeoutMs,
    absoluteTimeoutMs,
    workDir,
    resumeCliSessionId
  } = params;
  return {
    command,
    args: resumeCliSessionId ? [...args, '--resume', resumeCliSessionId] : [...args],
    cwd: workDir,
    env: { ...baseEnv },
    firstFrameTimeoutMs,
    idleTimeoutMs,
    absoluteTimeoutMs
  };
}

const execFileAsync = promisify(execFile);

export type ClaudeRunMode = 'buffered' | 'streaming';

export function pickClaudeRunMode(): ClaudeRunMode {
  return runtimeStreamingMode() === 'all' ? 'streaming' : 'buffered';
}

export function claudeBufferedTimeoutMs() {
  const absoluteTimeoutMs = positiveRuntimeTimeoutMs('CLAUDE_CODE_ABSOLUTE_TIMEOUT_MS', 30 * 60_000);
  const bufferedTimeoutMs = optionalRuntimeTimeoutMs('CLAUDE_CODE_TIMEOUT_MS') ?? absoluteTimeoutMs;
  return Math.min(bufferedTimeoutMs, absoluteTimeoutMs);
}

export function buildClaudeBufferedArgs(params: {
  outputSchema: Record<string, unknown>;
  permissionMode: string;
  rootPath: string;
  allowedTools: string;
}): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(params.outputSchema),
    '--permission-mode',
    params.permissionMode,
    '--add-dir',
    params.rootPath,
    '--allowedTools',
    params.allowedTools
  ];
}

function unwrapClaudeJsonFence(value: string) {
  const trimmed = value.trim();
  const match = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

export function parseClaudeBufferedOutput(
  stdout: string,
  expectedKind: RuntimeOutputKind
): RuntimeOutput {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  const outer = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
  const providerOutput = outer && Object.prototype.hasOwnProperty.call(outer, 'structured_output')
    ? outer.structured_output
    : outer && Object.prototype.hasOwnProperty.call(outer, 'result')
      ? outer.result
      : parsed;
  const candidate = typeof providerOutput === 'string'
    ? JSON.parse(unwrapClaudeJsonFence(providerOutput))
    : providerOutput;
  const validation = validateRuntimeOutput(candidate, expectedKind);
  if (!validation.valid) {
    throw new Error(
      `RUNTIME_OUTPUT_CONTRACT_VIOLATION: Claude buffered output for ${expectedKind}: ${validation.errors.join('; ')}`
    );
  }
  return validation.value as RuntimeOutput;
}

function parseClaudeBufferedOutputWithRuntimeError(
  stdout: string,
  expectedKind: RuntimeOutputKind
): RuntimeOutput {
  try {
    return parseClaudeBufferedOutput(stdout, expectedKind);
  } catch (error) {
    const originalMessage = error instanceof Error ? error.message : String(error);
    const message = originalMessage.startsWith('RUNTIME_OUTPUT_CONTRACT_VIOLATION:')
      ? originalMessage
      : `RUNTIME_OUTPUT_CONTRACT_VIOLATION: Claude buffered output for ${expectedKind}: ${originalMessage}`;
    const runtimeError: RuntimeError = {
      code: 'RUNTIME_OUTPUT_CONTRACT_VIOLATION',
      message,
      retryable: false,
      details: { provider: 'claude_code', expectedKind }
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
export class ClaudeCodeRuntimeAdapterService implements AgentRuntimeAdapter {
  readonly type = 'claude_code' as const;
  readonly metadata = {
    name: 'claude-code',
    version: '2.0.0',
    category: 'external' as const,
    provider: 'anthropic',
    capabilityIds: ['cap-file-read', 'cap-code-search', 'cap-file-write', 'cap-command-run', 'cap-test-report'] as const,
    supportedWorkspaceCapabilities: ['read', 'write', 'command', 'test'] as const,
    supportedWorkspaceProviderKinds: ['server_local'] as const,
    supportedToolNames: ['read_file', 'search_code', 'write_file', 'run_test'] as const
  };

  private readonly streamingHandles = new Map<UUID, ClaudeStreamingRunHandle>();

  constructor(
    private readonly workspaceBindings: InvocationWorkspaceBindingsService,
    private readonly workdirBrief?: WorkdirBriefService,
    @Optional() private readonly toolAudit?: ToolInvocationAuditService
  ) {}

  async checkAvailability() {
    if (process.env.CLAUDE_CODE_ENABLED !== 'true') {
      return { available: false, reason: 'Set CLAUDE_CODE_ENABLED=true to register Claude Code.' };
    }
    try {
      const command = resolveClaudeCommand();
      await execFileAsync(command.executable, ['--version'], {
        shell: false,
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 64 * 1024
      });
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason: extractRuntimeError(error)?.message ?? 'Claude Code native executable is unavailable.'
      };
    }
  }

  start(input: InvocationPlan, signal?: AbortSignal): AgentRuntimeRunHandle {
    if (process.env.CLAUDE_CODE_ENABLED !== 'true') {
      return withStructuredTermination(settledHandle(this.blockedResult(input, 'Claude Code runtime is disabled. Set CLAUDE_CODE_ENABLED=true to run controlled local coding agents.')), input, signal);
    }
    const rootPath = this.workspaceBindings.resolveServerRoot(input);
    if (!rootPath) {
      return withStructuredTermination(settledHandle(this.blockedResult(input, 'Claude Code runtime requires a server_local working directory.')), input, signal);
    }
    if (input.resume?.workDir && resolve(input.resume.workDir) !== resolve(rootPath)) {
      return withStructuredTermination(settledHandle(this.failedResult(input, new Error('Resume workDir does not match the current workspace binding.'))), input, signal);
    }
    if (pickClaudeRunMode() !== 'streaming') {
      return withStructuredTermination(promiseHandle(this.execute(input, signal)), input, signal);
    }
    let runner: ClaudeStreamingRunHandle;
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
    if (process.env.CLAUDE_CODE_ENABLED !== 'true') {
      return this.blockedResult(input, 'Claude Code runtime is disabled. Set CLAUDE_CODE_ENABLED=true to run controlled local coding agents.');
    }

    const rootPath = this.workspaceBindings.resolveServerRoot(input);
    if (!rootPath) {
      return this.blockedResult(input, 'Claude Code runtime requires a server_local working directory.');
    }
    if (input.resume?.workDir && resolve(input.resume.workDir) !== resolve(rootPath)) {
      return this.failedResult(input, new Error('Resume workDir does not match the current workspace binding.'));
    }

    if (pickClaudeRunMode() === 'streaming') {
      return this.runStreaming(input, signal);
    }

    const timeout = claudeBufferedTimeoutMs();
    let promptFilePath: string | undefined;
    let briefLease: WorkdirBriefLease | undefined;
    let beforeFiles: Map<string, string> | undefined;
    try {
      briefLease = this.workdirBrief?.prepare(input, 'claude_code');
      const prompt = this.prompt(input, briefLease?.taskSidecarPath);
      promptFilePath = await this.writePromptFileIfConfigured(input, prompt);
      beforeFiles = await this.snapshotTextFiles(rootPath);
      const authority = resolveCliToolAuthority(input);
      const command = resolveClaudeCommand();
      const { stdout, stderr } = await this.runBufferedCommand(
        command.executable,
        buildClaudeBufferedArgs({
          outputSchema: runtimeOutputSchema(input.expectedOutput.kind),
          permissionMode: authority.claudePermissionMode,
          rootPath,
          allowedTools: authority.claudeAllowedTools
        }),
        prompt,
        {
          cwd: rootPath,
          timeout,
          signal,
          env: this.runtimeEnv(input, promptFilePath),
          maxBuffer: Number(process.env.CLAUDE_CODE_MAX_BUFFER ?? 8 * 1024 * 1024),
          diagnosticRef: input.invocationId
        }
      );
      const parsedOutput = parseClaudeBufferedOutputWithRuntimeError(stdout, input.expectedOutput.kind);
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
            content: `${input.agent.name} completed ${input.phase} with Claude Code.`,
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
          model: 'claude_code'
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = !signal?.aborted && isChildProcessTimeoutError(error);
      const processFailure = error as {
        stdout?: unknown;
        stderr?: unknown;
        exitCode?: unknown;
      };
      if (
        !signal?.aborted &&
        !timedOut &&
        typeof processFailure.exitCode === 'number' &&
        processFailure.exitCode !== 0 &&
        typeof processFailure.stdout === 'string' &&
        processFailure.stdout.trim()
      ) {
        try {
          const recoveredOutput = parseClaudeBufferedOutputWithRuntimeError(
            processFailure.stdout,
            input.expectedOutput.kind
          );
          const actualFileChanges = beforeFiles
            ? await this.actualFileChanges(rootPath, beforeFiles)
            : [];
          const stderrTail = typeof processFailure.stderr === 'string'
            ? processFailure.stderr.slice(-16 * 1024)
            : null;
          return {
            invocationId: input.invocationId,
            runtimeType: this.type,
            status: 'completed',
            output: recoveredOutput,
            events: [
              {
                invocationId: input.invocationId,
                type: 'runtime_completed',
                visibility: 'user',
                content: `${input.agent.name} completed ${input.phase} with Claude Code; the CLI returned a non-zero exit code after producing a valid result.`,
                metadata: {
                  warning: 'CLAUDE_NONZERO_EXIT_WITH_VALID_OUTPUT',
                  exitCode: processFailure.exitCode
                },
                createdAt: nowIso()
              }
            ],
            artifacts: this.outputArtifacts(recoveredOutput),
            systemEvidence: runtimeSystemEvidence(input, actualFileChanges, []),
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              model: 'claude_code'
            },
            runtimeDiagnostics: {
              providerNotifications: [],
              unknownNotificationCount: 0,
              stderrTail
            }
          };
        } catch {
          // The process result remains a failure when stdout is not a valid
          // instance of the expected Runtime output contract.
        }
      }
      const preservedRuntimeError = extractRuntimeError(error);
      const runtimeError: RuntimeError = signal?.aborted
        ? { code: 'RUNTIME_CANCELLED', message, retryable: false }
        : timedOut
          ? { code: 'RUNTIME_TIMEOUT', message, retryable: true, details: { timeoutMs: timeout } }
          : preservedRuntimeError ?? { code: 'MODEL_ERROR', message, retryable: true };
      const stderrTail = typeof processFailure.stderr === 'string'
        ? processFailure.stderr.slice(-16 * 1024)
        : null;
      const providerFailure = runtimeError.details?.providerFailure === true
        ? [{
            method: 'provider_error',
            disposition: 'debug_only' as const,
            payload: {
              provider: runtimeError.details.provider,
              stage: runtimeError.details.stage,
              httpStatus: runtimeError.details.httpStatus,
              errorName: runtimeError.details.errorName,
              errorCategory: runtimeError.details.errorCategory,
              gatewayZone: runtimeError.details.gatewayZone,
              rayId: runtimeError.details.rayId,
              retryAfterMs: runtimeError.details.retryAfterMs,
              exitCode: runtimeError.details.exitCode,
              diagnosticRef: runtimeError.details.diagnosticRef
            }
          }]
        : [];
      return {
        invocationId: input.invocationId,
        runtimeType: this.type,
        status: signal?.aborted ? 'cancelled' : 'failed',
        output: createAgentMessageOutput({
          messageKind: 'risk',
          content: `${input.agent.name} Claude Code runtime failed: ${message}`
        }),
        events: [
          {
            invocationId: input.invocationId,
            type: 'runtime_failed',
            visibility: 'user',
            content: `${input.agent.name} Claude Code runtime failed.`,
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
          model: 'claude_code'
        },
        runtimeDiagnostics: {
          providerNotifications: providerFailure,
          unknownNotificationCount: 0,
          stderrTail
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

  private prompt(input: InvocationPlan, taskSidecarPath?: string) {
    const outputSchema = runtimeOutputSchema(input.expectedOutput.kind);
    const outputExample = runtimeOutputExample(input.expectedOutput.kind);
    if (taskSidecarPath) {
      return [
        'You are running as an Agent Cluster Claude Code runtime.',
        `Act as the ${input.agent.role} agent for the current task.`,
        `Read the workdir CLAUDE.md block and task sidecar at: ${taskSidecarPath}`,
        `Return exactly one JSON object of kind ${input.expectedOutput.kind} without markdown fences.`,
        input.expectedOutput.kind === 'task_brief'
          ? 'For every suggestedTasks item, routingMode must be exactly "coordinator_controlled", "agent_suggested", "agent_delegated", or null. Copy the underscore-separated spelling exactly.'
          : '',
        'Output JSON Schema:',
        JSON.stringify(outputSchema, null, 2),
        'Output JSON example:',
        JSON.stringify(outputExample, null, 2),
        input.expectedOutput.kind === 'post_review_report' ? POST_REVIEW_CONTEXT_ACTION_INSTRUCTION : ''
      ].filter(Boolean).join('\n');
    }
    return [
      'You are running as an Agent Cluster coding runtime.',
      'Work inside the allowed server_local directory only.',
      'Return one JSON object and no markdown fences.',
      `Required output kind: ${input.expectedOutput.kind}.`,
      'Use ContextEnvelopeV2 L1/L2 for navigation and L3 for readable evidence.',
      'If selected evidence is insufficient, return a blocked task_execution_result or runtime error with code CONTEXT_INSUFFICIENT and requestedContext; do not fabricate unread file contents, APIs, logs, or test results.',
      'For task_acceptance_decision, decide whether this assigned agent can execute the currentTask. Return status accepted, blocked, or rejected; reason; optional missingContext; optional handoffSuggestion { targetAgentKey or targetAgentId, reason, riskLevel }; optional confidence; optional alternativeAgentKeys/alternativeAgentIds; and optional agentMessages. Do not reassign the task yourself.',
      'For task_acceptance_decision, return status, reason, optional confidence, optional alternativeAgentKeys/alternativeAgentIds, optional handoffSuggestion, and optional agentMessages. Do not reassign the task yourself.',
      'For task_execution_result, include changedArtifacts with metadata.fileChanges for every file you changed or propose to change.',
      'For validation task_execution_result, include a test_report changedArtifact with metadata.validationEvidence mapping each taskContext.validationRules item to verdict status, evidenceRefs, notes, and missingEvidence, plus validatorAgentKey, validatorAgentId, and independentFromAgentKeys from taskContext.agentResponsibilities.',
      'For task_execution_result, include optional agentMessages when you need to communicate progress, risks, questions, or handoffs to other agents. Use targetAgentKeys such as coordinator, frontend, backend, test, review.',
      input.expectedOutput.kind === 'post_review_report' ? POST_REVIEW_CONTEXT_ACTION_INSTRUCTION : '',
      'If you run tests, include the test result summary in completedItems or risks.',
      input.expectedOutput.kind === 'task_brief'
        ? [
            'CRITICAL: You MUST return a complete task_brief JSON object with ALL required fields.',
            '',
            'Required top-level fields:',
            '  - schemaVersion: "1.0" (literal string)',
            '  - kind: "task_brief" (literal string)',
            '  - goal: non-empty string describing the overall objective',
            '  - scope: array of strings (what is included)',
            '  - outOfScope: array of strings (what is excluded)',
            '  - constraints: array of strings (technical/resource constraints)',
            '  - acceptanceCriteria: array of strings (how to verify success)',
            '  - risks: array of strings (potential issues)',
            '  - openQuestions: array of strings (unresolved items)',
            '  - suggestedTasks: array of task objects (at least 1 required)',
            '',
            'Each suggestedTasks item MUST have:',
            '  - title: non-empty string',
            '  - description: non-empty string',
            '  - suggestedAgentKey: string or null (e.g., "architect", "frontend", "backend")',
            '  - routingMode: EXACTLY one of "coordinator_controlled", "agent_suggested", "agent_delegated", or null (copy the underscore spelling)',
            '  - assignmentReason: string or null',
            '  - contextRequirements: array of strings',
            '  - verificationPlan: array of strings',
            '  - riskNotes: array of strings',
            '  - requiresUserConfirmation: boolean (true or false)',
            '  - dependsOnTaskTitles: array of strings',
            '  - acceptanceCriteria: array of strings',
            '',
            'When acting as an architect analyzing project architecture:',
            '  1. Set goal to describe the architecture understanding objective',
            '  2. In scope: list key directories/modules/components to analyze',
            '  3. In outOfScope: list what is NOT part of this analysis',
            '  4. Create ONE architect task in suggestedTasks with:',
            '     - title: "分析项目架构与主链路"',
            '     - description: detailed analysis plan (what to analyze, how to analyze, expected output)',
            '     - suggestedAgentKey: "architect"',
            '     - routingMode: "coordinator_controlled"',
            '     - requiresUserConfirmation: false',
            '     - acceptanceCriteria: ["架构图已生成", "主执行链路已梳理", "模块边界已说明", "架构风险已识别"]',
            '',
            'DO NOT output architecture analysis directly.',
            'DO NOT add fields not in the schema.',
            'DO NOT use different spellings for routingMode (no camelCase, no hyphens).',
            'DO NOT omit required fields.',
            'DO NOT return empty strings for non-empty fields.'
          ].join('\n')
        : '',
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
          outputSchema,
          outputExample
        },
        null,
        2
      )
    ].filter(Boolean).join('\n');
  }

  private async writePromptFileIfConfigured(input: InvocationPlan, prompt: string) {
    if (process.env.CLAUDE_CODE_PROMPT_MODE !== 'file') {
      return undefined;
    }
    const promptFilePath = join(tmpdir(), `agent-cluster-claude-${input.invocationId}.prompt.txt`);
    await writeFile(promptFilePath, prompt, 'utf8');
    return promptFilePath;
  }

  private runBufferedCommand(
    command: string,
    args: string[],
    prompt: string,
    options: {
      cwd: string;
      timeout: number;
      signal?: AbortSignal;
      env: NodeJS.ProcessEnv;
      maxBuffer: number;
      diagnosticRef: string;
    }
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolveCommand, rejectCommand) => {
      const { diagnosticRef, ...execOptions } = options;
      const child = execFile(command, args, { ...execOptions, shell: false, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          const failure = Object.assign(error, { stdout, stderr });
          const sanitized = sanitizeClaudeProcessError(failure, diagnosticRef);
          Object.assign(sanitized, {
            stdout,
            stderr,
            exitCode: typeof error.code === 'number' ? error.code : undefined
          });
          rejectCommand(
            options.signal?.aborted || isChildProcessTimeoutError(failure)
              ? failure
              : sanitized
          );
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
    const testCommand = process.env.CLAUDE_CODE_TEST_COMMAND?.trim();
    if (!testCommand) {
      return undefined;
    }
    const startedAt = nowIso();
    try {
      const { stdout, stderr } = await execFileAsync(testCommand, {
        cwd: rootPath,
        shell: true,
        signal,
        timeout: Number(process.env.CLAUDE_CODE_TEST_TIMEOUT_MS ?? 120_000),
        maxBuffer: Number(process.env.CLAUDE_CODE_MAX_BUFFER ?? 8 * 1024 * 1024)
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
        model: 'claude_code'
      },
      error: {
        code: 'CAPABILITY_BLOCKED',
        message,
        retryable: false
      }
    };
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

  private createStreamingRunnerWithBrief(input: InvocationPlan, signal?: AbortSignal): ClaudeStreamingRunHandle {
    const briefLease = this.workdirBrief?.prepare(input, 'claude_code');
    try {
      const runner = this.createStreamingRunner(input, signal, briefLease?.taskSidecarPath);
      return { ...runner, result: runner.result.finally(() => briefLease?.restore()) };
    } catch (error) {
      briefLease?.restore();
      throw error;
    }
  }

  private createStreamingRunner(
    input: InvocationPlan,
    signal?: AbortSignal,
    taskSidecarPath?: string
  ): ClaudeStreamingRunHandle {
    const command = resolveClaudeCommand();
    const argsJson = process.env.CLAUDE_CODE_ARGS_JSON?.trim();
    const configuredArgs = argsJson ? (JSON.parse(argsJson) as string[]) : undefined;
    if (configuredArgs && !configuredArgs.every((item) => typeof item === 'string')) {
      throw new Error('CLAUDE_CODE_ARGS_JSON must be a JSON string array.');
    }
    const authority = resolveCliToolAuthority(input);
    const pendingTools = new Map<string, { toolName: string; argumentsValue: unknown; startedAt: string }>();
    const auditWrites = new Set<Promise<boolean>>();
    const scheduleAudit = (write: Promise<boolean> | undefined) => {
      if (!write) return;
      let tracked: Promise<boolean>;
      tracked = write.catch(() => false).finally(() => auditWrites.delete(tracked));
      auditWrites.add(tracked);
    };
    const args = configuredArgs
      ? [...configuredArgs]
      : [
          '-p',
          '--output-format',
          'stream-json',
          '--input-format',
          'stream-json',
          '--verbose',
          '--strict-mcp-config'
        ];
    args.push('--permission-mode', authority.claudePermissionMode, '--allowedTools', authority.claudeAllowedTools);
    const streamingOptions: ClaudeStreamingRunnerOptions = {
      ...buildClaudeStreamingOptions({
        command: command.executable,
        args,
        baseEnv: this.runtimeEnv(input),
        firstFrameTimeoutMs: positiveRuntimeTimeoutMs('CLAUDE_CODE_FIRST_FRAME_TIMEOUT_MS', 30_000),
        idleTimeoutMs: positiveRuntimeTimeoutMs('CLAUDE_CODE_IDLE_TIMEOUT_MS', 600_000),
        absoluteTimeoutMs: positiveRuntimeTimeoutMs('CLAUDE_CODE_ABSOLUTE_TIMEOUT_MS', 30 * 60_000),
        workDir: this.workspaceBindings.resolveServerRoot(input),
        resumeCliSessionId: input.resume?.cliSessionId
      }),
      prompt: this.prompt(input, taskSidecarPath),
      // Claude `-p --input-format stream-json` treats stdin EOF as the end of
      // a single-turn request. Keep it open only for explicit bidirectional
      // control_request integrations.
      closeStdinAfterPrompt: process.env.CLAUDE_CODE_STREAM_KEEP_STDIN_OPEN !== 'true'
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
    const runner = startClaudeStreaming(input, streamingOptions, signal);
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
    await this.streamingHandles.get(invocationId)?.cancel();
  }

  private failedResult(input: InvocationPlan, error: unknown): AgentRunResult {
    const message = error instanceof Error ? error.message : String(error);
    const runtimeError = extractRuntimeError(error) ?? { code: 'MODEL_ERROR' as const, message, retryable: true };
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
          metadata: { code: runtimeError.code, message: runtimeError.message },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      systemEvidence: emptyRuntimeSystemEvidence(input.invocationId),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'claude_code' },
      error: runtimeError
    };
  }
}

function runtimeEvents(invocationId: UUID, handle: ClaudeStreamingRunHandle): AsyncIterable<AgentRuntimeEvent> {
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
  return { events: emptyEvents(), result: Promise.resolve(result), cancel: async () => {} };
}

function promiseHandle(result: Promise<AgentRunResult>): AgentRuntimeRunHandle {
  return { events: emptyEvents(), result, cancel: async () => {} };
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
