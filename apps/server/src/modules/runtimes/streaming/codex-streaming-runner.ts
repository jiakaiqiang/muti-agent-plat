import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeEvent,
  ExpectedRuntimeOutput,
  RuntimeError,
  RuntimeOutput,
  RuntimeUsage
} from '@agent-cluster/shared';
import { nowIso } from '../../../common/time.js';
import { JsonRpcDecoder, encodeJsonRpc, type JsonRpcMessage } from './codex-appserver-codec.js';
import { parseCodexNotification } from './codex-frame-parser.js';
import { framesToOutput, MapperError } from './frame-to-output.mapper.js';
import { LivenessWatchdog, type WatchdogTimeoutObservation } from './liveness-watchdog.js';
import { RunChannel } from './run-channel.js';
import { RuntimeStreamMetricsCollector } from './runtime-stream-metrics.js';
import type { RuntimeStreamFrame } from './runtime-stream-frame.js';
import { buildWatchdogTimeoutDetails } from './watchdog-timeout-details.js';
import { validateRuntimeOutput } from '../runtime-output-schema.js';

/**
 * `CodexStreamingRunner` 封装一次流式运行的完整生命周期:
 *   spawn app-server → JSON-RPC codec 解码 → 帧解析 → 通道推送 → mapper 输出。
 * 与 adapter 分离便于单测替换 spawn。
 *
 * 详见 docs/design/multica-refactor-development-design-v1.md §3.4、§3.7。
 */

export interface StreamingRunnerOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  channelCapacity?: number;
  firstFrameTimeoutMs?: number;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  prompt?: string;
  outputSchema?: Record<string, unknown>;
  resumeCliSessionId?: string;
  model?: string;
  /** 为单测注入 spawn 依赖。生产不传即用 node:child_process.spawn。 */
  spawnFn?: typeof spawn;
}

export interface StreamingRunHandle {
  channel: RunChannel;
  result: Promise<AgentRunResult>;
  cancel: () => Promise<void>;
}

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_CHANNEL_CAPACITY = 512;
const STDERR_TAIL_BYTES = 8 * 1024;

