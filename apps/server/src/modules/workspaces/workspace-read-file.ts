import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { FileHash, ReadFileInput, ReadFileResult, WorkspaceRevision } from '@agent-cluster/shared';
import { isSensitivePath } from '../../common/path-safety.js';
import { resolveWorkspacePath } from './workspace-path.js';
import { assertWorkspacePathWithinRoot } from './workspace-symlink-guard.js';

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

  await assertWorkspacePathWithinRoot(rootPath, relative);

  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error(`workspace read rejected non-file path: ${relative}`);
  const handle = await open(absolute, 'r');
  let probe: Buffer;
  try {
    probe = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, metadata.size));
    const result = await handle.read(probe, 0, probe.byteLength, 0);
    probe = probe.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
  if (looksBinary(probe)) {
    throw new Error(`workspace read rejected binary file: ${relative}`);
  }

  const maxBytes = Math.max(1, input.maxBytes ?? DEFAULT_MAX_BYTES);
  const selected = await readBoundedText(absolute, metadata.size, maxBytes, input.startLine, input.endLine);
  const returnedBuffer = Buffer.from(selected.content, 'utf8');
  const fullRead = selected.complete && !selected.lineRange;
  const result: ReadFileResult = {
    path: relative,
    content: selected.content,
    encoding: 'utf-8',
    byteLength: returnedBuffer.byteLength,
    truncated: selected.truncated,
    revision,
    rangeHash: hashBuffer(returnedBuffer),
    fileSize: metadata.size,
    modifiedAt: metadata.mtime.toISOString(),
    ...(selected.startLine !== undefined ? { startLine: selected.startLine } : {}),
    ...(selected.endLine !== undefined ? { endLine: selected.endLine } : {})
  };
  if (fullRead) result.hash = hashBuffer(returnedBuffer);
  return result;
}

async function readBoundedText(
  absolute: string,
  fileSize: number,
  maxBytes: number,
  startLine?: number,
  endLine?: number
): Promise<{ content: string; truncated: boolean; complete: boolean; lineRange: boolean; startLine?: number; endLine?: number }> {
  const lineRange = startLine !== undefined || endLine !== undefined;
  const handle = await open(absolute, 'r');
  try {
    if (!lineRange) {
      const target = Math.min(fileSize, maxBytes + 1);
      const buffer = Buffer.alloc(target);
      const result = await handle.read(buffer, 0, target, 0);
      const read = buffer.subarray(0, result.bytesRead);
      const truncated = read.byteLength > maxBytes;
      const content = read.subarray(0, maxBytes).toString('utf8');
      return { content, truncated, complete: !truncated && read.byteLength === fileSize, lineRange: false };
    }

    const targetStart = Math.max(1, startLine ?? 1);
    const targetEnd = Math.max(targetStart, endLine ?? Number.MAX_SAFE_INTEGER);
    const stream = createReadStream(absolute, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    const selected: string[] = [];
    let currentLine = 0;
    let selectedEnd = targetStart - 1;
    let truncated = false;
    try {
      for await (const line of reader) {
        currentLine += 1;
        if (currentLine < targetStart) continue;
        if (currentLine > targetEnd) break;
        selected.push(line);
        selectedEnd = currentLine;
        if (Buffer.byteLength(selected.join('\n'), 'utf8') > maxBytes) {
          truncated = true;
          break;
        }
      }
    } finally {
      reader.close();
      stream.destroy();
    }
    const contentBuffer = Buffer.from(selected.join('\n'), 'utf8');
    return {
      content: contentBuffer.subarray(0, maxBytes).toString('utf8'),
      truncated,
      complete: currentLine >= targetEnd || currentLine === 0 || currentLine < targetStart,
      lineRange: true,
      startLine: targetStart,
      endLine: Math.max(targetStart, selectedEnd)
    };
  } finally {
    await handle.close();
  }
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
