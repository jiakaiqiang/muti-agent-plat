import { Injectable } from '@nestjs/common';
import { WorkspaceToolsService } from '../../runtimes/workspace-tools.service.js';
import type { Tool, ToolExecutionContext, ToolResult } from '../tool.interface.js';

@Injectable()
export class FileReaderTool implements Tool {
  readonly name = 'read_file';
  readonly description = 'Read file contents from the current workspace';
  readonly category = 'file' as const;
  readonly riskLevel = 'low' as const;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to the working directory'
      },
      encoding: {
        type: 'string',
        default: 'utf-8',
        description: 'File encoding'
      }
    },
    required: ['path']
  };

  constructor(private readonly workspaceTools: WorkspaceToolsService) {}

  async execute(params: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    try {
      const path = this.extractPath(params);
      const result = await this.workspaceTools.readFile(context.workingDirectory, { path });

      return {
        success: result.ok,
        output: result,
        error: result.ok ? undefined : result.errorMessage
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private extractPath(params: unknown): string | undefined {
    if (typeof params !== 'object' || params === null) {
      return undefined;
    }
    const path = (params as { path?: unknown }).path;
    return typeof path === 'string' ? path : undefined;
  }
}
