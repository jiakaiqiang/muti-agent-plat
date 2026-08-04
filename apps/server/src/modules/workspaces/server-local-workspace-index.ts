import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type {
  WorkspaceIndexSnapshot,
  WorkspaceIndexQueryInput,
  WorkspaceIndexQueryResult,
  WorkspaceIndexSnapshotInput,
  WorkspaceIndexSnapshotPage,
  WorkspaceNavigationEntry,
  WorkspaceRevision
} from '@agent-cluster/shared';
import { isGeneratedWorkspaceDirectory, isSensitiveWorkspacePath } from '@agent-cluster/shared';
import { createWorkspaceRevision } from './workspace-revision.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';

const states = new Map<string, ServerLocalWorkspaceState>();
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);
const maxEntries = 100_000;

export type ServerLocalWorkspaceState = {
  revision: WorkspaceRevision;
  index: WorkspaceIndexSnapshot;
  build?: Promise<void>;
  timer?: NodeJS.Timeout;
  incrementalTimer?: NodeJS.Timeout;
  incrementalBuild?: Promise<void>;
  pendingPaths?: Set<string>;
  lastStableComplete?: boolean;
  watcher?: FSWatcher;
  cacheFile?: string;
  closed?: boolean;
  persistence?: Promise<void>;
};

export function getServerLocalWorkspaceState(rootPath: string, cacheDirectory?: string): ServerLocalWorkspaceState {
  const cached = states.get(rootPath);
  if (cached) {
    if (!cached.cacheFile && cacheDirectory) {
      cached.cacheFile = join(cacheDirectory, `${workspaceId(rootPath)}.json`);
      if (cached.index.status === 'ready') queuePersistSnapshot(cached);
    }
    return cached;
  }
  const revision = createWorkspaceRevision();
  const state: ServerLocalWorkspaceState = {
    revision,
    index: emptySnapshot(rootPath, revision),
    lastStableComplete: false
  };
  states.set(rootPath, state);
  recordIndexSnapshot(state.index);
  startWatcher(rootPath, state);
  state.cacheFile = cacheDirectory ? join(cacheDirectory, `${workspaceId(rootPath)}.json`) : undefined;
  void restoreThenBuild(rootPath, state);
  return state;
}

export async function resetServerLocalWorkspaceStateForTests(rootPath: string): Promise<void> {
  const state = states.get(rootPath);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  if (state.incrementalTimer) clearTimeout(state.incrementalTimer);
  state.closed = true;
  state.watcher?.close();
  states.delete(rootPath);
  await Promise.allSettled([state.build, state.incrementalBuild].filter((operation): operation is Promise<void> => Boolean(operation)));
  await state.persistence?.catch(() => undefined);
}

async function restoreThenBuild(rootPath: string, state: ServerLocalWorkspaceState): Promise<void> {
  if (state.cacheFile) {
    try {
      const restored = JSON.parse(await readFile(state.cacheFile, 'utf8')) as WorkspaceIndexSnapshot;
      if (!state.closed && restored.workspaceId === workspaceId(rootPath) && Array.isArray(restored.entries)) {
        state.index = {
          ...restored,
          revision: state.revision,
          status: 'stale',
          complete: false,
          updatedAt: new Date().toISOString()
        };
        state.lastStableComplete = restored.complete;
        recordIndexSnapshot(state.index);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        state.index = { ...state.index, status: 'failed', errorCode: 'INDEX_CACHE_READ_FAILED' };
      }
    }
  }
  if (state.closed) return;
  scheduleBuild(rootPath, state, 0);
}

export function updateServerLocalWorkspaceRevision(
  rootPath: string,
  state: ServerLocalWorkspaceState,
  revision: WorkspaceRevision = createWorkspaceRevision()
): void {
  state.revision = revision;
  state.index = {
    ...state.index,
    revision,
    status: 'stale',
    complete: false,
    updatedAt: new Date().toISOString()
  };
  scheduleBuild(rootPath, state, 250);
}

export function getServerLocalIndexSnapshot(
  state: ServerLocalWorkspaceState,
  input: WorkspaceIndexSnapshotInput
): WorkspaceIndexSnapshotPage {
  const limit = Math.min(2_000, Math.max(1, input.limit ?? 500));
  const offset = decodeCursor(input.cursor, state.index.entries.length);
  const entries = input.generation !== undefined && input.generation !== state.index.generation
    ? []
    : state.index.entries.slice(offset, offset + limit);
  const nextOffset = offset + entries.length;
  return {
    ...state.index,
    entries,
    ...(nextOffset < state.index.entries.length ? { nextCursor: encodeCursor(nextOffset) } : {})
  };
}

