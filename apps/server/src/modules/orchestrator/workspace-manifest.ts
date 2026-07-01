import type {
  ContextPack,
  WorkspaceFileSnapshot,
  WorkspaceManifestCoverage,
  WorkspaceSnapshot
} from '@agent-cluster/shared';

type WorkspaceManifest = NonNullable<ContextPack['workspaceManifest']>;
type WorkspaceManifestFile = WorkspaceManifest['files'][number];

function fileWithoutRuntimeContent(file: WorkspaceFileSnapshot): WorkspaceManifestFile {
  const { content: _content, ...rest } = file;
  return {
    ...rest,
    contentLength: file.content?.length,
    summary:
      file.summary ??
      (file.content
        ? 'Content omitted from workspaceSnapshot; selected evidence content is injected separately.'
        : undefined)
  };
}

export function buildWorkspaceManifest(
  snapshot: WorkspaceSnapshot | undefined
): WorkspaceManifest | undefined {
  if (!snapshot) return undefined;
  return {
    rootName: snapshot.rootName,
    fileCount: snapshot.fileCount,
    readableFileCount: snapshot.files.length,
    skippedFileCount: snapshot.skipped.length,
    tree: snapshot.tree,
    files: snapshot.files.map(fileWithoutRuntimeContent),
    detectedStack: snapshot.detectedStack,
    entrypoints: snapshot.entrypoints,
    coverage: snapshot.coverage
  };
}

function totalSkipped(coverage: WorkspaceManifestCoverage): number {
  return Object.values(coverage.skippedByReason).reduce(
    (acc, value) => acc + (value ?? 0),
    0
  );
}

export function buildCoverageSystemRule(
  snapshot: WorkspaceSnapshot | undefined
): string | undefined {
  const coverage = snapshot?.coverage;
  if (!coverage) return undefined;
  const skippedCount = totalSkipped(coverage);
  const scanIsPartial =
    coverage.scannedEntries < coverage.totalEntriesSeen || skippedCount > 0;
  if (!scanIsPartial) return undefined;
  const reasons = Object.entries(coverage.skippedByReason)
    .filter(([, value]) => (value ?? 0) > 0)
    .map(([reason, value]) => `${reason}=${value}`)
    .join(', ');
  const reasonHint = reasons ? ` Skip reasons: ${reasons}.` : '';
  return (
    `Workspace scan covered ${coverage.scannedEntries}/${coverage.totalEntriesSeen} entries ` +
    `(${coverage.readableFiles} readable, ${skippedCount} skipped).${reasonHint} ` +
    'If you need a file outside the manifest, return CONTEXT_INSUFFICIENT with the missing requestedPaths instead of guessing.'
  );
}
