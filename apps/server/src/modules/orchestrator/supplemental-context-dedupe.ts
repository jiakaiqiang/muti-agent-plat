import type { RuntimeContextRequest, SessionDetail, TaskEvidenceRef } from '@agent-cluster/shared';

export type SeenContextSignatures = {
  refs: Set<string>;
  paths: Set<string>;
  commands: Set<string>;
};

export function refSignature(ref: TaskEvidenceRef): string {
  const identity = ref.ref ?? ref.label ?? '';
  return `${ref.type}::${identity}`;
}

export function collectSeenContextSignatures(
  prior: SessionDetail['supplementalContextRequests']
): SeenContextSignatures {
  const refs = new Set<string>();
  const paths = new Set<string>();
  const commands = new Set<string>();
  for (const entry of prior ?? []) {
    const hydratedPaths = entry.resolution ? new Set(entry.resolution.hydratedPaths) : undefined;
    for (const ref of entry.requestedContext.requestedRefs ?? []) {
      if (
        hydratedPaths &&
        (ref.type === 'workspace_file' || ref.type === 'workspace_symbol' || ref.type === 'test') &&
        (!ref.ref || !hydratedPaths.has(ref.ref))
      ) {
        continue;
      }
      refs.add(refSignature(ref));
    }
    const providedPaths = entry.resolution?.hydratedPaths ?? entry.requestedContext.requestedPaths ?? [];
    for (const path of providedPaths) {
      if (path) paths.add(path);
    }
    const providedCommands = entry.resolution ? [] : entry.requestedContext.requestedCommands ?? [];
    for (const command of providedCommands) {
      if (command) commands.add(command);
    }
  }
  return { refs, paths, commands };
}

export type RequestedContextDiff = {
  novelRefs: TaskEvidenceRef[];
  novelPaths: string[];
  novelCommands: string[];
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
  const novelPaths = (candidate.requestedPaths ?? []).filter(
    (path) => path && !seen.paths.has(path)
  );
  const novelCommands = (candidate.requestedCommands ?? []).filter(
    (command) => command && !seen.commands.has(command)
  );
  const hasNovelEntries =
    novelRefs.length > 0 || novelPaths.length > 0 || novelCommands.length > 0;
  return { novelRefs, novelPaths, novelCommands, hasNovelEntries };
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
    requestedPaths: diff.novelPaths.length ? diff.novelPaths : undefined,
    requestedCommands: diff.novelCommands.length ? diff.novelCommands : undefined,
    followUpInstruction: candidate.followUpInstruction
  };
}