export function queryServerLocalIndex(
  state: ServerLocalWorkspaceState,
  input: WorkspaceIndexQueryInput = {}
): WorkspaceIndexQueryResult {
  if (input.generation !== undefined && input.generation !== state.index.generation) {
    return { ...state.index, entries: [], matched: 0 };
  }
  const terms = [
    ...(input.pathHints ?? []),
    ...(input.symbols ?? []),
    ...(input.intent ? input.intent.split(/[^a-zA-Z0-9_./-]+/) : []),
    ...(input.query ? input.query.split(/[^a-zA-Z0-9_./-]+/) : [])
  ].map((term) => term.trim().toLowerCase()).filter((term) => term.length >= 2);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const entrypoints = new Set(state.index.entrypoints.map((path) => path.toLowerCase()));
  const ranked = state.index.entries
    .map((entry, order) => {
      const path = entry.path.toLowerCase();
      const matches = terms.filter((term) => path.includes(term) || term.includes(path));
      const score = matches.length * 10 + (entry.kind === 'file' ? 1 : 0) + (entrypoints.has(path) ? 5 : 0);
      return { entry, order, score, matchedTerms: matches.length };
    })
    .filter((item) => terms.length === 0 || item.matchedTerms > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order);
  const candidates = Array.from(new Map(
    state.index.entries
      .filter((entry) => entrypoints.has(entry.path.toLowerCase()))
      .concat(ranked.map((item) => item.entry))
      .concat(ranked.length ? [] : state.index.entries)
      .map((entry) => [entry.path, entry])
  ).values());
  return { ...state.index, entries: candidates.slice(0, limit), matched: ranked.length };
}

function scheduleBuild(rootPath: string, state: ServerLocalWorkspaceState, delayMs: number): void {
  if (state.closed) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    if (state.closed) return;
    state.timer = undefined;
    if (state.build) {
      scheduleBuild(rootPath, state, delayMs);
      return;
    }
    state.build = buildIndex(rootPath, state).finally(() => {
      state.build = undefined;
    });
  }, delayMs);
  state.timer.unref?.();
}

async function buildIndex(rootPath: string, state: ServerLocalWorkspaceState): Promise<void> {
  if (state.closed) return;
  const startedAt = Date.now();
  const revision = state.revision;
  const generation = state.index.generation + 1;
  const priorEntries = state.index.entries;
  const entries: WorkspaceNavigationEntry[] = [];
  const pending = [rootPath];
  state.index = {
    ...state.index,
    revision,
    generation,
    status: 'building',
    complete: false,
    updatedAt: new Date().toISOString()
  };
  recordIndexSnapshot(state.index);
  try {
    while (!state.closed && pending.length && entries.length < maxEntries) {
      const directory = pending.shift()!;
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (child.isSymbolicLink()) continue;
        const absolute = join(directory, child.name);
        const path = relative(rootPath, absolute).replace(/\\/g, '/');
        if (isSensitiveWorkspacePath(path)) continue;
        if (child.isDirectory() && (ignoredDirectories.has(child.name) || isGeneratedWorkspaceDirectory(child.name))) continue;
        const metadata = await stat(absolute).catch(() => undefined);
        if (!metadata) continue;
        if (child.isDirectory()) {
          entries.push({ path, kind: 'directory', modifiedAt: metadata.mtime.toISOString(), generated: false, sensitive: false });
          pending.push(absolute);
        } else if (child.isFile()) {
          const language = languageForPath(path);
          entries.push({
            path,
            kind: 'file',
            size: metadata.size,
            modifiedAt: metadata.mtime.toISOString(),
            ...(language ? { language } : {}),
            generated: false,
            sensitive: false
          });
        }
        if (entries.length % 250 === 0) {
          if (priorEntries.length === 0) {
            state.index = { ...state.index, entries: [...entries], indexedEntries: entries.length };
          }
          await new Promise<void>((resolveYield) => setImmediate(resolveYield));
        }
        if (entries.length >= maxEntries) break;
      }
    }
    if (state.closed) return;
    if (state.revision.id !== revision.id) {
      state.index = {
        ...state.index,
        revision: state.revision,
        entries,
        entrypoints: entrypoints(entries),
        detectedStack: detectedStack(entries),
        indexedEntries: entries.length,
        status: 'stale',
        complete: false,
        truncated: pending.length > 0,
        updatedAt: new Date().toISOString()
      };
      recordIndexSnapshot(state.index, Date.now() - startedAt);
      scheduleBuild(rootPath, state, 0);
      return;
    }
    state.index = {
      workspaceId: workspaceId(rootPath),
      revision,
      generation,
      status: 'ready',
      complete: pending.length === 0,
      entries,
      entrypoints: entrypoints(entries),
      detectedStack: detectedStack(entries),
      indexedEntries: entries.length,
      truncated: pending.length > 0,
      updatedAt: new Date().toISOString(),
      coverage: indexCoverage(entries.length)
    };
    state.lastStableComplete = state.index.complete;
    recordIndexSnapshot(state.index, Date.now() - startedAt);
    queuePersistSnapshot(state);
  } catch (error) {
    state.index = {
      ...state.index,
      entries,
      indexedEntries: entries.length,
      status: 'failed',
      complete: false,
      updatedAt: new Date().toISOString(),
      errorCode: error instanceof Error ? error.name : 'INDEX_BUILD_FAILED'
    };
    recordIndexSnapshot(state.index, Date.now() - startedAt);
  }
}

