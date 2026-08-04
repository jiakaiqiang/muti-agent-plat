import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FileHash, WorkspaceChange, WorkspaceChangeSet, WorkspaceRevision } from '@agent-cluster/shared';
import { isWorkspaceSensitivePath } from '../workspaces/workspace-sensitive-guard.js';

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);

type Snapshot = { hash: FileHash; content: string };

export async function buildDirectoryChangeSet(input: {
  baselineRoot: string;
  executionRoot: string;
  baseRevision: WorkspaceRevision;
}): Promise<WorkspaceChangeSet> {
  const [before, after] = await Promise.all([snapshot(input.baselineRoot), snapshot(input.executionRoot)]);
  const changes: WorkspaceChange[] = [];
  for (const [path, current] of after) {
    const base = before.get(path);
    if (!base) {
      changes.push({ operation: 'create', path, content: current.content, encoding: 'utf-8' });
    } else if (base.hash.value !== current.hash.value) {
      changes.push({
        operation: 'update',
        path,
        content: current.content,
        encoding: 'utf-8',
        expectedHash: base.hash,
        baseContent: base.content
      });
    }
  }
  for (const [path, base] of before) {
    if (!after.has(path)) {
      changes.push({ operation: 'delete', path, expectedHash: base.hash, baseContent: base.content });
    }
  }
  return { id: randomUUID(), baseRevision: input.baseRevision, changes, createdAt: new Date().toISOString() };
}

async function snapshot(root: string) {
  const files = new Map<string, Snapshot>();
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && IGNORED.has(entry.name))) continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replace(/\\/g, '/');
      if (isWorkspaceSensitivePath(path)) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      const metadata = await lstat(absolute);
      if (!metadata.isFile()) continue;
      const bytes = await readFile(absolute);
      if (bytes.byteLength > 2 * 1024 * 1024 || bytes.includes(0)) {
        throw new Error(`Non-Git staging only supports UTF-8 files up to 2 MiB: ${path}`);
      }
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`Non-Git staging only supports UTF-8 files: ${path}`);
      }
      files.set(path, {
        content,
        hash: { algorithm: 'sha256', value: createHash('sha256').update(bytes).digest('hex') }
      });
    }
  };
  await visit(root);
  return files;
}
