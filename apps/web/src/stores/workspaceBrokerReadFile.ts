import type { ReadFileInput, ReadFileResult, WorkspaceRevision } from '@agent-cluster/shared';
import { assertSafeBrowserWorkspacePath } from './workspaceBrokerPath';

export interface BrowserFileHandle {
  name: string;
  getFile: () => Promise<BrowserFile>;
}

export interface BrowserFile {
  size: number;
  lastModified: number;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface BrowserDirectoryHandle {
  getFileHandle: (name: string) => Promise<BrowserFileHandle>;
  getDirectoryHandle: (name: string) => Promise<BrowserDirectoryHandle>;
}

export interface BrowserReadFileArgs {
  root: BrowserDirectoryHandle;
  input: ReadFileInput;
  revision: WorkspaceRevision;
  digest: (bytes: ArrayBuffer) => Promise<string>;
}

export async function browserReadFile(args: BrowserReadFileArgs): Promise<ReadFileResult> {
  const { root, input, revision, digest } = args;
  const normalized = assertSafeBrowserWorkspacePath(input.path);
  const segments = normalized ? normalized.split('/') : [];
  const fileHandle = await resolveFileHandle(root, segments);
  const file = await fileHandle.getFile();
  const bytes = await file.arrayBuffer();
  const digestValue = await digest(bytes);
  const fullText = await file.text();

  const sliced = maybeSliceByLines(fullText, input.startLine, input.endLine);
  const content = sliced?.content ?? fullText;
  const truncated =
    !sliced && typeof input.maxBytes === 'number' && file.size > Math.max(1, input.maxBytes);

  return {
    path: input.path,
    content: truncated ? content.slice(0, Math.max(1, input.maxBytes as number)) : content,
    encoding: 'utf-8',
    byteLength: truncated
      ? Math.min(file.size, Math.max(1, input.maxBytes as number))
      : sliced
        ? new TextEncoder().encode(sliced.content).byteLength
        : file.size,
    truncated: Boolean(truncated),
    revision,
    hash: { algorithm: 'sha256', value: digestValue },
    ...(sliced ? { startLine: sliced.startLine, endLine: sliced.endLine } : {})
  };
}

async function resolveFileHandle(
  root: BrowserDirectoryHandle,
  segments: string[]
): Promise<BrowserFileHandle> {
  if (segments.length === 0) throw new Error('empty path');
  let current: BrowserDirectoryHandle = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = await current.getDirectoryHandle(segments[i]);
  }
  return current.getFileHandle(segments[segments.length - 1]);
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
  if (start > end) return { content: '', startLine: start, endLine: end };
  return {
    content: lines.slice(start - 1, end).join('\n'),
    startLine: start,
    endLine: end
  };
}
