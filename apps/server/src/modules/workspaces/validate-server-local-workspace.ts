import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import type { SessionWorkingDirectory } from '@agent-cluster/shared';

export async function validateServerLocalWorkspace(
  workingDirectory: SessionWorkingDirectory
): Promise<SessionWorkingDirectory> {
  const requestedPath = workingDirectory.path?.trim();
  if (!requestedPath || !isAbsolute(requestedPath)) {
    throw new Error(`工作区路径必须是绝对路径：${requestedPath ?? ''}`);
  }

  const canonicalPath = await realpath(requestedPath);
  const metadata = await stat(canonicalPath);
  if (!metadata.isDirectory()) throw new Error(`工作区路径不是目录：${requestedPath}`);

  const platformRoot = await realpath(process.env.AGENT_CLUSTER_PLATFORM_ROOT?.trim() || process.cwd());
  if (isSameOrChild(canonicalPath, platformRoot)) {
    throw new Error('平台仓库及其源码目录不能作为 server_local 业务工作区。');
  }

  const normalizedIdentity = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
  return {
    kind: 'server_local',
    id: `server-${createHash('sha256').update(normalizedIdentity).digest('hex').slice(0, 32)}`,
    name: basename(canonicalPath),
    path: canonicalPath,
    selectedAt: workingDirectory.selectedAt
  };
}

function isSameOrChild(candidate: string, parent: string) {
  const normalizedCandidate = normalizeForComparison(candidate);
  const normalizedParent = normalizeForComparison(parent);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${sep}`);
}

function normalizeForComparison(path: string) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