export function startCodexStreaming(
  input: AgentRunInput,
  opts: StreamingRunnerOptions,
  signal?: AbortSignal
): StreamingRunHandle {
  const channel = new RunChannel({ capacity: opts.channelCapacity ?? DEFAULT_CHANNEL_CAPACITY });
  const startedAt = nowIso();
  const spawnFn = opts.spawnFn ?? spawn;
  const streamMetrics = new RuntimeStreamMetricsCollector();

  const child: ChildProcess = spawnFn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const decoder = new JsonRpcDecoder();
  const collected: RuntimeStreamFrame[] = [];
  const stderrTail: Buffer[] = [];
  let stderrTailBytes = 0;
  let watchdogTimeout: WatchdogTimeoutObservation | undefined;
  let cancelledByUser = false;
  let settled = false;
  let completedByProtocol = false;
  let protocolError: string | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let cancelKillTimer: NodeJS.Timeout | undefined;

  const requestMethods = new Map<number, string>();
  const initializeRequestId = 1;
  const threadRequestId = 2;
  const turnRequestId = 3;
  const interruptRequestId = 4;

  const watchdog = new LivenessWatchdog({
    firstFrameTimeoutMs: opts.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS,
    idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    absoluteTimeoutMs: opts.absoluteTimeoutMs,
    onTimeout: (_reason, observation) => {
      watchdogTimeout = observation;
      terminateChild();
    }
  });

  const stdout = (child as ChildProcessWithoutNullStreams).stdout;
  const stderr = (child as ChildProcessWithoutNullStreams).stderr;

  function pushFrame(frame: RuntimeStreamFrame) {
    streamMetrics.notifyFrame();
    watchdog.notifyFrame();
    collected.push(frame);
    channel.push(frame);
  }

  stdout?.on('data', (chunk: Buffer) => {
    const msgs = decoder.feed(chunk);
    for (const msg of msgs) {
      handleProtocolMessage(msg);
    }
  });

  stderr?.on('data', (chunk: Buffer) => {
    stderrTail.push(chunk);
    stderrTailBytes += chunk.length;
    while (stderrTailBytes > STDERR_TAIL_BYTES && stderrTail.length > 1) {
      stderrTailBytes -= stderrTail[0].length;
      stderrTail.shift();
    }
  });

  function terminateChild() {
    if (!child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  function writeMessage(message: Parameters<typeof encodeJsonRpc>[0]) {
    child.stdin?.write(encodeJsonRpc(message));
  }

  function sendRequest(id: number, method: string, params?: unknown) {
    requestMethods.set(id, method);
    writeMessage({ id, method, ...(params === undefined ? {} : { params }) });
  }

  function failProtocol(message: string) {
    protocolError = message;
    terminateChild();
  }

  function handleProtocolMessage(msg: JsonRpcMessage) {
    if (msg.id !== undefined && msg.id !== null) {
      const numericId = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const method = requestMethods.get(numericId) ?? 'unknown request';
      if (msg.error) {
        failProtocol(`Codex app-server ${method} failed (${msg.error.code}): ${msg.error.message}`);
        return;
      }
      if (numericId === initializeRequestId) {
        writeMessage({ method: 'initialized' });
        if (opts.resumeCliSessionId) {
          sendRequest(threadRequestId, 'thread/resume', {
            threadId: opts.resumeCliSessionId,
            cwd: opts.cwd,
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
            excludeTurns: true
          });
        } else {
          sendRequest(threadRequestId, 'thread/start', {
            cwd: opts.cwd,
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
            model: opts.model
          });
        }
        return;
      }
      if (numericId === threadRequestId) {
        const result = asRecord(msg.result);
        const thread = asRecord(result?.thread);
        threadId = asString(thread?.id);
        if (!threadId) {
          failProtocol('Codex app-server thread response did not contain thread.id.');
          return;
        }
        if (opts.resumeCliSessionId && threadId !== opts.resumeCliSessionId) {
          failProtocol(
            `Codex app-server resumed unexpected thread ${threadId}; expected ${opts.resumeCliSessionId}.`
          );
          return;
        }
        sendRequest(turnRequestId, 'turn/start', {
          threadId,
          input: [
            {
              type: 'text',
              text: opts.prompt ?? defaultPrompt(input),
              text_elements: []
            }
          ],
          outputSchema: opts.outputSchema ?? input.expectedOutput.jsonSchema
        });
        return;
      }
      if (numericId === turnRequestId) {
        const result = asRecord(msg.result);
        const turn = asRecord(result?.turn);
        turnId = asString(turn?.id);
        if (!turnId) failProtocol('Codex app-server turn/start response did not contain turn.id.');
      }
      return;
    }

    if (!msg.method) return;
    const frame = parseCodexNotification(msg);
    pushFrame(frame);
    if (frame.kind === 'result') {
      completedByProtocol = true;
      threadId = frame.cliSessionId ?? threadId;
      turnId = frame.turnId ?? turnId;
      terminateChild();
    }
  }

  const cancel = async () => {
    cancelledByUser = true;
    if (threadId && turnId) {
      try {
        sendRequest(interruptRequestId, 'turn/interrupt', { threadId, turnId });
        cancelKillTimer = setTimeout(terminateChild, 500);
        return;
      } catch {
        // fall through to process termination
      }
    }
    terminateChild();
  };

  if (signal) {
    if (signal.aborted) {
      void cancel();
    } else {
      signal.addEventListener('abort', () => void cancel(), { once: true });
    }
  }

  // 官方 app-server v2 生命周期从 initialize 开始。
  try {
    sendRequest(initializeRequestId, 'initialize', {
      clientInfo: {
        name: 'agent-cluster',
        title: 'Agent Cluster Runtime',
        version: '0.1.0'
      },
      capabilities: null
    });
  } catch {
    // 若 stdin 立即出错,exit 会兜住结果
  }

  watchdog.start();

  const result = new Promise<AgentRunResult>((resolve) => {
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      channel.close();
      resolve(makeFailedResult(input, startedAt, err.message, 'MODEL_ERROR', stderrTailToString(stderrTail)));
    });

    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      if (cancelKillTimer) clearTimeout(cancelKillTimer);
      channel.close();

      if (cancelledByUser) {
        resolve(makeCancelledResult(input, startedAt));
        return;
      }
      if (watchdogTimeout) {
        resolve(makeTimeoutResult(input, startedAt, watchdogTimeout, stderrTailToString(stderrTail)));
        return;
      }

      if (protocolError) {
        resolve(makeFailedResult(input, startedAt, protocolError, 'MODEL_ERROR', stderrTailToString(stderrTail)));
        return;
      }

      if (!completedByProtocol) {
        resolve(
          makeFailedResult(
            input,
            startedAt,
            `Codex app-server exited before turn/completed (exit=${String(sig ?? code)}).`,
            'MODEL_ERROR',
            stderrTailToString(stderrTail)
          )
        );
        return;
      }

      // 正常退出:构造 output
      try {
        const resultFrame = lastFrameOfKind(collected, 'result');
        if (resultFrame?.kind === 'result' && resultFrame.turnStatus === 'failed') {
          resolve(
            makeFailedResult(
              input,
              startedAt,
              resultFrame.errorMessage ?? 'Codex turn failed.',
              'MODEL_ERROR',
              stderrTailToString(stderrTail)
            )
          );
          return;
        }
        const kind: ExpectedRuntimeOutput['kind'] = input.expectedOutput.kind;
        const output = framesToOutput(kind, collected);
        const validation = validateRuntimeOutput(output, kind);
        if (!validation.valid) {
          throw new MapperError(`runtime output validation failed: ${validation.errors.join('; ')}`, kind);
        }
        const usage = usageFromFrames(collected);
        resolve(makeCompletedResult(input, startedAt, output, usage, sig ?? code, sessionFromFrames(input, collected, opts.cwd)));
      } catch (err) {
        const message = err instanceof MapperError ? err.message : String(err);
        resolve(
          makeFailedResult(
            input,
            startedAt,
            message,
            err instanceof MapperError ? 'OUTPUT_SCHEMA_INVALID' : 'MODEL_ERROR',
            stderrTailToString(stderrTail)
          )
        );
      }
    });
  }).then((outcome) => ({ ...outcome, streamMetrics: streamMetrics.complete() }));

  return { channel, result, cancel };
}

