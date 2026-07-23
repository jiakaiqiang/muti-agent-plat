import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { decodeSecret, encodeSecret } from '../../common/secret-cipher.js';

export type CutoverArchiveManifest = {
  archiveId: string;
  environment: string;
  createdAt: string;
  sourceRevision: string;
  encryptedSha256: string;
  encryptedByteLength: number;
  collectionCounts: Array<{ key: string; itemCount: number }>;
  encryption: 'aes-256-gcm+scrypt';
};

export type CutoverArchiveResult = {
  archiveFile: string;
  manifestFile: string;
  manifest: CutoverArchiveManifest;
};

export function assertArchiveOutsideDataRoot(dataRoot: string, archiveDirectory: string) {
  const root = resolve(dataRoot);
  const archive = resolve(archiveDirectory);
  if (isWithin(root, archive)) {
    throw new Error('CUTOVER_ARCHIVE_INSIDE_ACTIVE_DATA_ROOT: archive directory must be outside the active data root.');
  }
  if (existsSync(root) && existsSync(archive) && isWithin(realpathSync(root), realpathSync(archive))) {
    throw new Error('CUTOVER_ARCHIVE_INSIDE_ACTIVE_DATA_ROOT: archive symlink resolves inside the active data root.');
  }
  return archive;
}

function isWithin(root: string, candidate: string) {
  const relation = relative(root, candidate);
  return !relation || (!relation.startsWith('..') && !relation.includes(':'));
}

export function archiveCutoverState(input: {
  state: Record<string, unknown>;
  sourceRevision: string;
  dataRoot: string;
  archiveDirectory: string;
  archiveSecret: string;
  archiveId: string;
  environment: string;
  createdAt: string;
  collectionCounts: Array<{ key: string; itemCount: number }>;
}): CutoverArchiveResult {
  if (input.archiveSecret.trim().length < 16) {
    throw new Error('CUTOVER_ARCHIVE_KEY_WEAK: archive key must contain at least 16 characters.');
  }
  const directory = assertArchiveOutsideDataRoot(input.dataRoot, input.archiveDirectory);
  mkdirSync(directory, { recursive: true });
  const environment = input.environment.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const baseName = `${environment}-${input.archiveId}`;
  const archiveFile = join(directory, `${baseName}.state.enc`);
  const manifestFile = join(directory, `${baseName}.manifest.json`);

  if (existsSync(archiveFile) || existsSync(manifestFile)) {
    if (!existsSync(archiveFile) || !existsSync(manifestFile)) {
      throw new Error('CUTOVER_ARCHIVE_PARTIAL: archive or manifest is missing from an earlier attempt.');
    }
    const { manifest } = readCutoverArchive({
      archiveDirectory: directory,
      archiveSecret: input.archiveSecret,
      archiveId: input.archiveId,
      environment: input.environment,
      expectedSourceRevision: input.sourceRevision
    });
    return { archiveFile, manifestFile, manifest };
  }

  const envelope = encodeSecret(JSON.stringify(input.state), input.archiveSecret);
  const encryptedSha256 = createHash('sha256').update(envelope).digest('hex');
  const manifest: CutoverArchiveManifest = {
    archiveId: input.archiveId,
    environment: input.environment,
    createdAt: input.createdAt,
    sourceRevision: input.sourceRevision,
    encryptedSha256,
    encryptedByteLength: Buffer.byteLength(envelope, 'utf8'),
    collectionCounts: input.collectionCounts,
    encryption: 'aes-256-gcm+scrypt'
  };
  // The manifest hashes the encrypted envelope itself, so the archive file
  // must contain exactly those bytes with no formatting suffix.
  writeAtomicReadonly(archiveFile, envelope);
  writeAtomicReadonly(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { archiveFile, manifestFile, manifest };
}

export function readCutoverArchive(input: {
  archiveDirectory: string;
  archiveSecret: string;
  archiveId: string;
  environment: string;
  expectedSourceRevision: string;
}): { result: CutoverArchiveResult; state: Record<string, unknown>; manifest: CutoverArchiveManifest } {
  const environment = input.environment.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const baseName = `${environment}-${input.archiveId}`;
  const archiveFile = join(resolve(input.archiveDirectory), `${baseName}.state.enc`);
  const manifestFile = join(resolve(input.archiveDirectory), `${baseName}.manifest.json`);
  if (!existsSync(archiveFile) || !existsSync(manifestFile)) {
    throw new Error('CUTOVER_ARCHIVE_MISSING: encrypted archive and manifest are required.');
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as CutoverArchiveManifest;
  if (
    manifest.archiveId !== input.archiveId ||
    manifest.sourceRevision !== input.expectedSourceRevision ||
    manifest.encryption !== 'aes-256-gcm+scrypt'
  ) {
    throw new Error('CUTOVER_ARCHIVE_CONFLICT: existing archive does not match this cutover revision.');
  }
  const envelope = readFileSync(archiveFile, 'utf8').trim();
  const byteLength = Buffer.byteLength(envelope, 'utf8');
  const sha256 = createHash('sha256').update(envelope).digest('hex');
  if (byteLength !== manifest.encryptedByteLength || sha256 !== manifest.encryptedSha256) {
    throw new Error('CUTOVER_ARCHIVE_INTEGRITY_FAILED: encrypted archive length or SHA-256 does not match manifest.');
  }
  let state: Record<string, unknown>;
  try {
    const decoded = JSON.parse(decodeSecret(envelope, input.archiveSecret)) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('state is not an object');
    state = decoded as Record<string, unknown>;
  } catch (error) {
    throw new Error(`CUTOVER_ARCHIVE_DECRYPT_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = { archiveFile, manifestFile, manifest };
  return { result, state, manifest };
}

function writeAtomicReadonly(path: string, content: string) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
  const descriptor = openSync(temporary, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o400);
}
