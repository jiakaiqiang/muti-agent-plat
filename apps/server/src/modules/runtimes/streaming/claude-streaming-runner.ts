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
import { ControlRequestHandler, encodeControlResponse } from './claude-control-request.js';
import { ClaudeStreamJsonParser } from './claude-stream-json-parser.js';
import { framesToOutput, MapperError } from './frame-to-output.mapper.js';
import { LivenessWatchdog, type WatchdogTimeoutObservation } from './liveness-watchdog.js';
import { RunChannel } from './run-channel.js';
import { RuntimeStreamMetricsCollector } from './runtime-stream-metrics.js';
import type { RuntimeStreamFrame } from './runtime-stream-frame.js';
import { buildWatchdogTimeoutDetails } from './watchdog-timeout-details.js';
import { validateRuntimeOutput } from '../runtime-output-schema.js';

/**
 * `ClaudeStreamingRunner` 封装 claude CLI 的 stream-json 流式生命周期:
 *   spawn --output-format stream-json → 行 JSON 解析 → 帧解析 → 通道推送 → mapper 输出。
 * 单回合 CLI 可以在初始 prompt 写入后关闭 stdin，以触发 CLI 输出 result 并退出；
 * 需要 control_request 双向协商的调用可显式保持 stdin 打开。
 *
 * 详见 docs/design/multica-refactor-development-design-v1.md §3.3、§3.7。
 */

export interface ClaudeStreamingRunnerOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  channelCapacity?: number;
  firstFrameTimeoutMs?: number;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  prompt?: string;
  /** Close stdin after the initial prompt for a one-shot Claude CLI turn. */
  closeStdinAfterPrompt?: boolean;
  spawnFn?: typeof spawn;
}

export interface ClaudeStreamingRunHandle {
  channel: RunChannel;
  result: Promise<AgentRunResult>;
  cancel: () => Promise<void>;
}

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_CHANNEL_CAPACITY = 512;
const STDERR_TAIL_BYTES = 8 * 1024;

export function startClaudeStreaming(
  input: AgentRunInput,
  opts: ClaudeStreamingRunnerOptions,
  signal?: AbortSignal
): ClaudeStreamingRunHandle {
  const channel = new RunChannel({ capacity: opts.channelCapacity ?? DEFAULT_CHANNEL_CAPACITY });
  const startedAt = nowIso();
  const spawnFn = opts.spawnFn ?? spawn;
  const streamMetrics = new RuntimeStreamMetricsCollector();

  const child: ChildProcess = spawnFn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const parser = new ClaudeStreamJsonParser();
  const controlHandler = new ControlRequestHandler();
  const collected: RuntimeStreamFrame[] = [];
  const stderrTail: Buffer[] = [];
  let stderrTailBytes = 0;
  let watchdogTimeout: WatchdogTimeoutObservation | undefined;
  let cancelledByUser = false;
  let settled = false;
  let stdinBuf = '';

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

  function writeStdin(line: string) {
    try {
      child.stdin?.write(line);
    } catch {
      // stdin 写失败由 exit 兜住
    }
  }

  stdout?.on('data', (chunk: Buffer) => {
    stdinBuf += chunk.toString('utf8');
    let idx = stdinBuf.indexOf('\n');
    while (idx !== -1) {
      const line = stdinBuf.slice(0, idx);
      stdinBuf = stdinBuf.slice(idx + 1);
      handleLine(line);
      idx = stdinBuf.indexOf('\n');
    }
  });

  function handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    // control_request 单独处理:不经 parser
    try {
      const obj = JSON.parse(trimmed);
      if (obj && obj.type === 'control_request') {
        const response = controlHandler.handle(obj);
        writeStdin(encodeControlResponse(obj.request_id, response));
        return;
      }
    } catch {
      // 不是 JSON → 交给 parser 处理(它也会跳过)
    }
    const frames = parser.feedLine(trimmed);
    for (const f of frames) pushFrame(f);
  }

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

  const cancel = async () => {
    cancelledByUser = true;
    terminateChild();
  };

  if (signal) {
    if (signal.aborted) {
      void cancel();
    } else {
      signal.addEventListener('abort', () => void cancel(), { once: true });
    }
  }

  // 起个 prompt 请求
  writeStdin(
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: opts.prompt ?? (input.contextPack.sessionGoal || 'run') }]
      }
    }) + '\n'
  );
  if (opts.closeStdinAfterPrompt) {
    child.stdin?.end();
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

    child.on('exit', (code, sig) => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      channel.close();

      if (cancelledByUser) {
        resolve(makeCancelledResult(input, startedAt));
        return;
      }
      if (watchdogTimeout) {
        resolve(makeTimeoutResult(input, startedAt, watchdogTimeout, stderrTailToString(stderrTail)));
        return;
      }
      const hasResultFrame = collected.some((frame) => frame.kind === 'result');
      if (!hasResultFrame) {
        resolve(
          makeFailedResult(
            input,
            startedAt,
            `Claude Code exited before a result frame (exit=${String(sig ?? code)}).`,
            'MODEL_ERROR',
            stderrTailToString(stderrTail)
          )
        );
        return;
      }
      const resultFrame = collected.find((frame) => frame.kind === 'result');
      if (resultFrame?.kind === 'result' && resultFrame.turnStatus === 'failed') {
        resolve(
          makeFailedResult(
            input,
            startedAt,
            resultFrame.errorMessage ?? 'Claude Code result reported an error.',
            'MODEL_ERROR',
            stderrTailToString(stderrTail)
          )
        );
        return;
      }

      try {
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
  const resultFrame = frames.find((f) => f.kind === 'result');
  if (!resultFrame || resultFrame.kind !== 'result') {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'claude_code' };
  }
  const u = resultFrame.usage;
  const input = u?.inputTokens ?? 0;
  const output = u?.outputTokens ?? 0;
  return { inputTokens: input, outputTokens: output, totalTokens: input + output, model: 'claude_code' };
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
      content: `${input.agent.name} Claude streaming started ${input.phase}.`,
      createdAt: startedAt
    },
    {
      runId: input.runId,
      type: 'runtime_completed',
      content: `${input.agent.name} Claude streaming completed ${input.phase}.`,
      metadata: { exit: exitDetail ?? undefined },
      createdAt: nowIso()
    }
  ];
  return {
    runId: input.runId,
    runtimeType: 'claude_code',
    status: 'completed',
    output,
    events,
    artifacts: output.kind === 'task_execution_result' ? output.changedArtifacts : [],
    usage,
    runtimeSession
  };
}