function stderrTailToString(chunks: Buffer[]): string | undefined {
  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks).toString('utf8').slice(-STDERR_TAIL_BYTES);
}

function usageFromFrames(frames: RuntimeStreamFrame[]): RuntimeUsage {
  const usageFrame = lastFrameOfKind(frames, 'usage');
  const resultFrame = frames.find((f) => f.kind === 'result');
  const u = usageFrame?.kind === 'usage' ? usageFrame.usage : resultFrame?.kind === 'result' ? resultFrame.usage : undefined;
  if (!u) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'codex' };
  }
  const input = u?.inputTokens ?? 0;
  const output = u?.outputTokens ?? 0;
  return { inputTokens: input, outputTokens: output, totalTokens: input + output, model: 'codex' };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function defaultPrompt(input: AgentRunInput): string {
  return [
    'You are running as an Agent Cluster Codex runtime.',
    `Required output kind: ${input.expectedOutput.kind}.`,
    'Return exactly one JSON object matching the supplied output schema.',
    JSON.stringify({
      phase: input.phase,
      agent: input.agent,
      contextPack: input.contextPack,
      expectedOutput: input.expectedOutput
    })
  ].join('\n');
}

function lastFrameOfKind<K extends RuntimeStreamFrame['kind']>(
  frames: RuntimeStreamFrame[],
  kind: K
): Extract<RuntimeStreamFrame, { kind: K }> | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame.kind === kind) {
      return frame as Extract<RuntimeStreamFrame, { kind: K }>;
    }
  }
  return undefined;
}

function sessionFromFrames(input: AgentRunInput, frames: RuntimeStreamFrame[], cwd?: string) {
  const resultFrame = frames.find((frame) => frame.kind === 'result');
  const cliSessionId = resultFrame?.kind === 'result' ? resultFrame.cliSessionId : undefined;
  const workDir =
    cwd ??
    (input.contextPack.workingDirectory?.kind === 'server_local'
      ? input.contextPack.workingDirectory.path
      : undefined);
  return cliSessionId || workDir ? { cliSessionId, workDir } : undefined;
}

