import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FileHash, ReadFileInput, ReadFileResult, WorkspaceRevision } from '@agent-cluster/shared';
import { isSensitivePath } from '../../common/path-safety.js';
import { resolveWorkspacePath } from './workspace-path.js';

const DEFAULT_MAX_BYTES = 512 * 1024;
const BINARY_PROBE_BYTES = 8000;

export interface ReadServerLocalFileArgs {
  rootPath: string;
  revision: WorkspaceRevision;
  input: ReadFileInput;
}

export async function readServerLocalFile(args: ReadServerLocalFileArgs): Promise<ReadFileResult> {
  const { rootPath, revision, input } = args;
  const { absolute, relative } = resolveWorkspacePath(rootPath, input.path);

  if (isSensitivePath(relative)) {
    throw new Error(`workspace read denied for sensitive path: ${relative}`);
  }

  const buffer = await readFile(absolute);
  if (looksBinary(buffer)) {
    throw new Error(`workspace read rejected binary file: ${relative}`);
  }

  const maxBytes = Math.max(1, input.maxBytes ?? DEFAULT_MAX_BYTES);
  const fullText = buffer.toString('utf8');
  const fullHash = hashBuffer(buffer);

  const sliced = maybeSliceByLines(fullText, input.startLine, input.endLine);
  if (sliced) {
    return {
      path: relative,
      content: sliced.content,
      encoding: 'utf-8',
      byteLength: Buffer.byteLength(sliced.content, 'utf8'),
      truncated: false,
      revision,
      hash: fullHash,
      startLine: sliced.startLine,
      endLine: sliced.endLine
    };
  }

  if (buffer.byteLength > maxBytes) {
    const capped = buffer.subarray(0, maxBytes).toString('utf8');
    return {
      path: relative,
      content: capped,
      encoding: 'utf-8',
      byteLength: Buffer.byteLength(capped, 'utf8'),
      truncated: true,
      revision,
      hash: fullHash
    };
  }

  return {
    path: relative,
    content: fullText,
    encoding: 'utf-8',
    byteLength: buffer.byteLength,
    truncated: false,
    revision,
    hash: fullHash
  };
}

function hashBuffer(buffer: Buffer): FileHash {
  return { algorithm: 'sha256', value: createHash('sha256').update(buffer).digest('hex') };
}

function looksBinary(buffer: Buffer): boolean {
  const scanLength = Math.min(buffer.byteLength, BINARY_PROBE_BYTES);
  for (let i = 0; i < scanLength; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function maybeSliceByLines(
  content: string,
  startLine?: number,
  endLine?: number
): { content: string; startLine: number; endLine: number } | null {
  if (startLine === undefined && endLine === undefined) return null;
  const lines = content.split('\n');
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, endLine ?? lines.length);
  if (start > end) {
    return { content: '', startLine: start, endLine: end };
  }
  const chunk = lines.slice(start - 1, end).join('\n');
  return { content: chunk, startLine: start, endLine: end };
}
