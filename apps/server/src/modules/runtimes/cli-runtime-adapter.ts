import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  AgentMessageOutput,
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeEvent,
  ProposedFileWrite,
  RuntimeArtifactOutput,
  RuntimeError,
  RuntimeOutput,
  RuntimeType,
  RuntimeUsage
} from '@agent-cluster/shared';
import { resolveWorkspaceRoot, runtimeTimeoutMs } from '../../common/runtime-config.js';
import { nowIso } from '../../common/time.js';
import type { ToolExecutionRequest, ToolExecutorService } from './tool-executor.service.js';

export type CliRuntimeOptions = {
  runtimeType: Extract<RuntimeType, 'codex' | 'claude_code'>;
  enabledEnvVar: string;
  enabled: boolean;
  command: string;
  args: string[];
};

type CliProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
};

type ParsedCliResponse = {
  output: RuntimeOutput;
  toolRequests: ToolExecutionRequest[];
  usage?: Partial<RuntimeUsage>;
};

/**
 * Shared real-first adapter for agentic coding CLIs (codex / claude code).
 *
 * Protocol: the CLI receives a JSON AgentRunInput on stdin and must print a JSON
 * response on stdout — either a bare RuntimeOutput, or `{ output, toolRequests, usage }`.
 * Any declared toolRequests are executed through the controlled ToolExecutor (capability
 * policy + workspace sandbox), never by the CLI directly. Disabled runtimes, missing
 * CLIs, timeouts, cancellation, and invalid output all return a visible failed result
 * instead of throwing.
 */
export async function runCliRuntime(
  options: CliRuntimeOptions,
  input: AgentRunInput,
  toolExecutor: ToolExecutorService,
  signal?: AbortSignal
): Promise<AgentRunResult> {
  const startedAt = nowIso();
  const events: AgentRuntimeEvent[] = [
    {
      runId: input.runId,
      type: 'runtime_started',
      content: `${input.agent.name} ${options.runtimeType} started ${input.phase}`,
      createdAt: startedAt
    }
  ];

  if (!options.enabled) {
    return failedResult(options, input, events, {
      code: 'CAPABILITY_BLOCKED',
      message: `${options.runtimeType} runtime is disabled. Set ${options.enabledEnvVar}=true to enable real execution.`,
      retryable: false
    });
  }

  if (signal?.aborted) {
    return failedResult(options, input, events, {
      code: 'RUNTIME_CANCELLED',
      message: `${options.runtimeType} runtime was cancelled before start.`,
      retryable: false
    });
  }

  const payload = JSON.stringify({
    runId: input.runId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    phase: input.phase,
    agent: input.agent,
    expectedOutput: input.expectedOutput,
    contextPack: input.contextPack,
    budget: input.budget,
    options: input.options
  });

  const proc = await runCliProcess(options.command, options.args, payload, signal);

  if (proc.aborted) {
    return failedResult(options, input, events, {
      code: 'RUNTIME_CANCELLED',
      message: `${options.runtimeType} runtime was cancelled.`,
      retryable: false
    });
  }
  if (proc.timedOut) {
    return failedResult(options, input, events, {
      code: 'RUNTIME_TIMEOUT',
      message: `${options.runtimeType} runtime timed out after ${runtimeTimeoutMs()}ms.`,
      retryable: true
    });
  }
  if (proc.spawnError) {
    return failedResult(options, input, events, {
      code: 'MODEL_ERROR',
      message: `${options.runtimeType} CLI "${options.command}" could not start: ${proc.spawnError}`,
      retryable: false
    });
  }
  if (proc.code !== 0) {
    return failedResult(options, input, events, {
      code: 'MODEL_ERROR',
      message: `${options.runtimeType} CLI exited with code ${proc.code}: ${proc.stderr.trim() || 'no stderr'}`,
      retryable: false
    });
  }

  const parsed = parseCliResponse(proc.stdout, input.expectedOutput.kind);
  if ('error' in parsed) {
    return failedResult(options, input, events, parsed.error);
  }

  const { output, toolRequests, usage } = parsed;
  const toolArtifacts: RuntimeArtifactOutput[] = [];
  const proposedWrites: ProposedFileWrite[] = [];
  for (const request of toolRequests) {
    // file_write 仅作为待确认提案收集(读取现有内容做 diff),不在此落盘。
    if (request.tool === 'file_write') {
      proposedWrites.push(await toProposedWrite(request, input));
      continue;
    }
    const toolResult = await toolExecutor.execute(request, {
      runId: input.runId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      agentId: input.agent.id,
      agentKey: input.agent.key,
      workspaceRoot: input.workspaceDir,
      signal
    });
    events.push({
      runId: input.runId,
      type: toolResult.status === 'completed' ? 'tool_completed' : 'tool_called',
      content: `${request.tool}: ${toolResult.summary}`,
      metadata: { tool: request.tool, status: toolResult.status },
      createdAt: nowIso()
    });
    if (toolResult.artifact) {
      toolArtifacts.push(toolResult.artifact);
    }
  }

  if (output.kind === 'task_execution_result' && toolArtifacts.length) {
    output.changedArtifacts = [...output.changedArtifacts, ...toolArtifacts];
  }

  events.push({
    runId: input.runId,
    type: 'runtime_completed',
    content: `${input.agent.name} ${options.runtimeType} completed ${input.phase}`,
    createdAt: nowIso()
  });

  return {
    runId: input.runId,
    runtimeType: options.runtimeType,
    status: 'completed',
    output,
    events,
    artifacts: toolArtifacts,
    proposedWrites,
    usage: toUsage(usage, options.runtimeType)
  };
}

