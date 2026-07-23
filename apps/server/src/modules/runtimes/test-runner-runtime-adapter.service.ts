import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  AgentMessageOutput,
  InvocationPlan,
  AgentRunResult,
  AgentRuntimeAdapter,
  AgentRuntimeRunHandle,
  RuntimeError,
  RuntimeType,
  TaskExecutionResultOutput
} from '@agent-cluster/shared';
import {
  createAgentMessageOutput,
  createRuntimeArtifactOutput,
  createRuntimeArtifactSystemEvidence
} from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import type { TestRunnerOutput } from '../tools/builtin/test-runner.tool.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';
import { ToolInvocationAuditService } from '../tools/tool-invocation-audit.service.js';
import { InvocationWorkspaceBindingsService } from './invocation-workspace-bindings.service.js';
import { promiseHandle } from './promise-run-handle.js';
import { withStructuredTermination } from './structured-termination-run-handle.js';

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
    capabilityIds: ['cap-test-report', 'cap-command-run'] as const,
    supportedWorkspaceCapabilities: ['read', 'command', 'test'] as const,
    supportedToolNames: ['run_test'] as const
  };

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    private readonly workspaceBindings: InvocationWorkspaceBindingsService,
    @Optional() private readonly toolAudit?: ToolInvocationAuditService
  ) {}

  async checkAvailability() {
    return { available: true };
  }

  start(input: InvocationPlan, signal?: AbortSignal): AgentRuntimeRunHandle {
    return withStructuredTermination(promiseHandle(this.execute(input, signal)), input, signal);
  }

  private async execute(input: InvocationPlan, signal?: AbortSignal): Promise<AgentRunResult> {
    const startedAt = nowIso();
    try {
      const runTestTool = this.toolRegistry.getTool('run_test');
      if (!runTestTool) {
        throw new Error('run_test tool not found');
      }

      const script = this.testScript(input);
      const argumentsValue = { script };
      const toolStartedAt = nowIso();
      let result;
      try {
        result = await runTestTool.execute(
          argumentsValue,
          {
            workingDirectory: this.workspaceBindings.resolveServerRoot(input) ?? '',
            sessionId: input.sessionId,
            agentId: input.agent.agentId,
            signal
          }
        );
      } catch (error) {
        await this.recordToolInvocation(input, argumentsValue, undefined, false, toolStartedAt, error);
        throw error;
      }
      await this.recordToolInvocation(input, argumentsValue, result, result.success, toolStartedAt, result.error);

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

  private async recordToolInvocation(
    input: InvocationPlan,
    argumentsValue: unknown,
    result: unknown,
    success: boolean,
    startedAt: string,
    error?: unknown
  ): Promise<void> {
    const persisted = await this.toolAudit?.record({
      externalId: `tool:${input.invocationId}:run_test:1`,
      runtimeInvocationExternalId: input.invocationId,
      sessionExternalId: input.sessionId,
      toolName: 'run_test',
      providerCallId: `${input.invocationId}:run_test:1`,
      provider: this.type,
      arguments: argumentsValue,
      result,
      success,
      errorMessage: error ? (error instanceof Error ? error.message : String(error)) : undefined,
      agentExternalId: input.agent.agentId,
      startedAt,
      completedAt: nowIso()
    });
    if (persisted === false) this.logger.warn(`Tool audit was not persisted for ${input.invocationId}:run_test`);
  }

  private testScript(_input: InvocationPlan) {
    return 'test';
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

  private completedResult(input: InvocationPlan, report: TestReport, startedAt: string): AgentRunResult {
    return {
      invocationId: input.invocationId,
      runtimeType: this.type,
      status: 'completed',
      output: this.output(report),
      events: [
        {
          invocationId: input.invocationId,
          type: 'runtime_started',
          visibility: 'user',
          content: `${input.agent.name} started test running`,
          createdAt: startedAt
        },
        {
          invocationId: input.invocationId,
          type: 'artifact_created',
          visibility: 'user',
          content: 'Test report artifact created',
          createdAt: nowIso()
        },
        {
          invocationId: input.invocationId,
          type: 'runtime_completed',
          visibility: 'user',
          content: `${input.agent.name} completed test running`,
          createdAt: nowIso()
        }
      ],
      artifacts: [
        createRuntimeArtifactOutput({
          type: 'test_report',
          title: 'Test Report',
          summary: `${report.passed}/${report.total} tests passed`,
          content: this.reportContent(report)
        })
      ],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId, {
        verifiedTestResults: [{
          command: report.script,
          status: report.success ? 'passed' : 'failed',
          exitCode: report.success ? 0 : 1,
          stdout: report.stdout,
          stderr: report.stderr,
          startedAt,
          completedAt: nowIso()
        }]
      }),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: this.type
      }
    };
  }

  private failedResult(input: InvocationPlan, error: unknown, startedAt: string): AgentRunResult {
    const message = error instanceof Error ? error.message : String(error);
    const runtimeError: RuntimeError = {
      code: 'UNKNOWN_ERROR',
      message,
      retryable: false
    };
    return {
      invocationId: input.invocationId,
      runtimeType: this.type,
      status: 'failed',
      output: createAgentMessageOutput({ messageKind: 'risk', content: message }) satisfies AgentMessageOutput,
      events: [
        {
          invocationId: input.invocationId,
          type: 'runtime_started',
          visibility: 'user',
          content: `${input.agent.name} started test running`,
          createdAt: startedAt
        },
        {
          invocationId: input.invocationId,
          type: 'runtime_failed',
          visibility: 'user',
          content: message,
          metadata: { code: runtimeError.code },
          createdAt: nowIso()
        }
      ],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence(input.invocationId),
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
      schemaVersion: '1.0',
      kind: 'task_execution_result',
      status: report.success ? 'completed' : 'failed',
      summary: `${report.passed}/${report.total} tests passed in ${report.duration}ms.`,
      completedItems: [`Script: ${report.script}`, `Passed: ${report.passed}`, `Skipped: ${report.skipped}`],
      changedArtifacts: [
        createRuntimeArtifactOutput({
          type: 'test_report',
          title: 'Test Report',
          summary: `${report.passed}/${report.total} tests passed`,
          content: this.reportContent(report)
        })
      ],
      requestedContext: null,
      agentMessages: [],
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
