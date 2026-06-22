import { Injectable, Optional } from '@nestjs/common';
import type { RuntimeFileChange } from '@agent-cluster/shared';
import { applyServerLocalFileChanges } from '../../../common/server-file-changes.js';
import { CapabilitiesService } from '../../capabilities/capabilities.service.js';
import { CapabilityAuditService } from '../../capabilities/capability-audit.service.js';
import type { Tool, ToolExecutionContext, ToolResult } from '../tool.interface.js';

type FileWriterOperation = RuntimeFileChange['operation'];

type FileWriterParams = {
  path: string;
  content?: string;
  previousContent?: string | null;
  operation: FileWriterOperation;
};

@Injectable()
export class FileWriterTool implements Tool {
  readonly name = 'write_file';
  readonly description = 'Write controlled file changes into the current workspace';
  readonly category = 'file' as const;
  readonly riskLevel = 'high' as const;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the working directory'
      },
      content: {
        type: 'string',
        description: 'Target file content for create or update operations'
      },
      previousContent: {
        type: ['string', 'null'],
        description: 'Expected current content used for conflict protection'
      },
      operation: {
        type: 'string',
        enum: ['create', 'update', 'delete'],
        description: 'File change operation to apply'
      }
    },
    required: ['path', 'operation']
  };

  constructor(
    private readonly capabilities: CapabilitiesService,
    @Optional()
    private readonly audit?: CapabilityAuditService
  ) {}

  async execute(params: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    let input: FileWriterParams;
    try {
      input = this.parseParams(params);
    } catch (error) {
      return this.failure(error);
    }

    const auditInput = {
      sessionId: context.sessionId,
      agentId: context.agentId,
      reason: `write_file ${input.operation} ${input.path}`
    };
    const approval = this.capabilities.checkInvocation('cap-file-write', auditInput);
    this.audit?.recordCheck(auditInput, approval);

    if (!approval.allowed) {
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

    try {
      const change: RuntimeFileChange = {
        path: input.path,
        operation: input.operation,
        previousContent: input.previousContent ?? null,
        source: 'runtime_proposed_change'
      };

      if (input.operation !== 'delete') {
        change.content = input.content ?? '';
        change.encoding = 'utf-8';
      }

      await applyServerLocalFileChanges(context.workingDirectory, [change]);

      const output = {
        path: input.path,
        operation: input.operation
      };
      this.audit?.recordToolCompleted(auditInput, output);

      return {
        success: true,
        output,
        metadata: {
          approvalKey: approval.approvalKey
        }
      };
    } catch (error) {
      const message = this.errorMessage(error);
      this.audit?.recordToolFailed(auditInput, message);
      return {
        success: false,
        output: null,
        error: message
      };
    }
  }

  private parseParams(params: unknown): FileWriterParams {
    if (typeof params !== 'object' || params === null) {
      throw new Error('write_file requires an object input.');
    }

    const input = params as Partial<Record<keyof FileWriterParams, unknown>>;
    if (typeof input.path !== 'string' || input.path.length === 0) {
      throw new Error('write_file requires a non-empty path.');
    }
    if (!this.isOperation(input.operation)) {
      throw new Error('write_file requires operation to be create, update, or delete.');
    }
    if (input.operation !== 'delete' && input.content !== undefined && typeof input.content !== 'string') {
      throw new Error('write_file content must be a string when provided.');
    }
    if (
      input.previousContent !== undefined &&
      input.previousContent !== null &&
      typeof input.previousContent !== 'string'
    ) {
      throw new Error('write_file previousContent must be a string or null when provided.');
    }

    return {
      path: input.path,
      operation: input.operation,
      content: typeof input.content === 'string' ? input.content : undefined,
      previousContent:
        typeof input.previousContent === 'string' || input.previousContent === null ? input.previousContent : undefined
    };
  }

  private isOperation(value: unknown): value is FileWriterOperation {
    return value === 'create' || value === 'update' || value === 'delete';
  }

  private failure(error: unknown): ToolResult {
    return {
      success: false,
      output: null,
      error: this.errorMessage(error)
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
