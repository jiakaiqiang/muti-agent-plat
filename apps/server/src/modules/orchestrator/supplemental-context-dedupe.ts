import type { RuntimeContextRequest, SessionDetail, TaskEvidenceRef } from '@agent-cluster/shared';

export type SeenContextSignatures = {
  refs: Set<string>;
  paths: Set<string>;
  directories: Set<string>;
  searches: Set<string>;
  commands: Set<string>;
};

export function refSignature(ref: TaskEvidenceRef): string {
  const identity = ref.ref ?? ref.label ?? '';
  return `${ref.type}::${identity}`;
}

export function collectSeenContextSignatures(
  prior: SessionDetail['supplementalContextRequests'],
  currentRevisionId?: string
): SeenContextSignatures {
  const refs = new Set<string>();
  const paths = new Set<string>();
  const directories = new Set<string>();
  const searches = new Set<string>();
  const commands = new Set<string>();
  for (const entry of prior ?? []) {
    const revisionMatches = (path: string) =>
      !currentRevisionId || entry.resolution?.evidenceRevisions?.[path]?.id === currentRevisionId;
    const hydratedPaths = entry.resolution
      ? new Set(entry.resolution.hydratedPaths.filter(revisionMatches))
      : undefined;
    const providedRefs = entry.resolution?.resolvedRefs
      ?? ((entry.resolution?.failedRefs?.length ?? 0) === 0
        ? (entry.requestedContext.requestedRefs ?? []).filter((ref) => Boolean(ref.ref))
        : []);
    for (const ref of providedRefs) {
      if (
        hydratedPaths &&
        (ref.type === 'workspace_file' || ref.type === 'workspace_symbol' || ref.type === 'test') &&
        (!ref.ref || !hydratedPaths.has(ref.ref))
      ) {
        continue;
      }
      refs.add(refSignature(ref));
    }
    const providedPaths = entry.resolution
      ? entry.resolution.hydratedPaths.filter(revisionMatches)
      : [
          ...(entry.requestedContext.requestedFiles ?? []).map((item) => item.path),
          ...(entry.requestedContext.requestedPaths ?? [])
        ];
    for (const path of providedPaths) {
      if (path) paths.add(path);
    }
    for (const directory of entry.requestedContext.requestedDirectories ?? []) {
      const evidencePath = `${directory.path.replace(/\/+$/, '') || '.'}/`;
      if (entry.resolution?.listedDirectories?.includes(directory.path) && revisionMatches(evidencePath)) {
        directories.add(directorySignature(directory));
      }
    }
    for (const search of entry.requestedContext.requestedSearches ?? []) {
      const evidencePath = `search:${search.query}`;
      if (entry.resolution?.completedSearches?.includes(searchSignature(search)) && revisionMatches(evidencePath)) {
        searches.add(searchSignature(search));
      }
    }
    const providedCommands = entry.resolution ? [] : entry.requestedContext.requestedCommands ?? [];
    for (const command of providedCommands) {
      if (command) commands.add(command);
    }
  }
  return { refs, paths, directories, searches, commands };
}

export type RequestedContextDiff = {
  novelRefs: TaskEvidenceRef[];
  novelFiles: NonNullable<RuntimeContextRequest['requestedFiles']>;
  /** @deprecated compatibility projection of novelFiles. */
  novelPaths: string[];
  novelCommands: string[];
  novelDirectories: NonNullable<RuntimeContextRequest['requestedDirectories']>;
  novelSearches: NonNullable<RuntimeContextRequest['requestedSearches']>;
  hasNovelEntries: boolean;
};

export function diffRequestedContext(
  candidate: RuntimeContextRequest,
  seen: SeenContextSignatures
): RequestedContextDiff {
  const novelRefs: TaskEvidenceRef[] = [];
  for (const ref of candidate.requestedRefs ?? []) {
    if (!seen.refs.has(refSignature(ref))) novelRefs.push(ref);
  }
  const candidateFiles = Array.from(new Map([
    ...(candidate.requestedFiles ?? []),
    ...(candidate.requestedPaths ?? []).map((path) => ({ path }))
  ].map((item) => [JSON.stringify(item), item])).values());
  const novelFiles = candidateFiles.filter((item) => item.path && !seen.paths.has(item.path));
  const novelPaths = novelFiles.map((item) => item.path);
  const novelCommands = (candidate.requestedCommands ?? []).filter(
    (command) => command && !seen.commands.has(command)
  );
  const novelDirectories = (candidate.requestedDirectories ?? []).filter(
    (directory) => !seen.directories.has(directorySignature(directory))
  );
  const novelSearches = (candidate.requestedSearches ?? []).filter(
    (search) => !seen.searches.has(searchSignature(search))
  );
  const hasNovelEntries =
    novelRefs.length > 0 || novelPaths.length > 0 || novelDirectories.length > 0 || novelSearches.length > 0 || novelCommands.length > 0;
  return { novelRefs, novelFiles, novelPaths, novelDirectories, novelSearches, novelCommands, hasNovelEntries };
}

export function trimToNovelContext(
  candidate: RuntimeContextRequest,
  seen: SeenContextSignatures
): RuntimeContextRequest | undefined {
  const diff = diffRequestedContext(candidate, seen);
  if (!diff.hasNovelEntries) return undefined;
  return {
    reason: candidate.reason,
    requestedRefs: diff.novelRefs,
    requestedFiles: diff.novelFiles.length ? diff.novelFiles : undefined,
    requestedDirectories: diff.novelDirectories.length ? diff.novelDirectories : undefined,
    requestedSearches: diff.novelSearches.length ? diff.novelSearches : undefined,
    requestedCommands: diff.novelCommands.length ? diff.novelCommands : undefined,
    followUpInstruction: candidate.followUpInstruction
  };
}

function directorySignature(directory: NonNullable<RuntimeContextRequest['requestedDirectories']>[number]): string {
  return `${directory.path}:${directory.depth ?? 1}`;
}

function searchSignature(search: NonNullable<RuntimeContextRequest['requestedSearches']>[number]): string {
  return JSON.stringify([search.query, search.path ?? '.', search.include ?? [], search.exclude ?? []]);
}
