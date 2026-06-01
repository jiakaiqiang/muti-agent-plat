import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { RuntimeArtifactOutput, RuntimeError } from '@agent-cluster/shared';
import {
  commandRuntimeAllowed,
  fileWriteRuntimeAllowed,
  resolveWorkspaceRoot,
  runtimeTimeoutMs
} from '../../common/runtime-config.js';
import { CapabilitiesService } from '../capabilities/capabilities.service.js';
import { CapabilityAuditService } from '../capabilities/capability-audit.service.js';
import { EventsService } from '../events/events.service.js';

export type ToolName = 'file_write' | 'command_run' | 'run_test' | 'git_diff';

export type ToolExecutionRequest =
  | { tool: 'file_write'; path: string; content: string; summary?: string }
  | { tool: 'command_run'; command: string; args?: string[] }
  | { tool: 'run_test'; command?: string; args?: string[] }
  | { tool: 'git_diff'; pathspec?: string[]; staged?: boolean };

export type ToolExecutionContext = {
  runId: string;
  sessionId?: string;
  taskId?: string;
  agentId?: string;
  agentKey?: string;
  /** 本会话选择的本地运行环境根目录(绝对路径,不是上传目录);为空时回退到全局 AGENT_WORKSPACE_ROOT / 进程目录。 */
  workspaceRoot?: string;
  /** 用户已就本次 file_write 显式确认。为 true 时以确认替代 ALLOW_FILE_WRITE_RUNTIME 环境闸门(能力策略 + 沙箱仍生效)。 */
  userConfirmed?: boolean;
  signal?: AbortSignal;
};

export type ToolExecutionResult = {
  tool: ToolName;
  status: 'completed' | 'blocked' | 'failed';
  summary: string;
  detail?: string;
  artifact?: RuntimeArtifactOutput;
  error?: RuntimeError;
};

type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

const MAX_OUTPUT_CHARS = 8_000;

const capabilityIdByTool: Record<ToolName, string> = {
  file_write: 'cap-file-write',
  command_run: 'cap-command-run',
  run_test: 'cap-run-test',
  git_diff: 'cap-git-diff'
};

/**
 * Executes high-risk runtime tools (file write / command run / test run / git diff)
 * behind a defense-in-depth policy: capability policy first, a dedicated env gate
 * second, and a workspace-root sandbox for any filesystem or process access.
 * It never throws for tool-level failures; it returns a structured, visible result.
 */
@Injectable()
export class ToolExecutorService {
  constructor(
    private readonly capabilities: CapabilitiesService,
    private readonly audit: CapabilityAuditService,
    private readonly events: EventsService
  ) {}

