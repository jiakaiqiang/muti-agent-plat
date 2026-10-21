import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Optional } from '@nestjs/common';
import { CapabilitiesService } from '../../capabilities/capabilities.service.js';
import { CapabilityAuditService } from '../../capabilities/capability-audit.service.js';
import type { Tool, ToolExecutionContext, ToolResult } from '../tool.interface.js';
import { IsolatedTestRunnerService, type IsolatedTestResult } from '../../runtimes/isolated-test-runner.service.js';

const execFileAsync = promisify(execFile);

type TestRunnerParams = {
  script: string;
  timeout?: number;
};

export type TestRunnerOutput = {
  script: string;
  duration: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  failures: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  isolation?: IsolatedTestResult['isolation'];
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  error?: string;
};

@Injectable()
export class TestRunnerTool implements Tool {
  readonly name = 'run_test';
  readonly description = 'Run an allowed npm test script in the current workspace';
  readonly category = 'test' as const;
  readonly riskLevel = 'high' as const;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      script: {
        type: 'string',
        default: 'test',
        description: 'package.json script name to run'
      },
      timeout: {
        type: 'number',
        default: 60_000,
        description: 'Timeout in milliseconds'
      }
    }
  };

  constructor(
    private readonly capabilities: CapabilitiesService,
    @Optional()
    private readonly audit?: CapabilityAuditService,
    @Optional() private readonly isolated?: IsolatedTestRunnerService
  ) {}

  async execute(params: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    let input: TestRunnerParams;
    try {
      input = this.parseParams(params);
      if (context.intentTestBinding) {
        if (!context.requireTestIsolation || !context.testExecution || context.testExecution.sessionId !== context.sessionId || !this.isolated) {
          return this.failure('ISOLATED_TEST_AUTHORITY_REQUIRED');
        }
        await this.isolated.authorize(context.testExecution, context.workingDirectory, input.script, context.intentTestBinding);
      }
      const scripts = await this.detectPackageScripts(context.workingDirectory);
      if (!Object.prototype.hasOwnProperty.call(scripts, input.script)) {
        return this.failure(`Npm script not found: ${input.script}`);
      }
    } catch (error) {
      return this.failure(error);
    }

    const auditInput = {
      sessionId: context.sessionId,
      agentId: context.agentId,
      reason: `run npm script ${input.script}`
    };
    const approval = context.intentTestBinding ? undefined : this.capabilities.checkInvocation('cap-command-run', auditInput);
    if (approval) this.audit?.recordCheck(auditInput, approval);

    if (approval && !approval.allowed) {
      return {
        success: false,
        output: null,
        error: approval.code ?? 'CAPABILITY_DENIED',
        metadata: {
          approvalKey: approval.approvalKey,
          requiresUserConfirmation: approval.requiresUserConfirmation
        }
      };
    }

    const start = Date.now();
    let commandResult: CommandResult;
    let isolation: IsolatedTestResult['isolation'] | undefined;
    if (context.requireTestIsolation || this.isolated?.isConfigured()) {
      if (!this.isolated?.isConfigured()) return this.failure('ISOLATED_TEST_IMAGE_REQUIRED');
      try {
        const isolated = await this.isolated.run({ workingDirectory: context.workingDirectory, script: input.script,
          timeoutMs: this.timeout(input.timeout), signal: context.signal, execution: context.testExecution });
        commandResult = isolated; isolation = isolated.isolation;
      } catch (error) { return this.failure(error); }
    } else commandResult = await this.runNpmScript(input, context);
    const duration = Date.now() - start;
    const output = this.toOutput(input.script, duration, commandResult);
    if (isolation) output.isolation = isolation;
    const success = commandResult.exitCode === 0 && !commandResult.timedOut && !commandResult.aborted && !commandResult.error;

    if (success) {
      this.audit?.recordToolCompleted(auditInput, output);
    } else {
      this.audit?.recordToolFailed(auditInput, commandResult.error ?? `npm script failed: ${input.script}`);
    }

    return {
      success,
      output,
      error: success ? undefined : commandResult.error ?? `npm script failed with exit code ${commandResult.exitCode}`
    };
  }

  private parseParams(params: unknown): TestRunnerParams {
    if (params !== undefined && (typeof params !== 'object' || params === null)) {
      throw new Error('run_test requires an object input.');
    }

    const input = (params ?? {}) as Partial<Record<keyof TestRunnerParams, unknown>>;
    const script = input.script === undefined ? 'test' : input.script;
    if (typeof script !== 'string' || script.length === 0 || !/^[\w:-]+$/.test(script)) {
      throw new Error(`Invalid npm script name: ${String(script)}`);
    }
    if (input.timeout !== undefined && typeof input.timeout !== 'number') {
      throw new Error('run_test timeout must be a number when provided.');
    }

    return {
      script,
      timeout: input.timeout
    };
  }

  private async detectPackageScripts(workingDirectory: string): Promise<Record<string, string>> {
    const content = await readFile(join(workingDirectory, 'package.json'), 'utf8');
    const packageJson = JSON.parse(content) as { scripts?: unknown };
    if (!packageJson.scripts || typeof packageJson.scripts !== 'object') {
      return {};
    }
    return packageJson.scripts as Record<string, string>;
  }

  private async runNpmScript(input: TestRunnerParams, context: ToolExecutionContext): Promise<CommandResult> {
    const timeout = this.timeout(input.timeout);
    const npm = this.npmCommand(input.script);
    try {
      const { stdout, stderr } = await execFileAsync(npm.command, npm.args, {
        cwd: context.workingDirectory,
        timeout,
        signal: context.signal,
        maxBuffer: 10 * 1024 * 1024
      });
      return {
        stdout,
        stderr,
        exitCode: 0,
        timedOut: false,
        aborted: false
      };
    } catch (error) {
      const detail = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        killed?: boolean;
        signal?: NodeJS.Signals;
        name?: string;
      };
      const aborted = context.signal?.aborted === true || detail.name === 'AbortError' || detail.code === 'ABORT_ERR';
      const timedOut = !aborted && detail.killed === true && detail.signal === 'SIGTERM';
      const exitCode = typeof detail.code === 'number' ? detail.code : null;

      return {
        stdout: detail.stdout ?? '',
        stderr: detail.stderr ?? '',
        exitCode,
        timedOut,
        aborted,
        error: timedOut
          ? `Test script timed out after ${timeout}ms.`
          : aborted
            ? 'Test script was aborted.'
            : detail.message
      };
    }
  }

  private toOutput(script: string, duration: number, result: CommandResult): TestRunnerOutput {
    const summary = this.parseSummary(`${result.stdout}\n${result.stderr}`);
    return {
      script,
      duration,
      summary,
      failures: this.parseFailures(result.stderr),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      aborted: result.aborted
    };
  }

  private parseSummary(output: string): TestRunnerOutput['summary'] {
    const total = this.numberFrom(output, /^# tests (\d+)$/m) || this.numberFrom(output, /(\d+)\s+tests?/i);
    const passed = this.numberFrom(output, /^# pass (\d+)$/m) || this.numberFrom(output, /(\d+)\s+(?:tests?\s+)?passed/i);
    const failed = this.numberFrom(output, /^# fail (\d+)$/m) || this.numberFrom(output, /(\d+)\s+(?:tests?\s+)?failed/i);
    const skipped = this.numberFrom(output, /^# skipped (\d+)$/m) || this.numberFrom(output, /(\d+)\s+(?:tests?\s+)?skipped/i);
    return {
      total: total || passed + failed + skipped,
      passed,
      failed,
      skipped
    };
  }

  private parseFailures(stderr: string) {
    return stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /fail|error/i.test(line))
      .slice(0, 20);
  }

  private numberFrom(output: string, pattern: RegExp) {
    const match = output.match(pattern);
    return match ? Number.parseInt(match[1] ?? '0', 10) : 0;
  }

  private timeout(value: number | undefined) {
    if (value === undefined || !Number.isFinite(value)) {
      return 60_000;
    }
    return Math.max(1, Math.floor(value));
  }

  private npmCommand(script: string) {
    if (process.env.npm_execpath) {
      return {
        command: process.execPath,
        args: [process.env.npm_execpath, 'run', '--silent', script]
      };
    }

    if (process.platform === 'win32') {
      return {
        command: process.env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/s', '/c', `npm.cmd run --silent ${script}`]
      };
    }

    return {
      command: 'npm',
      args: ['run', '--silent', script]
    };
  }

  private failure(error: unknown): ToolResult {
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