async function persistSnapshot(state: ServerLocalWorkspaceState): Promise<void> {
  if (!state.cacheFile || state.closed) return;
  await mkdir(dirname(state.cacheFile), { recursive: true });
  if (state.closed) return;
  const temporary = `${state.cacheFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state.index)}\n`, { encoding: 'utf8', flag: 'wx' });
  if (state.closed) {
    await rm(temporary, { force: true });
    return;
  }
  await rename(temporary, state.cacheFile);
}

function queuePersistSnapshot(state: ServerLocalWorkspaceState): void {
  state.persistence = (state.persistence ?? Promise.resolve())
    .then(() => persistSnapshot(state))
    .catch(() => undefined);
}

function startWatcher(rootPath: string, state: ServerLocalWorkspaceState): void {
  try {
    state.watcher = watch(rootPath, { recursive: true, persistent: false }, (_event, filename) => {
      const path = filename?.toString().replace(/\\/g, '/') ?? '';
      if (path.split('/').some((part) => ignoredDirectories.has(part)) || isSensitiveWorkspacePath(path)) return;
      if (!path) {
        updateServerLocalWorkspaceRevision(rootPath, state);
        return;
      }
      scheduleIncrementalUpdate(rootPath, state, path);
    });
    state.watcher.on('error', () => {
      state.watcher?.close();
      state.watcher = undefined;
      updateServerLocalWorkspaceRevision(rootPath, state);
    });
  } catch {
    // Explicit provider writes still advance the revision where recursive watch is unavailable.
  }
}

function scheduleIncrementalUpdate(rootPath: string, state: ServerLocalWorkspaceState, path: string): void {
  if (state.closed) return;
  state.pendingPaths ??= new Set<string>();
  state.pendingPaths.add(path);
  state.revision = createWorkspaceRevision();
  state.index = {
    ...state.index,
    revision: state.revision,
    status: 'stale',
    complete: false,
    updatedAt: new Date().toISOString()
  };
  recordIndexSnapshot(state.index);
  scheduleIncrementalFlush(rootPath, state, 100);
}

function scheduleIncrementalFlush(rootPath: string, state: ServerLocalWorkspaceState, delayMs: number): void {
  if (state.closed) return;
  if (state.incrementalTimer) clearTimeout(state.incrementalTimer);
  state.incrementalTimer = setTimeout(() => {
    if (state.closed) return;
    state.incrementalTimer = undefined;
    if (state.incrementalBuild) {
      scheduleIncrementalFlush(rootPath, state, 25);
      return;
    }
    state.incrementalBuild = applyIncrementalUpdates(rootPath, state).finally(() => {
      state.incrementalBuild = undefined;
      if (state.pendingPaths?.size) scheduleIncrementalFlush(rootPath, state, 0);
    });
  }, delayMs);
  state.incrementalTimer.unref?.();
}

