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
 */
export async function assertWithinRootRealpath(rootPath: string, absolutePath: string): Promise<string> {
  const normalizedRoot = await realpath(resolve(rootPath));
  let probe = absolutePath;
  // Walk up to find an existing ancestor; symlinks anywhere in the chain count.
  // Bound the loop by path depth so a malformed path can't spin forever.
  for (let i = 0; i < 64; i += 1) {
    try {
      const stat = await lstat(probe);
      const real = stat.isSymbolicLink() ? await realpath(probe) : await realpath(probe);
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
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
        // Not yet created — climb to the parent and try again.
        const parent = resolve(probe, '..');
        if (parent === probe) break;
        probe = parent;
        continue;
      }
      throw error;
    }
  }
  throw new Error(`无法解析路径：${absolutePath}`);
}

/**
 * Returns true when the path looks like it could expose credentials, keys, or
 * other secrets. Matches across path segments so that `apps/.env.production`
 * and `home/.ssh/id_rsa` both trigger.
 */
export function isSensitivePath(path: string) {
  return isSensitiveWorkspacePath(path);
}
