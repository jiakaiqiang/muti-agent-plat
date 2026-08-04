import type {
  ContextL1NavigationEntry,
  ContextL1NavigationManifest,
  WorkspaceIndexEntry
} from '@agent-cluster/shared';

export interface BuildNavigationManifestArgs {
  entries: WorkspaceIndexEntry[];
  entrypoints: string[];
  maxEntries?: number;
  budgetTokens?: number;
}

const DEFAULT_MAX_ENTRIES = 60;

function estimateTokens(byteLength: number): number {
  return Math.ceil(byteLength / 4);
}

export function buildNavigationManifest(
  args: BuildNavigationManifestArgs
): ContextL1NavigationManifest {
  const { entries, entrypoints, maxEntries = DEFAULT_MAX_ENTRIES, budgetTokens } = args;
  const eligible = entries.filter((entry) => !entry.generated && !entry.sensitive);
  const entrypointSet = new Set(entrypoints);

  const scored = eligible
    .map((entry) => ({ entry, score: scoreEntry(entry, entrypointSet) }))
    .sort((a, b) => (b.score - a.score) || a.entry.path.localeCompare(b.entry.path));

  const total = scored.length;
  let limit = Math.max(1, maxEntries);

  if (budgetTokens !== undefined) {
    let usedTokens = 0;
    let count = 0;
    for (const { entry } of scored) {
      const entryBytes = Buffer.byteLength(JSON.stringify(toNavigationEntry(entry)), 'utf8');
      const entryTokens = estimateTokens(entryBytes);
      if (usedTokens + entryTokens > budgetTokens && count > 0) break;
      usedTokens += entryTokens;
      count += 1;
    }
    limit = Math.min(limit, count);
  }

  const kept = scored.slice(0, limit);
  const truncated = total > limit;

  const nav: ContextL1NavigationEntry[] = kept.map(({ entry }) => toNavigationEntry(entry));

  return {
    entries: nav,
    truncated,
    ...(truncated ? { nextCursor: encodeCursor(limit) } : {})
  };
}

function scoreEntry(entry: WorkspaceIndexEntry, entrypoints: Set<string>): number {
  let score = 0;
  if (entrypoints.has(entry.path)) score += 1000;
  if (entry.kind === 'directory') score += 100;
  const depth = entry.path.split('/').filter(Boolean).length;
  score += Math.max(0, 20 - depth);
  return score;
}

function toNavigationEntry(entry: WorkspaceIndexEntry): ContextL1NavigationEntry {
  if (entry.kind === 'directory') {
    return {
      path: entry.path,
      kind: 'directory',
      generated: entry.generated,
      sensitive: entry.sensitive
    };
  }
  return {
    path: entry.path,
    kind: 'file',
    generated: entry.generated,
    sensitive: entry.sensitive,
    size: entry.size,
    ...(entry.language ? { language: entry.language } : {})
  };
}

function encodeCursor(index: number): string {
  return Buffer.from(String(index), 'utf8').toString('base64url');
}
