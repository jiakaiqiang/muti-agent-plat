import { isGeneratedWorkspaceDirectory } from '@agent-cluster/shared';

const GENERATED_FILE_SUFFIXES = ['.d.ts', '.js.map', '.min.js', '.min.css'] as const;

export function isGeneratedWorkspacePath(path: string): boolean {
  if (!path) return false;
  const segments = path.split('/').filter(Boolean);
  for (const segment of segments) {
    if (isGeneratedWorkspaceDirectory(segment)) return true;
  }
  const lower = path.toLowerCase();
  for (const suffix of GENERATED_FILE_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}
