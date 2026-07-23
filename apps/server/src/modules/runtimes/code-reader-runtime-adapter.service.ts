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
import { createAgentMessageOutput, createRuntimeArtifactSystemEvidence } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';
import { getToolsForCapabilities } from '../tools/capability-tool-mapping.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';
import type { ToolResult } from '../tools/tool.interface.js';
import { ToolInvocationAuditService } from '../tools/tool-invocation-audit.service.js';
import { InvocationWorkspaceBindingsService } from './invocation-workspace-bindings.service.js';
import { promiseHandle } from './promise-run-handle.js';
import { withStructuredTermination } from './structured-termination-run-handle.js';

@Injectable()
export class CodeReaderRuntimeAdapterService implements AgentRuntimeAdapter {
  private readonly logger = new Logger(CodeReaderRuntimeAdapterService.name);

  readonly type: RuntimeType = 'code_reader';
  readonly metadata = {
    name: 'code-reader',
    version: '0.1.0',
    category: 'internal' as const,
    provider: 'self-hosted',
    capabilityIds: ['cap-file-read', 'cap-code-search'] as const,
    supportedWorkspaceCapabilities: ['read'] as const,
    supportedToolNames: ['read_file', 'search_code'] as const
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
      const targetFiles = this.identifyTargetFiles(input);
      const readFileTool = this.toolRegistry.getTool('read_file');
      if (!readFileTool) {
        throw new Error('read_file tool not found');
      }

      const availableToolNames = getToolsForCapabilities([...this.metadata.capabilityIds]);
      this.logger.log(`Code reader available tools: ${availableToolNames.join(', ')}`);

      const readResults: ToolResult[] = [];
      for (const [index, file] of targetFiles.entries()) {
        const argumentsValue = { path: file };
        const toolStartedAt = nowIso();
        let result: ToolResult;
        try {
          result = await readFileTool.execute(
            argumentsValue,
            {
              workingDirectory: this.workspaceBindings.resolveServerRoot(input) ?? '',
              sessionId: input.sessionId,
              agentId: input.agent.agentId,
              signal
            }
          );
        } catch (error) {
          await this.recordToolInvocation(input, index, argumentsValue, undefined, false, toolStartedAt, error);
          throw error;
        }
        await this.recordToolInvocation(input, index, argumentsValue, result, result.success, toolStartedAt, result.error);
        if (!result.success) {
          throw new Error(result.error ?? `read_file failed for ${file}`);
        }
        readResults.push(result);
      }

      return this.completedResult(input, readResults, startedAt);
    } catch (error) {
      return this.failedResult(input, error, startedAt);
    }
  }

  private async recordToolInvocation(
    input: InvocationPlan,
    index: number,
    argumentsValue: unknown,
    result: unknown,
    success: boolean,
    startedAt: string,
    error?: unknown
  ): Promise<void> {
    const persisted = await this.toolAudit?.record({
      externalId: `tool:${input.invocationId}:read_file:${index + 1}`,
      runtimeInvocationExternalId: input.invocationId,
      sessionExternalId: input.sessionId,
      toolName: 'read_file',
      providerCallId: `${input.invocationId}:read_file:${index + 1}`,
      provider: this.type,
      arguments: argumentsValue,
      result,
      success,
      errorMessage: error ? (error instanceof Error ? error.message : String(error)) : undefined,
      agentExternalId: input.agent.agentId,
      startedAt,
      completedAt: nowIso()
    });
    if (persisted === false) this.logger.warn(`Tool audit was not persisted for ${input.invocationId}:read_file:${index + 1}`);
  }

  private identifyTargetFiles(input: InvocationPlan): string[] {
    const evidencePaths = input.contextEnvelope.L3.files.map((file) => file.path);
    const navigationPaths = input.contextEnvelope.L1.navigation.entries
      .filter((entry) => entry.kind === 'file' && !entry.generated && !entry.sensitive)
      .map((entry) => entry.path);
    return [...new Set([...evidencePaths, ...navigationPaths])].slice(0, 12);
  }

  private completedResult(input: InvocationPlan, readResults: ToolResult[], startedAt: string): AgentRunResult {
    const output = this.analysisOutput(readResults);
    return {
      invocationId: input.invocationId,
      runtimeType: this.type,
      status: 'completed',
      output,
      events: [
        {
          invocationId: input.invocationId,
          type: 'runtime_started',
          visibility: 'user',
          content: `${input.agent.name} started code reading`,
          createdAt: startedAt
        },
        {
          invocationId: input.invocationId,
          type: 'runtime_completed',
          visibility: 'user',
          content: `${input.agent.name} completed code reading`,
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
          content: `${input.agent.name} started code reading`,
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

  private analysisOutput(readResults: ToolResult[]): TaskExecutionResultOutput {
    const fileSummaries = readResults.map((result) => {
      const output = result.output as {
        output?: string;
        resolvedPath?: string;
        byteLength?: number;
        truncated?: boolean;
      };
      const content = output.output ?? '';
      return {
        path: output.resolvedPath ?? 'unknown',
        lineCount: content ? content.split(/\r?\n/).length : 0,
        byteLength: output.byteLength ?? content.length,
        truncated: output.truncated === true
      };
    });
    const fileWord = fileSummaries.length === 1 ? 'file' : 'files';

    return {
      schemaVersion: '1.0',
      kind: 'task_execution_result',
      status: 'completed',
      summary: `Analyzed ${fileSummaries.length} ${fileWord}.`,
      completedItems: fileSummaries.map(
        (file) => `${file.path}: ${file.lineCount} lines, ${file.byteLength} bytes${file.truncated ? ' (truncated)' : ''}`
      ),
      changedArtifacts: [],
      requestedContext: null,
      agentMessages: [],
      nextSuggestedActions: [],
      risks: []
    };
  }
}