  async execute(request: ToolExecutionRequest, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const capabilityId = capabilityIdByTool[request.tool];
    const check = this.capabilities.checkInvocation(capabilityId, {
      sessionId: context.sessionId,
      agentId: context.agentId,
      reason: `tool:${request.tool}`
    });
    this.audit.recordCheck({ sessionId: context.sessionId, agentId: context.agentId, reason: `tool:${request.tool}` }, check);

    if (!check.allowed) {
      // 用户已就本次 file_write 显式确认时,确认本身即视为能力授权(沙箱仍生效);其余阻止照旧。
      const confirmedOverride =
        context.userConfirmed &&
        request.tool === 'file_write' &&
        check.code === 'CAPABILITY_REQUIRES_CONFIRMATION';
      if (!confirmedOverride) {
        const message = `${check.capability.name} 已被能力策略阻止（${check.code ?? 'CAPABILITY_BLOCKED'}）。`;
        return this.blocked(request.tool, message, { capabilityId, approvalKey: check.approvalKey });
      }
    }

    const gateReason = this.envGate(request.tool, context);
    if (gateReason) {
      this.emitToolEvent(context, 'tool_failed', request.tool, `${request.tool} blocked: ${gateReason}`, {
        capabilityId,
        reason: gateReason
      });
      return this.blocked(request.tool, gateReason, { capabilityId });
    }

    try {
      const result = await this.dispatch(request, context);
      this.emitToolEvent(context, result.status === 'failed' ? 'tool_failed' : 'tool_completed', request.tool, result.summary, {
        capabilityId,
        status: result.status,
        artifactTitle: result.artifact?.title
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitToolEvent(context, 'tool_failed', request.tool, `${request.tool} failed: ${message}`, {
        capabilityId,
        reason: message
      });
      return {
        tool: request.tool,
        status: 'failed',
        summary: message,
        error: { code: 'UNKNOWN_ERROR', message, retryable: false }
      };
    }
  }

  private envGate(tool: ToolName, context: ToolExecutionContext): string | undefined {
    if (tool === 'file_write' && !context.userConfirmed && !fileWriteRuntimeAllowed()) {
      return 'ALLOW_FILE_WRITE_RUNTIME 未开启，不允许真实写入文件。';
    }
    if ((tool === 'command_run' || tool === 'run_test') && !commandRuntimeAllowed()) {
      return 'ALLOW_COMMAND_RUNTIME 未开启，不允许真实执行命令。';
    }
    return undefined;
  }

  private dispatch(request: ToolExecutionRequest, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    switch (request.tool) {
      case 'file_write':
        return this.fileWrite(request, context);
      case 'command_run':
        return this.runCommandTool('command_run', request.command, request.args ?? [], context);
      case 'run_test': {
        const fallback = this.defaultTestCommand();
        return this.runCommandTool('run_test', request.command ?? fallback.command, request.args ?? fallback.args, context);
      }
      case 'git_diff':
        return this.gitDiff(request, context);
    }
  }

  private async fileWrite(
    request: Extract<ToolExecutionRequest, { tool: 'file_write' }>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const root = resolveWorkspaceRoot(context.workspaceRoot);
    const absolutePath = this.resolveWorkspacePath(request.path, root);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, request.content, 'utf8');
    const relativePath = relative(root, absolutePath);
    const bytes = Buffer.byteLength(request.content, 'utf8');
    return {
      tool: 'file_write',
      status: 'completed',
      summary: `已写入 ${bytes} 字节到 ${relativePath}`,
      artifact: {
        type: 'file',
        title: relativePath,
        uri: absolutePath,
        content: request.content,
        summary: request.summary ?? `受控写入文件 ${relativePath}`,
        metadata: { tool: 'file_write', path: relativePath, absolutePath, bytes }
      }
    };
  }

  private async runCommandTool(
    tool: Extract<ToolName, 'command_run' | 'run_test'>,
    command: string,
    args: string[],
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    if (!command) {
      return { tool, status: 'failed', summary: '未提供命令。', error: { code: 'UNKNOWN_ERROR', message: '未提供命令。', retryable: false } };
    }
    const result = await this.runProcess(command, args, context);
    const ok = !result.timedOut && !result.aborted && result.code === 0;
    const summary = this.processSummary(`${command} ${args.join(' ')}`.trim(), result);
    return {
      tool,
      status: ok ? 'completed' : 'failed',
      summary,
      detail: this.joinOutput(result),
      artifact: {
        type: tool === 'run_test' ? 'test_report' : 'text',
        title: `${tool}: ${command}`,
        summary,
        content: this.joinOutput(result),
        metadata: { tool, command, args, exitCode: result.code, timedOut: result.timedOut, aborted: result.aborted }
      },
      error: ok ? undefined : this.processError(result)
    };
  }

  private async gitDiff(
    request: Extract<ToolExecutionRequest, { tool: 'git_diff' }>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const args = ['--no-pager', 'diff', '--stat'];
    if (request.staged) {
      args.push('--staged');
    }
    if (request.pathspec?.length) {
      args.push('--', ...request.pathspec);
    }
    const result = await this.runProcess('git', args, context);
    const ok = !result.timedOut && !result.aborted && result.code === 0;
    const summary = ok ? '已收集工作区的 git diff 统计。' : this.processSummary('git diff --stat', result);
    return {
      tool: 'git_diff',
      status: ok ? 'completed' : 'failed',
      summary,
      detail: this.joinOutput(result),
      artifact: {
        type: 'code_diff',
        title: 'git diff --stat',
        summary,
        content: this.joinOutput(result),
        metadata: { tool: 'git_diff', args, exitCode: result.code, timedOut: result.timedOut, aborted: result.aborted }
      },
      error: ok ? undefined : this.processError(result)
    };
  }

  private resolveWorkspacePath(target: string, root: string) {
    if (!target || typeof target !== 'string') {
      throw new Error('需要提供工作区相对路径。');
    }
    const absolute = resolve(root, target);
    const relativePath = relative(root, absolute);
    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`路径超出了 Agent 工作区根目录：${target}`);
    }
    return absolute;
  }

  private defaultTestCommand() {
    const raw = process.env.RUNTIME_TEST_COMMAND?.trim();
    const parts = raw ? raw.split(/\s+/).filter(Boolean) : ['npm', 'test'];
    return { command: parts[0] ?? 'npm', args: parts.slice(1) };
  }

  private runProcess(command: string, args: string[], context: ToolExecutionContext): Promise<ProcessResult> {
    return new Promise((resolvePromise) => {
      const child = spawn(command, args, {
        cwd: resolveWorkspaceRoot(context.workspaceRoot),
        shell: false,
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const timeoutMs = runtimeTimeoutMs();
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      const onAbort = () => child.kill('SIGKILL');
      context.signal?.addEventListener('abort', onAbort, { once: true });

      const settle = (code: number, extraStderr?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
        resolvePromise({
          code,
          stdout: this.truncate(stdout),
          stderr: this.truncate(extraStderr ? `${stderr}\n${extraStderr}` : stderr),
          timedOut,
          aborted: context.signal?.aborted ?? false
        });
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => settle(-1, error.message));
      child.on('close', (code) => settle(code ?? -1));
    });
  }

  private processSummary(label: string, result: ProcessResult) {
    if (result.aborted) {
      return `已在完成前取消：${label}`;
    }
    if (result.timedOut) {
      return `执行超时（${runtimeTimeoutMs()}ms）：${label}`;
    }
    return `退出码 ${result.code}：${label}`;
  }

  private processError(result: ProcessResult): RuntimeError {
    if (result.aborted) {
      return { code: 'RUNTIME_CANCELLED', message: '工具执行已被取消。', retryable: false };
    }
    if (result.timedOut) {
      return { code: 'RUNTIME_TIMEOUT', message: `工具执行超时（${runtimeTimeoutMs()}ms）。`, retryable: true };
    }
    return {
      code: 'UNKNOWN_ERROR',
      message: result.stderr.trim() || `进程退出码 ${result.code}。`,
      retryable: false
    };
  }

  private joinOutput(result: ProcessResult) {
    return [result.stdout, result.stderr].map((value) => value.trim()).filter(Boolean).join('\n');
  }

  private truncate(value: string) {
    return value.length > MAX_OUTPUT_CHARS ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n…（已截断）` : value;
  }

  private blocked(tool: ToolName, message: string, details?: Record<string, unknown>): ToolExecutionResult {
    return {
      tool,
      status: 'blocked',
      summary: message,
      error: { code: 'CAPABILITY_BLOCKED', message, retryable: false, details }
    };
  }

  private emitToolEvent(
    context: ToolExecutionContext,
    type: 'tool_completed' | 'tool_failed',
    tool: ToolName,
    content: string,
    payload: Record<string, unknown>
  ) {
    if (!context.sessionId) {
      return;
    }
    this.events.create({
      sessionId: context.sessionId,
      type,
      taskId: context.taskId,
      fromAgentId: context.agentId,
      priority: type === 'tool_failed' ? 'high' : 'normal',
      content,
      metadata: {
        schemaVersion: '0.1',
        renderAs: 'tool_card',
        payload: { tool, runId: context.runId, ...payload }
      }
    });
  }
}
