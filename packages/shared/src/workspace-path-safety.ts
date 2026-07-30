const sensitiveDirectoryNames = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.azure',
  '.docker',
  '.kube',
  '.gnupg',
  '.config'
]);

const sensitiveFileNames = new Set([
  '.env',
  '.npmrc',
  '.gitconfig',
  '.netrc',
  '.pypirc',
  'credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519'
]);

const sensitiveExtensions = new Set(['.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.der']);
const sensitiveSubstrings = ['secret', 'private-key', 'private_key', 'apikey', 'api-key', 'api_key', 'token'];

export function normalizeWorkspaceRelativePath(input: string) {
  return input.replace(/\\/g, '/').replace(/\/+$/g, '');
}

export function isSensitiveWorkspacePath(path: string) {
  const normalized = normalizeWorkspaceRelativePath(path).toLowerCase();
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);
  for (const segment of segments) {
    if (sensitiveDirectoryNames.has(segment) || sensitiveFileNames.has(segment)) return true;
    if (segment.startsWith('.env')) return true;
    if ([...sensitiveExtensions].some((extension) => segment.endsWith(extension))) return true;
    if (sensitiveSubstrings.some((needle) => segment.includes(needle))) return true;
  }
  return false;
}
