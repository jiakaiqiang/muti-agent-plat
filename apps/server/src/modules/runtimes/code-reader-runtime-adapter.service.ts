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
import { getToolsForCapabilities } from '../tools/capability-tool-mapping.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';
import type { ToolResult } from '../tools/tool.interface.js';

@Injectable()
export class CodeReaderRuntimeAdapterService implements AgentRuntimeAdapter {
  private readonly logger = new Logger(CodeReaderRuntimeAdapterService.name);

  readonly type: RuntimeType = 'code_reader';
  readonly metadata = {
    name: 'code-reader',
    version: '0.1.0',
    category: 'internal' as const,
    provider: 'self-hosted',
    capabilityIds: ['cap-file-read', 'cap-code-search'] as const
  };

  constructor(private readonly toolRegistry: ToolRegistryService) {}

  async checkAvailability() {
    return { available: true };
  }

  async run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult> {
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
      for (const file of targetFiles) {
        const result = await readFileTool.execute(
          { path: file },
          {
            workingDirectory: input.contextPack.workingDirectory?.path ?? '',
            sessionId: input.sessionId,
            agentId: input.agent.id,
            signal
          }
        );
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

  private identifyTargetFiles(input: AgentRunInput): string[] {
    const taskContext = input.contextPack.taskContext as { targetFiles?: unknown } | undefined;
    const targetFiles = Array.isArray(taskContext?.targetFiles)
      ? taskContext.targetFiles.filter((file): file is string => typeof file === 'string')
      : [];

    if (targetFiles.length > 0) {
      return [...new Set(targetFiles)];
    }

    return [...new Set(input.contextPack.workspaceFocus?.relevantFiles ?? [])];
  }

  private completedResult(input: AgentRunInput, readResults: ToolResult[], startedAt: string): AgentRunResult {
    const output = this.analysisOutput(readResults);
    return {
      runId: input.runId,
      runtimeType: this.type,
      status: 'completed',
      output,
      events: [
        {
          runId: input.runId,
          type: 'runtime_started',
          content: `${input.agent.name} started code reading`,
          createdAt: startedAt
        },
        {
          runId: input.runId,
          type: 'runtime_completed',
          content: `${input.agent.name} completed code reading`,
          createdAt: nowIso()
        }
      ],
      artifacts: [],
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
          content: `${input.agent.name} started code reading`,
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
      kind: 'task_execution_result',
      status: 'completed',
      summary: `Analyzed ${fileSummaries.length} ${fileWord}.`,
      completedItems: fileSummaries.map(
        (file) => `${file.path}: ${file.lineCount} lines, ${file.byteLength} bytes${file.truncated ? ' (truncated)' : ''}`
      ),
      changedArtifacts: [],
      nextSuggestedActions: [],
      risks: []
    };
  }
}
