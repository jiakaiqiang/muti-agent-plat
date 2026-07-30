import type {
  FileMetadata,
  WorkspaceFileSnapshot,
  WorkspaceManifestCoverage,
  WorkspaceSkippedReason,
  WorkspaceSnapshot,
  WorkspaceTreeNode
} from '@agent-cluster/shared';
import {
  isGeneratedWorkspaceDirectory,
  isSensitiveWorkspacePath,
  normalizeWorkspaceRelativePath
} from '@agent-cluster/shared';
import {
  detectWorkspaceEntrypoints,
  detectWorkspaceStack,
  shouldReadWorkspaceTextFile,
  workspaceFileScanPriority,
  workspaceLanguageForPath
} from '../../common/workspace-scanner.js';
import { nowIso } from '../../common/time.js';
import type { WorkspaceProvider } from './workspace-provider.js';

const maxScannedEntries = 350;
const maxReadableFiles = 80;
const maxSingleFileBytes = 80_000;
const maxTotalContentBytes = 550_000;
type WorkspaceFileMetadata = Extract<FileMetadata, { kind: 'file' }>;

export async function scanWorkspaceProvider(
  provider: WorkspaceProvider,
  rootName: string
): Promise<WorkspaceSnapshot> {
  if (!provider.capabilities().read) {
    throw new Error('WORKSPACE_READ_NOT_ALLOWED: Workspace snapshot requires read permission.');
  }
  const listed = await provider.listDirectory({
    path: '.',
    recursive: true,
    maxDepth: 12,
    limit: maxScannedEntries + 1
  });
  const observedRevision = listed.revision;
  const entries = listed.entries.slice(0, maxScannedEntries);
  const skipped: WorkspaceSnapshot['skipped'] = [];
  const tree: WorkspaceTreeNode[] = [];
  const readableCandidates: WorkspaceFileMetadata[] = [];
  const files: WorkspaceFileSnapshot[] = [];
  let totalBytes = 0;
  let generatedSkipped = 0;
  let totalContentBytes = 0;

  for (const entry of entries) {
    const path = safeProviderPath(entry.path);
    if (isSensitiveWorkspacePath(path)) {
      skipped.push({ path, reason: 'sensitive' });
      continue;
    }
    if (hasGeneratedDirectory(path, entry.kind)) {
      if (entry.kind === 'directory') {
        insertTreeNode(tree, path, 'directory');
        generatedSkipped += 1;
        skipped.push({ path, reason: 'ignored_directory' });
      }
      continue;
    }
    insertTreeNode(tree, path, entry.kind);
    if (entry.kind !== 'file') continue;
    totalBytes += entry.size;
    if (!shouldReadWorkspaceTextFile(path)) {
      skipped.push({ path, reason: 'binary' });
      continue;
    }
    if (entry.size > maxSingleFileBytes) {
      skipped.push({ path, reason: 'too_large', detail: `${entry.size} bytes` });
      continue;
    }
    readableCandidates.push({ ...entry, path });
  }

  if (listed.entries.length > maxScannedEntries || listed.nextCursor) {
    skipped.push({ path: '.', reason: 'limit_exceeded', detail: `more than ${maxScannedEntries} entries` });
  }

  readableCandidates.sort(
    (left, right) => workspaceFileScanPriority(left.path) - workspaceFileScanPriority(right.path) || left.path.localeCompare(right.path)
  );
  for (const candidate of readableCandidates) {
    if (files.length >= maxReadableFiles || totalContentBytes + candidate.size > maxTotalContentBytes) {
      skipped.push({ path: candidate.path, reason: 'limit_exceeded' });
      continue;
    }
    try {
      assertSameRevision(observedRevision.id, candidate.revision.id);
      const read = await provider.readFile({ path: candidate.path, maxBytes: maxSingleFileBytes });
      assertSameRevision(observedRevision.id, read.revision.id);
      if (safeProviderPath(read.path) !== candidate.path) {
        throw new Error(`WORKSPACE_PATH_MISMATCH: requested ${candidate.path}, received ${read.path}`);
      }
      if (candidate.hash && (!read.hash || read.hash.value !== candidate.hash.value)) {
        throw new Error(`WORKSPACE_FILE_CHANGED_DURING_SNAPSHOT: ${candidate.path}`);
      }
      if (read.truncated) {
        skipped.push({ path: candidate.path, reason: 'too_large', detail: 'provider returned truncated content' });
        continue;
      }
      totalContentBytes += read.byteLength;
      files.push({
        path: candidate.path,
        size: candidate.size,
        language: workspaceLanguageForPath(candidate.path),
        content: read.content
      });
    } catch (error) {
      if (isRevisionError(error)) throw error;
      skipped.push({
        path: candidate.path,
        reason: 'read_error',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const finalRevision = await provider.getRevision();
  assertSameRevision(observedRevision.id, finalRevision.id);
  const skippedByReason: Partial<Record<WorkspaceSkippedReason, number>> = {};
  for (const entry of skipped) {
    skippedByReason[entry.reason] = (skippedByReason[entry.reason] ?? 0) + 1;
  }
  const coverage: WorkspaceManifestCoverage = {
    totalEntriesSeen: entries.length + (listed.entries.length > maxScannedEntries || listed.nextCursor ? 1 : 0),
    scannedEntries: entries.length,
    readableFiles: files.length,
    generatedSkipped,
    skippedByReason
  };
  return {
    rootName,
    scannedAt: nowIso(),
    revision: observedRevision,
    fileCount: entries.length,
    totalBytes,
    tree,
    files,
    skipped,
    detectedStack: detectWorkspaceStack(files),
    entrypoints: detectWorkspaceEntrypoints(files),
    coverage
  };
}

function safeProviderPath(input: string) {
  const path = normalizeWorkspaceRelativePath(input).replace(/^\.\//, '');
  const segments = path.split('/').filter(Boolean);
  if (
    !path ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    segments.includes('.') ||
    segments.includes('..')
  ) {
    throw new Error(`WORKSPACE_PATH_INVALID: Provider returned an unsafe relative path: ${input}`);
  }
  return segments.join('/');
}

function hasGeneratedDirectory(path: string, kind: FileMetadata['kind']) {
  const segments = path.split('/');
  const directorySegments = kind === 'directory' ? segments : segments.slice(0, -1);
  return directorySegments.some((segment) => isGeneratedWorkspaceDirectory(segment.toLowerCase()));
}

function insertTreeNode(tree: WorkspaceTreeNode[], path: string, kind: WorkspaceTreeNode['kind']) {
  const segments = path.split('/');
  let target = tree;
  let currentPath = '';
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = currentPath ? `${currentPath}/${segments[index]}` : segments[index];
    const currentKind = index === segments.length - 1 ? kind : 'directory';
    let node = target.find((candidate) => candidate.path === currentPath);
    if (!node) {
      node = { path: currentPath, kind: currentKind, ...(currentKind === 'directory' ? { children: [] } : {}) };
      target.push(node);
      target.sort((left, right) => left.path.localeCompare(right.path));
    } else if (node.kind !== currentKind) {
      throw new Error(`WORKSPACE_TREE_CONFLICT: Provider returned conflicting metadata for ${currentPath}`);
    }
    if (currentKind === 'directory') target = node.children ??= [];
  }
}

function assertSameRevision(expected: string, actual: string) {
  if (actual !== expected) {
    throw new Error(`WORKSPACE_REVISION_CHANGED_DURING_SNAPSHOT: expected ${expected}, received ${actual}`);
  }
}

function isRevisionError(error: unknown) {
  return error instanceof Error && (
    error.message.startsWith('WORKSPACE_REVISION_CHANGED_DURING_SNAPSHOT:') ||
    error.message.startsWith('WORKSPACE_FILE_CHANGED_DURING_SNAPSHOT:')
  );
}