/** Turns a file_write request into a confirmation proposal, reading existing content for diff preview. */
async function toProposedWrite(
  request: Extract<ToolExecutionRequest, { tool: 'file_write' }>,
  input: AgentRunInput
): Promise<ProposedFileWrite> {
  const root = resolveWorkspaceRoot(input.workspaceDir);
  let previousContent: string | undefined;
  try {
    previousContent = await readFile(resolve(root, request.path), 'utf8');
  } catch {
    previousContent = undefined;
  }
  return {
    path: request.path,
    content: request.content,
    summary: request.summary,
    previousContent
  };
}

function parseCliResponse(stdout: string, expectedKind: string): ParsedCliResponse | { error: RuntimeError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return {
      error: {
        code: 'OUTPUT_SCHEMA_INVALID',
        message: `CLI did not return valid JSON: ${stdout.slice(0, 200)}`,
        retryable: false
      }
    };
  }

  const envelope = parsed as { output?: RuntimeOutput; toolRequests?: ToolExecutionRequest[]; usage?: Partial<RuntimeUsage> };
  const output = (envelope && typeof envelope === 'object' && envelope.output ? envelope.output : (parsed as RuntimeOutput)) ?? undefined;
  const toolRequests = Array.isArray(envelope?.toolRequests) ? envelope.toolRequests : [];

  if (!output || typeof output !== 'object' || output.kind !== expectedKind) {
    return {
      error: {
        code: 'OUTPUT_SCHEMA_INVALID',
        message: `Expected runtime output kind ${expectedKind}, got ${String((output as { kind?: string })?.kind)}`,
        retryable: false
      }
    };
  }

  return { output, toolRequests, usage: envelope?.usage };
}

function runCliProcess(command: string, args: string[], stdin: string, signal?: AbortSignal): Promise<CliProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, runtimeTimeoutMs());
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (result: Partial<CliProcessResult> & { code: number }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        code: result.code,
        stdout,
        stderr,
        timedOut,
        aborted: signal?.aborted ?? false,
        spawnError: result.spawnError
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => settle({ code: -1, spawnError: error.message }));
    child.on('close', (code) => settle({ code: code ?? -1 }));

    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdin);
  });
}

function failedResult(
  options: CliRuntimeOptions,
  input: AgentRunInput,
  events: AgentRuntimeEvent[],
  error: RuntimeError
): AgentRunResult {
  return {
    runId: input.runId,
    runtimeType: options.runtimeType,
    status: error.code === 'RUNTIME_CANCELLED' ? 'cancelled' : 'failed',
    output: {
      kind: 'agent_message',
      messageKind: 'risk',
      content: `${options.runtimeType} runtime failed during ${input.phase}: ${error.message}`
    } satisfies AgentMessageOutput,
    events: [
      ...events,
      {
        runId: input.runId,
        type: 'runtime_failed',
        content: `${input.agent.name} ${options.runtimeType} failed ${input.phase}`,
        metadata: { code: error.code, message: error.message },
        createdAt: nowIso()
      }
    ],
    artifacts: [],
    usage: toUsage(undefined, options.runtimeType),
    error
  };
}

function toUsage(usage: Partial<RuntimeUsage> | undefined, runtimeType: string): RuntimeUsage {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
    cost: usage?.cost,
    model: usage?.model ?? runtimeType
  };
}
