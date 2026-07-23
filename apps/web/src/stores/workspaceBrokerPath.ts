export function normalizeBrowserWorkspacePath(input: string): string {
  const raw = input.trim();
  if (raw === '' || raw === '.' || raw === './') return '';

  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`workspace path must be relative, drive-letter absolute path rejected: ${input}`);
  }

  const forward = raw.replace(/\\/g, '/');
  if (forward.startsWith('/')) {
    throw new Error(`workspace path must be relative, leading separator rejected: ${input}`);
  }

  const segments: string[] = [];
  for (const segment of forward.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new Error(`workspace path traversal outside root is not allowed: ${input}`);
    }
    segments.push(segment);
  }
  return segments.join('/');
}

const SENSITIVE_SEGMENTS = new Set(['.ssh', '.aws', '.docker']);
const SENSITIVE_FILENAMES = new Set([
  '.npmrc',
  '.pypirc',
  'credentials',
  'id_rsa',
  'id_ed25519'
]);

export function isSensitiveBrowserWorkspacePath(input: string): boolean {
  const normalized = normalizeBrowserWorkspacePath(input).toLowerCase();
  if (!normalized) return false;
  const segments = normalized.split('/');
  const filename = segments[segments.length - 1];
  return segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))
    || filename === '.env'
    || filename.startsWith('.env.')
    || SENSITIVE_FILENAMES.has(filename)
    || filename.endsWith('.pem')
    || filename.endsWith('.key');
}

export function assertSafeBrowserWorkspacePath(input: string): string {
  const normalized = normalizeBrowserWorkspacePath(input);
  if (isSensitiveBrowserWorkspacePath(normalized)) {
    const error = new Error(`sensitive workspace path is not accessible: ${input}`) as Error & { code?: string };
    error.code = 'WORKSPACE_SENSITIVE_PATH_DENIED';
    throw error;
  }
  return normalized;
}
