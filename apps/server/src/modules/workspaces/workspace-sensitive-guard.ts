import type { WorkspaceChange } from '@agent-cluster/shared';
import { isSensitivePath } from '../../common/path-safety.js';

export function isWorkspaceSensitivePath(path: string): boolean {
  return isSensitivePath(path);
}

export interface WorkspaceSensitiveEvaluation {
  allowed: string[];
  denied: Array<{ path: string; reason: string }>;
}

export function evaluateWorkspaceSensitivePaths(paths: readonly string[]): WorkspaceSensitiveEvaluation {
  const allowed: string[] = [];
  const denied: Array<{ path: string; reason: string }> = [];
  for (const path of paths) {
    if (isWorkspaceSensitivePath(path)) {
      denied.push({ path, reason: `workspace path is sensitive and cannot be exposed: ${path}` });
    } else {
      allowed.push(path);
    }
  }
  return { allowed, denied };
}

export function assertWorkspaceWriteAllowed(changes: readonly WorkspaceChange[]): void {
  for (const change of changes) {
    const targets = change.operation === 'move' ? [change.fromPath, change.toPath] : [change.path];
    for (const target of targets) {
      if (isWorkspaceSensitivePath(target)) {
        throw new Error(`workspace write denied for sensitive path: ${target}`);
      }
    }
  }
}