function makeCompletedResult(
  input: AgentRunInput,
  startedAt: string,
  output: RuntimeOutput,
  usage: RuntimeUsage,
  exitDetail: number | string | null,
  runtimeSession?: AgentRunResult['runtimeSession']
): AgentRunResult {
  const events: AgentRuntimeEvent[] = [
    {
      runId: input.runId,
      type: 'runtime_started',
      content: `${input.agent.name} Codex streaming started ${input.phase}.`,
      createdAt: startedAt
    },
    {
      runId: input.runId,
      type: 'runtime_completed',
      content: `${input.agent.name} Codex streaming completed ${input.phase}.`,
      metadata: { exit: exitDetail ?? undefined },
      createdAt: nowIso()
    }
  ];
  return {
    runId: input.runId,
    runtimeType: 'codex',
    status: 'completed',
    output,
    events,
    artifacts: output.kind === 'task_execution_result' ? output.changedArtifacts : [],
    usage,
    runtimeSession
  };
}

function makeCancelledResult(input: AgentRunInput, startedAt: string): AgentRunResult {
  const error: RuntimeError = {
    code: 'RUNTIME_CANCELLED',
    message: 'Codex streaming cancelled by user.',
    retryable: false
  };
  return {
    runId: input.runId,
    runtimeType: 'codex',
    status: 'cancelled',
    output: {
      kind: 'agent_message',
      messageKind: 'progress',
      content: `${input.agent.name} Codex streaming cancelled.`
    },
    events: [
      {
        runId: input.runId,
        type: 'runtime_started',
        content: `${input.agent.name} Codex streaming started ${input.phase}.`,
        createdAt: startedAt
      },
      {
        runId: input.runId,
        type: 'runtime_failed',
        content: `${input.agent.name} Codex streaming cancelled.`,
        createdAt: nowIso()
      }
    ],
    artifacts: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'codex' },
    error
  };
}

function makeTimeoutResult(
  input: AgentRunInput,
  startedAt: string,
  observation: WatchdogTimeoutObservation,
  stderrTail: string | undefined
): AgentRunResult {
  const details = buildWatchdogTimeoutDetails({
    runtimeType: 'codex',
    input,
    observation,
    stderrTail
  });
  const error: RuntimeError = {
    code: 'RUNTIME_TIMEOUT',
    message: `Codex streaming watchdog timeout: ${observation.reason}`,
    retryable: true,
    details
  };
  return {
    runId: input.runId,
    runtimeType: 'codex',
    status: 'failed',
    output: {
      kind: 'agent_message',
      messageKind: 'risk',
      content: `${input.agent.name} Codex streaming timed out (${observation.reason}).`
    },
    events: [
      {
        runId: input.runId,
        type: 'runtime_started',
        content: `${input.agent.name} Codex streaming started ${input.phase}.`,
        createdAt: startedAt
      },
      {
        runId: input.runId,
        type: 'runtime_failed',
        content: `${input.agent.name} Codex streaming timed out (${observation.reason}).`,
        metadata: details,
        createdAt: nowIso()
      }
    ],
    artifacts: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'codex' },
    error
  };
}

function makeFailedResult(
  input: AgentRunInput,
  startedAt: string,
  message: string,
  code: RuntimeError['code'],
  stderrTail: string | undefined
): AgentRunResult {
  const error: RuntimeError = {
    code,
    message,
    retryable: code !== 'OUTPUT_SCHEMA_INVALID',
    details: stderrTail ? { stderrTail } : undefined
  };
  return {
    runId: input.runId,
    runtimeType: 'codex',
    status: 'failed',
    output: {
      kind: 'agent_message',
      messageKind: 'risk',
      content: `${input.agent.name} Codex streaming failed: ${message}`
    },
    events: [
      {
        runId: input.runId,
        type: 'runtime_started',
        content: `${input.agent.name} Codex streaming started ${input.phase}.`,
        createdAt: startedAt
      },
      {
        runId: input.runId,
        type: 'runtime_failed',
        content: `${input.agent.name} Codex streaming failed.`,
        metadata: { message },
        createdAt: nowIso()
      }
    ],
    artifacts: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'codex' },
    error
  };
}
