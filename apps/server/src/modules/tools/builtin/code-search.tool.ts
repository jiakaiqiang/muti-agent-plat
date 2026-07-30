import { Injectable } from '@nestjs/common';
import type { WorkspaceSkippedReason } from '@agent-cluster/shared';
import { isGeneratedWorkspaceDirectory } from '@agent-cluster/shared';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isSensitivePath } from '../../../common/path-safety.js';
import { validateServerLocalWorkspace } from '../../workspaces/validate-server-local-workspace.js';
import type { Tool, ToolExecutionContext, ToolResult } from '../tool.interface.js';

const SEARCH_DEADLINE_MS = 10_000;
const MAX_FILE_BYTES = 512 * 1024;
const BINARY_PROBE_BYTES = 4_000;

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
      const workingDirectory = await validateServerLocalWorkspace({
        kind: 'server_local',
        id: 'search-code',
        name: 'search-code',
        path: context.workingDirectory,
        selectedAt: new Date().toISOString()
      });
      const root = workingDirectory.path!;
      const maxResults = this.maxResults(input.maxResults);
      const results: CodeSearchMatch[] = [];
      const skipped: CodeSearchOutput['skipped'] = [];
      const pending = [{ absolute: root, relative: '' }];
      const deadlineAt = Date.now() + SEARCH_DEADLINE_MS;
      let totalFiles = 0;
      let limited = false;

      while (pending.length && !limited) {
        if (context.signal?.aborted || Date.now() >= deadlineAt) {
          limited = true;
          break;
        }
        const directory = pending.shift()!;
        const entries = await readdir(directory.absolute, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const path = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
          const absolute = join(directory.absolute, entry.name);
          if (context.signal?.aborted || Date.now() >= deadlineAt) {
            limited = true;
            break;
          }
          if (entry.isSymbolicLink()) {
            skipped.push({ path, reason: 'sensitive', detail: 'symbolic links are outside the workspace trust boundary' });
            continue;
          }
          if (entry.isDirectory()) {
            if (isGeneratedWorkspaceDirectory(entry.name)) {
              skipped.push({ path, reason: 'ignored_directory' });
            } else if (isSensitivePath(path)) {
              skipped.push({ path, reason: 'sensitive' });
            } else {
              pending.push({ absolute, relative: path });
            }
            continue;
          }
          if (!entry.isFile()) continue;
          if (isSensitivePath(path)) {
            skipped.push({ path, reason: 'sensitive' });
            continue;
          }
          if (!this.matchesFilePattern(path, input.filePattern)) continue;
          try {
            const metadata = await stat(absolute);
            if (metadata.size > MAX_FILE_BYTES) {
              skipped.push({ path, reason: 'too_large' });
              continue;
            }
            const buffer = await readFile(absolute);
            if (this.looksBinary(buffer)) {
              skipped.push({ path, reason: 'binary' });
              continue;
            }
            totalFiles += 1;
            const lines = buffer.toString('utf8').split(/\r?\n/);
            for (const [index, line] of lines.entries()) {
              regex.lastIndex = 0;
              for (const match of line.matchAll(regex)) {
                results.push({ file: path, line: index + 1, content: line.trim(), match: match[0] });
                if (results.length >= maxResults) {
                  limited = true;
                  break;
                }
              }
              if (limited) break;
            }
          } catch (error) {
            skipped.push({ path, reason: 'read_error', detail: error instanceof Error ? error.message : String(error) });
          }
          if (limited) break;
        }
      }

      const output: CodeSearchOutput = {
        totalMatches: results.length,
        totalFiles,
        limited,
        results,
        skipped
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
    return Math.min(100, Math.max(1, Math.floor(value)));
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

  private looksBinary(buffer: Buffer) {
    const length = Math.min(buffer.byteLength, BINARY_PROBE_BYTES);
    for (let index = 0; index < length; index += 1) {
      if (buffer[index] === 0) return true;
    }
    return false;
  }

  private failure(error: unknown): ToolResult {
    return {
      success: false,
      output: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
