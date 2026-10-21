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
  assertIntentInvocationScope,
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
    assertIntentInvocationScope(input);
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    if (signal?.aborted) forward(); else signal?.addEventListener('abort', forward, { once: true });
    const result = this.execute(input, controller.signal).finally(() => signal?.removeEventListener('abort', forward));
    const handle = promiseHandle(result);
    handle.cancel = async () => { controller.abort(); };
    return withStructuredTermination(handle, input, controller.signal);
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
            ...(input.intentTestBinding ? { intentTestBinding: input.intentTestBinding } : {}),
            ...(input.effectScope || input.executionBinding ? { requireTestIsolation: true } : {}),
            ...(input.operation && input.dataEpoch ? { testExecution: { sessionId: input.sessionId, dataEpoch: input.dataEpoch,
              operationId: input.operation.id, invocationId: input.invocationId } } : {}),
            signal
          }
        );
      } catch (error) {
        await this.recordToolInvocation(input, argumentsValue, undefined, false, toolStartedAt, error);
        throw error;
      }
      await this.recordToolInvocation(input, argumentsValue, result, result.success, toolStartedAt, result.error);

      if (!result.success) {
        throw new Error(result.error ?? '测试执行失败');
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

  private testScript(input: InvocationPlan) {
    return input.intentTestBinding?.script ?? 'test';
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
      output: { ...this.output(report), ...(input.intentTestBinding ? { changedArtifacts: [] } : {}) },
      events: [
        {
          invocationId: input.invocationId,
          type: 'runtime_started',
          visibility: 'user',
          content: `${input.agent.name} 已开始运行测试`,
          createdAt: startedAt
        },
        {
          invocationId: input.invocationId,
          type: input.intentTestBinding ? 'runtime_progress' : 'artifact_created',
          visibility: 'user',
          content: input.intentTestBinding ? '测试结果已记录，未发布产物。' : '已创建测试报告产物',
          createdAt: nowIso()
        },
        {
          invocationId: input.invocationId,
          type: 'runtime_completed',
          visibility: 'user',
          content: `${input.agent.name} 已完成测试运行`,
          createdAt: nowIso()
        }
      ],
      artifacts: input.intentTestBinding ? [] : [
        createRuntimeArtifactOutput({
          type: 'test_report',
          title: '测试报告',
          summary: `测试通过 ${report.passed}/${report.total} 项`,
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
      code: message === 'ISOLATED_TEST_STOP_UNCONFIRMED' ? 'RUNTIME_INVOCATION_ERROR' : 'UNKNOWN_ERROR',
      message,
      retryable: false,
      ...(message === 'ISOLATED_TEST_STOP_UNCONFIRMED' ? { details: { stopUnconfirmed: true, operationFailure: 'OPERATION_STOP_UNCONFIRMED' } } : {})
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
          content: `${input.agent.name} 已开始运行测试`,
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
      summary: `测试通过 ${report.passed}/${report.total} 项，耗时 ${report.duration} 毫秒。`,
      completedItems: [`脚本：${report.script}`, `通过：${report.passed}`, `跳过：${report.skipped}`],
      changedArtifacts: [
        createRuntimeArtifactOutput({
          type: 'test_report',
          title: '测试报告',
          summary: `测试通过 ${report.passed}/${report.total} 项`,
          content: this.reportContent(report)
        })
      ],
      requestedContext: null,
      agentMessages: [],
      nextSuggestedActions: report.failed > 0 ? ['请检查失败的测试后再继续。'] : [],
      risks: report.failed > 0 ? report.failures : []
    };
  }

  private reportContent(report: TestReport) {
    return [
      `# 测试报告`,
      '',
      `- 脚本：${report.script}`,
      `- 耗时：${report.duration} 毫秒`,
      `- 总数：${report.total}`,
      `- 通过：${report.passed}`,
      `- 失败：${report.failed}`,
      `- 跳过：${report.skipped}`
    ].join('\n');
  }
}