async function applyIncrementalUpdates(rootPath: string, state: ServerLocalWorkspaceState): Promise<void> {
  if (state.closed) return;
  const paths = [...(state.pendingPaths ?? [])];
  state.pendingPaths?.clear();
  const baseComplete = state.lastStableComplete ?? false;
  if (!paths.length) {
    return;
  }
  if (state.build || state.index.generation === 0 || state.index.status === 'building' || state.index.status === 'failed') {
    scheduleBuild(rootPath, state, 0);
    return;
  }

  const revision = state.revision;
  const byPath = new Map(state.index.entries.map((entry) => [entry.path, entry]));
  let requiresRebuild = false;
  for (const path of paths) {
    const previous = byPath.get(path);
    const metadata = await lstat(join(rootPath, path)).catch(() => undefined);
    if (!metadata || metadata.isSymbolicLink()) {
      removeIndexSubtree(byPath, path);
      continue;
    }
    if (metadata.isDirectory()) {
      if (!previous || previous.kind !== 'directory') removeIndexSubtree(byPath, path);
      byPath.set(path, {
        path,
        kind: 'directory',
        modifiedAt: metadata.mtime.toISOString(),
        generated: false,
        sensitive: false
      });
      if (!previous || previous.kind !== 'directory') requiresRebuild = true;
    } else if (metadata.isFile()) {
      byPath.delete(path);
      const language = languageForPath(path);
      byPath.set(path, {
        path,
        kind: 'file',
        size: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
        ...(language ? { language } : {}),
        generated: false,
        sensitive: false
      });
    }
  }

  if (state.revision.id !== revision.id) return;
  const entries = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  state.index = {
    workspaceId: workspaceId(rootPath),
    revision,
    generation: state.index.generation + 1,
    status: requiresRebuild ? 'stale' : 'ready',
    complete: baseComplete && !requiresRebuild,
    entries,
    entrypoints: entrypoints(entries),
    detectedStack: detectedStack(entries),
    indexedEntries: entries.length,
    truncated: state.index.truncated,
    updatedAt: new Date().toISOString(),
    coverage: indexCoverage(entries.length)
  };
  recordIndexSnapshot(state.index);
  queuePersistSnapshot(state);
  if (requiresRebuild) scheduleBuild(rootPath, state, 0);
}

function emptySnapshot(rootPath: string, revision: WorkspaceRevision): WorkspaceIndexSnapshot {
  return {
    workspaceId: workspaceId(rootPath),
    revision,
    generation: 0,
    status: 'empty',
    complete: false,
    entries: [],
    entrypoints: [],
    detectedStack: [],
    indexedEntries: 0,
    truncated: false,
    updatedAt: new Date().toISOString(),
    coverage: indexCoverage(0)
  };
}

function indexCoverage(indexedEntries: number) {
  return {
    visitedEntries: indexedEntries,
    indexedEntries,
    excludedGenerated: 0,
    sensitiveEntries: 0,
    skippedSymlinks: 0,
    failedEntries: 0
  };
}

function workspaceId(rootPath: string): string {
  const identity = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath;
  return `server-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function encodeCursor(index: number): string { return Buffer.from(String(index), 'utf8').toString('base64url'); }
function decodeCursor(cursor: string | undefined, total: number): number {
  if (!cursor) return 0;
  const value = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, total) : 0;
}

function languageForPath(path: string): string | undefined {
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', java: 'java', kt: 'kotlin', go: 'go', rs: 'rust', vue: 'vue', svelte: 'svelte', md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml' } as Record<string, string>)[extension] : undefined;
}

function entrypoints(entries: WorkspaceNavigationEntry[]): string[] {
  const preferred = new Set(['package.json', 'README.md', 'readme.md', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt']);
  return entries.filter((entry) => entry.kind === 'file' && preferred.has(entry.path)).map((entry) => entry.path).slice(0, 32);
}

function detectedStack(entries: WorkspaceNavigationEntry[]): string[] {
  const paths = new Set(entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path));
  return [
    ...(paths.has('package.json') ? ['node'] : []),
    ...(paths.has('pom.xml') || paths.has('build.gradle') || paths.has('build.gradle.kts') ? ['jvm'] : []),
    ...(paths.has('Cargo.toml') ? ['rust'] : []),
    ...(paths.has('go.mod') ? ['go'] : []),
    ...(paths.has('pyproject.toml') || paths.has('requirements.txt') ? ['python'] : [])
  ];
}

function recordIndexSnapshot(snapshot: WorkspaceIndexSnapshot, generationDurationMs?: number): void {
  workspaceMetrics.increment('workspace_index_status_total', 1, {
    providerKind: 'server_local',
    status: snapshot.status
  });
  workspaceMetrics.set('workspace_index_entries_total', snapshot.indexedEntries, {
    providerKind: 'server_local'
  });
  if (generationDurationMs !== undefined) {
    workspaceMetrics.observe('workspace_index_generation_duration_ms', generationDurationMs, {
      providerKind: 'server_local',
      status: snapshot.status
    });
  }
}

function removeIndexSubtree(
  entries: Map<string, WorkspaceNavigationEntry>,
  path: string
): void {
  for (const candidate of [...entries.keys()]) {
    if (candidate === path || candidate.startsWith(`${path}/`)) entries.delete(candidate);
  }
}
