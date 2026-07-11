import { isAbsolute, posix, resolve, sep } from 'node:path';

export interface ResolvedWorkspacePath {
  absolute: string;
  relative: string;
}

export function resolveWorkspacePath(rootPath: string, relativePath: string): ResolvedWorkspacePath {
  const posixInput = relativePath.replace(/\\/g, '/').trim();

  if (posixInput === '' || posixInput === '.') {
    return { absolute: resolve(rootPath), relative: '' };
  }

  if (isAbsolute(posixInput) || isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new Error(`workspace path must be relative, received absolute path: ${relativePath}`);
  }

  const normalizedRelative = posix.normalize(posixInput);
  if (normalizedRelative.startsWith('../') || normalizedRelative === '..') {
    throw new Error(`workspace path traversal outside root is not allowed: ${relativePath}`);
  }

  const normalizedRoot = resolve(rootPath);
  const absolute = resolve(normalizedRoot, normalizedRelative);
  if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`workspace path escapes root: ${relativePath}`);
  }

  return { absolute, relative: normalizedRelative };
}
