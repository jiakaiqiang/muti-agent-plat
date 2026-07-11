import { createHash } from 'node:crypto';
import type {
  WorkspaceFileSnapshot,
  WorkspaceIndexEntry,
  WorkspaceRevision,
  WorkspaceSnapshot,
  WorkspaceTreeNode
} from '@agent-cluster/shared';
import { isGeneratedWorkspacePath } from './is-generated-workspace-path.js';
import { isSensitiveWorkspacePath } from './is-sensitive-workspace-path.js';

const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

export function buildIndexFromSnapshot(
  snapshot: WorkspaceSnapshot,
  revision: WorkspaceRevision
): WorkspaceIndexEntry[] {
  const filesByPath = new Map<string, WorkspaceFileSnapshot>();
  for (const file of snapshot.files) {
    filesByPath.set(file.path, file);
  }

  const seen = new Set<string>();
  const entries: WorkspaceIndexEntry[] = [];

  const push = (entry: WorkspaceIndexEntry): void => {
    if (seen.has(entry.path)) return;
    seen.add(entry.path);
    entries.push(entry);
  };

  const walk = (node: WorkspaceTreeNode): void => {
    if (node.kind === 'directory') {
      push({
        path: node.path,
        kind: 'directory',
        revision,
        generated: pathIsGenerated(node.path),
        sensitive: isSensitiveWorkspacePath(node.path)
      });
      for (const child of node.children ?? []) walk(child);
      return;
    }
    const fileSnapshot = filesByPath.get(node.path);
    push(fileFromSnapshot(node.path, fileSnapshot, revision));
  };

  for (const node of snapshot.tree) walk(node);

  for (const file of snapshot.files) {
    if (seen.has(file.path)) continue;
    push(fileFromSnapshot(file.path, file, revision));
  }

  return entries;
}

function fileFromSnapshot(
  path: string,
  file: WorkspaceFileSnapshot | undefined,
  revision: WorkspaceRevision
): WorkspaceIndexEntry {
  const size = file?.size ?? 0;
  const hashValue = file?.content
    ? createHash('sha256').update(file.content).digest('hex')
    : EMPTY_SHA256;
  return {
    path,
    kind: 'file',
    size,
    hash: { algorithm: 'sha256', value: hashValue },
    revision,
    generated: pathIsGenerated(path),
    sensitive: isSensitiveWorkspacePath(path),
    ...(file?.language ? { language: file.language } : {})
  };
}

function pathIsGenerated(path: string): boolean {
  return isGeneratedWorkspacePath(path);
}
