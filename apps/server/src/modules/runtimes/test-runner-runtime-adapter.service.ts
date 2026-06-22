import { Injectable, Logger } from '@nestjs/common';
import type {
  AgentMessageOutput,
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeAdapter,
  RuntimeError,
  RuntimeType,
  TaskExecutionResultOutput
} from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import type { TestRunnerOutput } from '../tools/builtin/test-runner.tool.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';

type TestReport = {
  script: string;
  duration: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: string[];
  success: boolean;
  stdout: string;
  stderr: string;
};

@Injectable()
export class TestRunnerRuntimeAdapterService implements AgentRuntimeAdapter {
  private readonly logger = new Logger(TestRunnerRuntimeAdapterService.name);

  readonly type: RuntimeType = 'test_runner';
  readonly metadata = {
    name: 'test-runner',
    version: '0.1.0',
    category: 'internal' as const,
    provider: 'self-hosted',
    capabilityIds: ['cap-test-report', 'cap-command-run'] as const
  };

  constructor(private readonly toolRegistry: ToolRegistryService) {}

  async checkAvailability() {
    return { available: true };
  }

  async run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult> {
    const startedAt = nowIso();
    try {
      const runTestTool = this.toolRegistry.getTool('run_test');
      if (!runTestTool) {
        throw new Error('run_test tool not found');
      }

      const script = this.testScript(input);
      const result = await runTestTool.execute(
        { script },
        {
          workingDirectory: input.contextPack.workingDirectory?.path ?? '',
          sessionId: input.sessionId,
          agentId: input.agent.id,
          signal
        }
      );

      if (!result.success) {
        throw new Error(result.error ?? 'Test execution failed');
      }

      const report = this.generateReport(result.output);
      this.logger.log(`Tests completed: ${report.passed}/${report.total} passed`);
      return this.completedResult(input, report, startedAt);
    } catch (error) {
      return this.failedResult(input, error, startedAt);
    }
  }

  private testScript(input: AgentRunInput) {
    const taskContext = input.contextPack.taskContext as { testScript?: unknown } | undefined;
    return typeof taskContext?.testScript === 'string' && taskContext.testScript.length > 0
      ? taskContext.testScript
      : 'test';
  }

  private generateReport(output: unknown): TestReport {
    const testOutput = output as Partial<TestRunnerOutput>;
    const summary = testOutput.summary ?? { total: 0, passed: 0, failed: 0, skipped: 0 };
    return {
      script: testOutput.script ?? 'test',
      duration: testOutput.duration ?? 0,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      failures: testOutput.failures ?? [],
      success: testOutput.exitCode === 0,
      stdout: testOutput.stdout ?? '',
      stderr: testOutput.stderr ?? ''
    };
  }

  private completedResult(input: AgentRunInput, report: TestReport, startedAt: string): AgentRunResult {
    return {
      runId: input.runId,
      runtimeType: this.type,
      status: 'completed',
      output: this.output(report),
      events: [
        {
          runId: input.runId,
          type: 'runtime_started',
          content: `${input.agent.name} started test running`,
          createdAt: startedAt
        },
        {
          runId: input.runId,
          type: 'artifact_created',
          content: 'Test report artifact created',
          createdAt: nowIso()
        },
        {
          runId: input.runId,
          type: 'runtime_completed',
          content: `${input.agent.name} completed test running`,
          createdAt: nowIso()
        }
      ],
      artifacts: [
        {
          type: 'test_report',
          title: 'Test Report',
          summary: `${report.passed}/${report.total} tests passed`,
          content: this.reportContent(report),
          metadata: {
            script: report.script,
            duration: report.duration,
            summary: {
              total: report.total,
              passed: report.passed,
              failed: report.failed,
              skipped: report.skipped
            },
            failures: report.failures
          }
        }
      ],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: this.type
      }
    };
  }

  private failedResult(input: AgentRunInput, error: unknown, startedAt: string): AgentRunResult {
    const message = error instanceof Error ? error.message : String(error);
    const runtimeError: RuntimeError = {
      code: 'UNKNOWN_ERROR',
      message,
      retryable: false
    };
    return {
      runId: input.runId,
      runtimeType: this.type,
      status: 'failed',
      output: {
        kind: 'agent_message',
        messageKind: 'risk',
        content: message
      } satisfies AgentMessageOutput,
      events: [
        {
          runId: input.runId,
          type: 'runtime_started',
          content: `${input.agent.name} started test running`,
          createdAt: startedAt
        },
        {
          runId: input.runId,
          type: 'runtime_failed',
          content: message,
          metadata: { code: runtimeError.code },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: this.type
      },
      error: runtimeError
    };
  }

  private output(report: TestReport): TaskExecutionResultOutput {
    return {
      kind: 'task_execution_result',
      status: report.success ? 'completed' : 'failed',
      summary: `${report.passed}/${report.total} tests passed in ${report.duration}ms.`,
      completedItems: [`Script: ${report.script}`, `Passed: ${report.passed}`, `Skipped: ${report.skipped}`],
      changedArtifacts: [
        {
          type: 'test_report',
          title: 'Test Report',
          summary: `${report.passed}/${report.total} tests passed`
        }
      ],
      nextSuggestedActions: report.failed > 0 ? ['Inspect failing tests before continuing.'] : [],
      risks: report.failed > 0 ? report.failures : []
    };
  }

  private reportContent(report: TestReport) {
    return [
      `# Test Report`,
      '',
      `- Script: ${report.script}`,
      `- Duration: ${report.duration}ms`,
      `- Total: ${report.total}`,
      `- Passed: ${report.passed}`,
      `- Failed: ${report.failed}`,
      `- Skipped: ${report.skipped}`
    ].join('\n');
  }
}