function makeCancelledResult(input: AgentRunInput, startedAt: string): AgentRunResult {
  return {
    runId: input.runId,
    runtimeType: 'claude_code',
    status: 'cancelled',
    output: {
      kind: 'agent_message',
      messageKind: 'progress',
      content: `${input.agent.name} Claude streaming cancelled.`
    },
    events: [
      {
        runId: input.runId,
        type: 'runtime_started',
        content: `${input.agent.name} Claude streaming started ${input.phase}.`,
        createdAt: startedAt
      },
      {
        runId: input.runId,
        type: 'runtime_failed',
        content: `${input.agent.name} Claude streaming cancelled.`,
        createdAt: nowIso()
      }
    ],
    artifacts: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'claude_code' },
    error: { code: 'RUNTIME_CANCELLED', message: 'Cancelled by user.', retryable: false }
  };
}

function makeTimeoutResult(
  input: AgentRunInput,
  startedAt: string,
  observation: WatchdogTimeoutObservation,
  stderrTail: string | undefined
): AgentRunResult {
  const details = buildWatchdogTimeoutDetails({
    runtimeType: 'claude_code',
    input,
    observation,
    stderrTail
  });
  const error: RuntimeError = {
    code: 'RUNTIME_TIMEOUT',
    message: `Claude streaming watchdog timeout: ${observation.reason}`,
    retryable: true,
    details
  };
  return {
    runId: input.runId,
    runtimeType: 'claude_code',
    status: 'failed',
    output: {
      kind: 'agent_message',
      messageKind: 'risk',
      content: `${input.agent.name} Claude streaming timed out (${observation.reason}).`
    },
    events: [
      {
        runId: input.runId,
        type: 'runtime_started',
        content: `${input.agent.name} Claude streaming started ${input.phase}.`,
        createdAt: startedAt
      },
      {
        runId: input.runId,
        type: 'runtime_failed',
        content: `${input.agent.name} Claude streaming timed out (${observation.reason}).`,
        metadata: details,
        createdAt: nowIso()
      }
    ],
    artifacts: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'claude_code' },
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
    runtimeType: 'claude_code',
    status: 'failed',
    output: {
      kind: 'agent_message',
      messageKind: 'risk',
      content: `${input.agent.name} Claude streaming failed: ${message}`
    },
    events: [
      {
        runId: input.runId,
        type: 'runtime_started',
        content: `${input.agent.name} Claude streaming started ${input.phase}.`,
        createdAt: startedAt
      },
      {
        runId: input.runId,
        type: 'runtime_failed',
        content: `${input.agent.name} Claude streaming failed.`,
        metadata: { message },
        createdAt: nowIso()
      }
    ],
    artifacts: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'claude_code' },
    error
  };
}
