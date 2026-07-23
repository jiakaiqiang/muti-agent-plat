import type {
  FileMetadata,
  ListDirectoryInput,
  ListDirectoryResult,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { isGeneratedWorkspaceDirectory } from '@agent-cluster/shared';
import {
  assertSafeBrowserWorkspacePath,
  isSensitiveBrowserWorkspacePath
} from './workspaceBrokerPath';

export interface BrowserDirectoryEntry {
  name: string;
  kind: 'file' | 'directory';
  size?: number;
}

export interface BrowserListDirectoryHandle {
  entries: () => AsyncIterable<BrowserDirectoryEntry>;
  getDirectoryHandle: (name: string) => Promise<BrowserListDirectoryHandle>;
}

export interface BrowserListDirectoryArgs {
  root: BrowserListDirectoryHandle;
  input: ListDirectoryInput;
  revision: WorkspaceRevision;
  digestFile: (path: string) => Promise<{ hashValue: string; size: number }>;
}

const DEFAULT_LIMIT = 200;

export async function browserListDirectory(
  args: BrowserListDirectoryArgs
): Promise<ListDirectoryResult> {
  const { root, input, revision, digestFile } = args;
  const relativePath = normalizeRelative(input.path ?? '');
  const target = await resolveDirectory(root, relativePath);

  const collected: BrowserDirectoryEntry[] = [];
  for await (const entry of target.entries()) {
    const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.kind === 'directory' && isGeneratedWorkspaceDirectory(entry.name)) continue;
    if (isSensitiveBrowserWorkspacePath(entryPath)) continue;
    collected.push(entry);
  }
  collected.sort((a, b) => a.name.localeCompare(b.name));

  const cursorIndex = decodeCursor(input.cursor, collected.length);
  const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
  const slice = collected.slice(cursorIndex, cursorIndex + limit);

  const entries: FileMetadata[] = [];
  for (const item of slice) {
    const path = relativePath ? `${relativePath}/${item.name}` : item.name;
    if (item.kind === 'directory') {
      entries.push({ path, kind: 'directory', revision });
      continue;
    }
    const { hashValue, size } = await digestFile(path);
    entries.push({
      path,
      kind: 'file',
      size,
      hash: { algorithm: 'sha256', value: hashValue },
      revision
    });
  }

  const nextIndex = cursorIndex + slice.length;
  const nextCursor = nextIndex < collected.length ? encodeCursor(nextIndex) : undefined;

  return {
    path: relativePath,
    entries,
    revision,
    ...(nextCursor ? { nextCursor } : {})
  };
}

function normalizeRelative(input: string): string {
  return assertSafeBrowserWorkspacePath(input);
}

async function resolveDirectory(
  root: BrowserListDirectoryHandle,
  relativePath: string
): Promise<BrowserListDirectoryHandle> {
  if (!relativePath) return root;
  const segments = relativePath.split('/');
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment);
  }
  return current;
}

function encodeCursor(index: number): string {
  return toBase64Url(String(index));
}

function decodeCursor(cursor: string | undefined, total: number): number {
  if (!cursor) return 0;
  const decoded = Number.parseInt(fromBase64Url(cursor), 10);
  if (!Number.isFinite(decoded) || decoded < 0) return 0;
  return Math.min(decoded, total);
}

interface WithBase64Codec {
  btoa?: (input: string) => string;
  atob?: (input: string) => string;
  Buffer?: {
    from(input: string, encoding: string): { toString(encoding: string): string };
  };
}

function base64Env(): WithBase64Codec {
  return globalThis as unknown as WithBase64Codec;
}

function toBase64Url(input: string): string {
  const env = base64Env();
  const base64 = env.btoa
    ? env.btoa(input)
    : env.Buffer!.from(input, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(cursor: string): string {
  const padded = cursor.replace(/-/g, '+').replace(/_/g, '/').padEnd(cursor.length + (4 - (cursor.length % 4)) % 4, '=');
  const env = base64Env();
  return env.atob ? env.atob(padded) : env.Buffer!.from(padded, 'base64').toString('utf8');
}
