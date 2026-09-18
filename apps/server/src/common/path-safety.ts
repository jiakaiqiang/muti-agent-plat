import { lstat, realpath } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { isSensitiveWorkspacePath, normalizeWorkspaceRelativePath } from '@agent-cluster/shared';

/** Normalize a path for cross-platform comparison: forward slashes, no trailing separator. */
export function normalizeRelativePath(input: string) {
  return normalizeWorkspaceRelativePath(input);
}

/**
 * Resolve `relativePath` under `rootPath` and assert it does not escape via
 * `..` or absolute paths. Pure path arithmetic — no filesystem I/O. Use this
 * for the cheap synchronous gate; pair with `assertWithinRootRealpath` if the
 * target may be a symlink.
 */
export function safeJoin(rootPath: string, relativePath: string) {
  const normalizedRoot = resolve(rootPath);
  const normalizedTarget = resolve(join(normalizedRoot, normalize(relativePath)));
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`文件路径必须位于工作目录内：${relativePath}`);
  }
  return normalizedTarget;
}

/**
 * Stronger check that follows symlinks. A symlink whose target lives outside
 * the working directory would pass `safeJoin` (which only inspects the link's
 * own path string) but fail here. Call this before reading or writing any path
 * that could be attacker-controlled.
 *
 * Returns the realpath if it stays inside root; throws otherwise. If the path
 * does not exist yet (e.g. a brand-new file), checks the parent directory's
 * realpath instead so creates still work.
 *
 * Fail-closed on unresolvable links: a path that exists (lstat succeeds) but
 * whose realpath cannot be resolved — a symlink pointing at a missing target,
 * or a link the OS refuses to resolve — has an answerable containment question
 * only via path-string comparison, which an escaping link defeats. Such a path
 * is rejected instead of silently degrading to the lexical check.
 */
export async function assertWithinRootRealpath(rootPath: string, absolutePath: string): Promise<string> {
  const normalizedRoot = await realpath(resolve(rootPath));
  let probe = absolutePath;
  // Walk up to find an existing ancestor; symlinks anywhere in the chain count.
  // Bound the loop by path depth so a malformed path can't spin forever.
  for (let i = 0; i < 64; i += 1) {
    let exists: Awaited<ReturnType<typeof lstat>>;
    try {
      exists = await lstat(probe);
    } catch (error) {
      if (isNodeFsError(error, 'ENOENT')) {
        // Not yet created — climbing to the parent is the documented way a
        // brand-new file still gets checked against its parent's realpath.
        const parent = resolve(probe, '..');
        if (parent === probe) break;
        probe = parent;
        continue;
      }
      throw error;
    }
    // The path exists. realpath failing here means it cannot be resolved at all
    // (dangling or OS-unresolvable symlink): rejecting is the only safe answer.
    let real: string;
    try {
      real = await realpath(probe);
    } catch (error) {
      if (isNodeFsError(error, 'ENOENT')) {
        throw new Error(`路径存在但无法解析（符号链接指向不存在的目标），按越界处理：${absolutePath}`);
      }
      throw error;
    }
    if (real !== normalizedRoot && !real.startsWith(`${normalizedRoot}${sep}`)) {
      throw new Error(`路径越界（含符号链接）：${absolutePath}`);
    }
    // If the original target had ancestors above this probe, splice them back
    // onto the resolved real ancestor and verify again.
    const tail = absolutePath.slice(probe.length);
    const candidate = tail ? join(real, tail) : real;
    const finalReal = resolve(candidate);
    if (finalReal !== normalizedRoot && !finalReal.startsWith(`${normalizedRoot}${sep}`)) {
      throw new Error(`路径越界（含符号链接）：${absolutePath}`);
    }
    return finalReal;
  }
  throw new Error(`无法解析路径：${absolutePath}`);
}

function isNodeFsError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

/**
 * Returns true when the path looks like it could expose credentials, keys, or
 * other secrets. Matches across path segments so that `apps/.env.production`
 * and `home/.ssh/id_rsa` both trigger.
 */
export function isSensitivePath(path: string) {
  return isSensitiveWorkspacePath(path);
}
