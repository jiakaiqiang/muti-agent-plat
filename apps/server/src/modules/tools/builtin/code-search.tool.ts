import { Injectable } from '@nestjs/common';
import type { WorkspaceSkippedReason } from '@agent-cluster/shared';
import { scanServerWorkspace } from '../../../common/workspace-scanner.js';
import type { Tool, ToolExecutionContext, ToolResult } from '../tool.interface.js';

export type CodeSearchMatch = {
  file: string;
  line: number;
  content: string;
  match: string;
};

export type CodeSearchOutput = {
  totalMatches: number;
  totalFiles: number;
  limited: boolean;
  results: CodeSearchMatch[];
  skipped: Array<{ path: string; reason: WorkspaceSkippedReason; detail?: string }>;
};

type CodeSearchParams = {
  pattern: string;
  filePattern?: string;
  maxResults?: number;
  caseSensitive?: boolean;
};

@Injectable()
export class CodeSearchTool implements Tool {
  readonly name = 'search_code';
  readonly description = 'Search text workspace files with a regular expression';
  readonly category = 'code' as const;
  readonly riskLevel = 'low' as const;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for'
      },
      filePattern: {
        type: 'string',
        description: 'Optional simple file filter, such as *.ts or src/'
      },
      maxResults: {
        type: 'number',
        default: 100,
        description: 'Maximum number of matches to return'
      },
      caseSensitive: {
        type: 'boolean',
        default: false,
        description: 'Whether the regular expression is case-sensitive'
      }
    },
    required: ['pattern']
  };

  async execute(params: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    let input: CodeSearchParams;
    let regex: RegExp;
    try {
      input = this.parseParams(params);
      regex = new RegExp(input.pattern, input.caseSensitive ? 'g' : 'gi');
    } catch (error) {
      return this.failure(error);
    }

    try {
      const { workspaceSnapshot } = await scanServerWorkspace(context.workingDirectory);
      const files = workspaceSnapshot.files.filter((file) => this.matchesFilePattern(file.path, input.filePattern));
      const maxResults = this.maxResults(input.maxResults);
      const results: CodeSearchMatch[] = [];
      let limited = false;

      for (const file of files) {
        if (results.length >= maxResults) {
          limited = true;
          break;
        }

        if (typeof file.content !== 'string') {
          continue;
        }

        const lines = file.content.split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          regex.lastIndex = 0;
          for (const match of line.matchAll(regex)) {
            results.push({
              file: file.path,
              line: index + 1,
              content: line.trim(),
              match: match[0]
            });

            if (results.length >= maxResults) {
              limited = true;
              break;
            }
          }
          if (limited) break;
        }
      }

      const output: CodeSearchOutput = {
        totalMatches: results.length,
        totalFiles: files.length,
        limited,
        results,
        skipped: workspaceSnapshot.skipped
      };

      return {
        success: true,
        output
      };
    } catch (error) {
      return this.failure(error);
    }
  }

  private parseParams(params: unknown): CodeSearchParams {
    if (typeof params !== 'object' || params === null) {
      throw new Error('search_code requires an object input.');
    }

    const input = params as Partial<Record<keyof CodeSearchParams, unknown>>;
    if (typeof input.pattern !== 'string' || input.pattern.length === 0) {
      throw new Error('search_code requires a non-empty pattern.');
    }
    if (input.filePattern !== undefined && typeof input.filePattern !== 'string') {
      throw new Error('search_code filePattern must be a string when provided.');
    }
    if (input.maxResults !== undefined && typeof input.maxResults !== 'number') {
      throw new Error('search_code maxResults must be a number when provided.');
    }
    if (input.caseSensitive !== undefined && typeof input.caseSensitive !== 'boolean') {
      throw new Error('search_code caseSensitive must be a boolean when provided.');
    }

    return {
      pattern: input.pattern,
      filePattern: input.filePattern,
      maxResults: input.maxResults,
      caseSensitive: input.caseSensitive
    };
  }

  private maxResults(value: number | undefined) {
    if (value === undefined || !Number.isFinite(value)) {
      return 100;
    }
    return Math.max(1, Math.floor(value));
  }

  private matchesFilePattern(path: string, pattern: string | undefined) {
    if (!pattern) {
      return true;
    }

    const normalizedPath = path.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');
    if (!normalizedPattern.includes('*')) {
      return normalizedPath.includes(normalizedPattern);
    }

    const regexSource = normalizedPattern
      .split('*')
      .map((part) => this.escapeRegex(part))
      .join('[^/]*');
    return new RegExp(`(^|/)${regexSource}$`).test(normalizedPath);
  }

  private escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private failure(error: unknown): ToolResult {
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
