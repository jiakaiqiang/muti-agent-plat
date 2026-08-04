import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type {
  ApplyChangeSetResult,
  FileHash,
  FileMetadata,
  ListDirectoryInput,
  ListDirectoryResult,
  LocalRuntimePermission,
  LocalRuntimePermissionPolicy,
  ReadFileInput,
  ReadFileResult,
  SearchTextInput,
  SearchTextResult,
  StatFileInput,
  WorkspaceChangeSet,
  WorkspaceChange,
  WorkspaceConflictError,
  WorkspaceIndexQueryInput,
  WorkspaceIndexQueryResult,
  WorkspaceIndexSnapshot,
  WorkspaceIndexSnapshotInput,
  WorkspaceIndexSnapshotPage,
  WorkspaceNavigationEntry,
  WorkspaceRevision
} from '@agent-cluster/shared';
import {
  DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY,
  isGeneratedWorkspaceDirectory,
  isSensitiveWorkspacePath,
  mergeWorkspaceText,
  WORKSPACE_MERGE_CONFLICT
} from '@agent-cluster/shared';
import type { LocalWorkspaceState } from './state.js';

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);
const indexEntryLimit = 100_000;
const indexYieldInterval = 250;
const locallyConfirmablePermissions = new Set<LocalRuntimePermission>([
  'workspace_delete',
  'command_execute',
  'dependency_install'
]);

export type LocalWorkspaceOptions = {
  hashFile?: (path: string) => Promise<FileHash>;
  watch?: boolean;
  index?: boolean;
  onIndexUpdated?: (snapshot: WorkspaceIndexSnapshot) => void | Promise<void>;
};

export async function createWorkspaceState(rootPath: string, displayName?: string): Promise<LocalWorkspaceState> {
  if (!isAbsolute(rootPath)) throw new Error('Workspace path must be absolute.');
  const canonical = await realpath(rootPath);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) throw new Error('Workspace path must be a directory.');
  if (resolve(canonical) === resolve(parse(canonical).root)) throw new Error('Filesystem roots cannot be authorized as workspaces.');
  if (samePath(canonical, homedir())) throw new Error('The user home directory cannot be authorized as a workspace.');
  if (await platformRepositoryAncestor(canonical)) {
    throw new Error('The Agent Cluster platform repository cannot be authorized as an Agent business workspace.');
  }
  return {
    workspaceId: randomUUID(),
    displayName: displayName?.trim() || basename(canonical),
    rootPath: canonical,
    permissions: { ...DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY },
    permissionPolicyVersion: 2,
    registeredAt: new Date().toISOString()
  };
}

export class LocalWorkspace {
  private writeTail = Promise.resolve();
  private currentRevision = nextWorkspaceRevision();
  private revisionWatcher?: FSWatcher;
  private indexRebuildTimer?: NodeJS.Timeout;
  private indexIncrementTimer?: NodeJS.Timeout;
  private indexIncrementBuild?: Promise<void>;
  private readonly pendingIndexPaths = new Set<string>();
  private lastStableIndexComplete: boolean;
  private indexBuild?: Promise<void>;
  private closed = false;
  private readonly hashFile: (path: string) => Promise<FileHash>;
  private readonly onIndexUpdated?: LocalWorkspaceOptions['onIndexUpdated'];

  constructor(readonly state: LocalWorkspaceState, options: LocalWorkspaceOptions = {}) {
    this.hashFile = options.hashFile ?? fileHash;
    this.onIndexUpdated = options.onIndexUpdated;
    this.lastStableIndexComplete = state.index?.complete ?? false;
    if (options.watch !== false) this.startRevisionWatcher();
    if (options.index !== false) queueMicrotask(() => this.scheduleIndexRebuild(options.onIndexUpdated, 0));
  }

  capabilities() {
    const permissions = this.permissionPolicy();
    return {
      read: permissions.workspace_read === 'allow',
      write: permissions.workspace_write === 'allow',
      command: permissions.command_execute === 'allow',
      test: permissions.test_execute === 'allow'
    } as const;
  }

  permissionPolicy(): LocalRuntimePermissionPolicy {
    const permissions = { ...this.state.permissions };
    for (const key of Object.keys(this.state.oneTimePermissions ?? {}) as Array<keyof LocalRuntimePermissionPolicy>) {
      if (this.state.oneTimePermissions?.[key]) permissions[key] = 'allow';
    }
    return permissions;
  }

  consumeOneTimePermissions() {
    const consumed = Object.keys(this.state.oneTimePermissions ?? {});
    delete this.state.oneTimePermissions;
    return consumed;
  }

  grantPermission(permission: LocalRuntimePermission, scope: 'once' | 'persistent' = 'once') {
    if (!locallyConfirmablePermissions.has(permission)) {
      throw new Error(`${permission} is managed by the default workspace policy and cannot be elevated here.`);
    }
    if (scope === 'once') {
      this.state.oneTimePermissions = { ...this.state.oneTimePermissions, [permission]: true };
      return;
    }
    this.state.permissions = { ...this.state.permissions, [permission]: 'allow' };
    if (this.state.oneTimePermissions) delete this.state.oneTimePermissions[permission];
  }

  async revision(): Promise<WorkspaceRevision> {
    return { ...this.currentRevision };
  }

  refreshRevision(): WorkspaceRevision {
    this.currentRevision = nextWorkspaceRevision();
    if (this.state.index) {
      this.state.index = {
        ...this.state.index,
        revision: this.currentRevision,
        status: 'stale',
        complete: false,
        updatedAt: new Date().toISOString()
      };
    }
    return { ...this.currentRevision };
  }

  close(): void {
    this.revisionWatcher?.close();
    this.revisionWatcher = undefined;
    if (this.indexRebuildTimer) clearTimeout(this.indexRebuildTimer);
    this.indexRebuildTimer = undefined;
    if (this.indexIncrementTimer) clearTimeout(this.indexIncrementTimer);
    this.indexIncrementTimer = undefined;
    this.closed = true;
  }

  async getIndexSnapshot(input: WorkspaceIndexSnapshotInput = {}): Promise<WorkspaceIndexSnapshotPage> {
    this.assertPermission('workspace_read');
    const snapshot = this.state.index ?? this.emptyIndexSnapshot('building');
    if (!this.state.index) this.state.index = snapshot;
    const limit = Math.min(2_000, Math.max(1, input.limit ?? 500));
    const offset = decodeIndexCursor(input.cursor, snapshot.entries.length);
    const entries = input.generation !== undefined && input.generation !== snapshot.generation
      ? []
      : snapshot.entries.slice(offset, offset + limit);
    const nextOffset = offset + entries.length;
    return {
      ...snapshot,
      entries,
      ...(nextOffset < snapshot.entries.length ? { nextCursor: encodeIndexCursor(nextOffset) } : {})
    };
  }

  async queryWorkspaceIndex(input: WorkspaceIndexQueryInput = {}): Promise<WorkspaceIndexQueryResult> {
    this.assertPermission('workspace_read');
    const snapshot = this.state.index ?? this.emptyIndexSnapshot('building');
    if (!this.state.index) this.state.index = snapshot;
    if (input.generation !== undefined && input.generation !== snapshot.generation) {
      return { ...snapshot, entries: [], matched: 0 };
    }
    const terms = [
      ...(input.pathHints ?? []),
      ...(input.symbols ?? []),
      ...(input.intent ? input.intent.split(/[^a-zA-Z0-9_./-]+/) : []),
      ...(input.query ? input.query.split(/[^a-zA-Z0-9_./-]+/) : [])
    ].map((term) => term.trim().toLowerCase()).filter((term) => term.length >= 2);
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    const entrypoints = new Set(snapshot.entrypoints.map((path) => path.toLowerCase()));
    const ranked = snapshot.entries
      .map((entry, order) => {
        const path = entry.path.toLowerCase();
        const matches = terms.filter((term) => path.includes(term) || term.includes(path));
        const score = matches.length * 10 + (entry.kind === 'file' ? 1 : 0) + (entrypoints.has(path) ? 5 : 0);
        return { entry, order, score, matchedTerms: matches.length };
      })
      .filter((item) => terms.length === 0 || item.matchedTerms > 0)
      .sort((left, right) => right.score - left.score || left.order - right.order);
    const candidates = Array.from(new Map(
      snapshot.entries
        .filter((entry) => entrypoints.has(entry.path.toLowerCase()))
        .concat(ranked.map((item) => item.entry))
        .concat(ranked.length ? [] : snapshot.entries)
        .map((entry) => [entry.path, entry])
    ).values());
    return { ...snapshot, entries: candidates.slice(0, limit), matched: ranked.length };
  }

  async listDirectory(input: ListDirectoryInput): Promise<ListDirectoryResult> {
    this.assertPermission('workspace_read');
    const revision = await this.revision();
    const root = await this.resolveExisting(input.path || '.', true);
    const baseDepth = segments(relative(this.state.rootPath, root)).length;
    const maxDepth = Math.max(0, input.maxDepth ?? (input.recursive ? 8 : 0));
    const offset = Math.max(0, Number.parseInt(input.cursor ?? '0', 10) || 0);
    const limit = Math.min(1000, Math.max(1, input.limit ?? 250));
    const targetCount = offset + limit + 1;
    const deadlineAt = input.deadlineMs ? Date.now() + Math.max(1, input.deadlineMs) : Number.POSITIVE_INFINITY;
    let deadlineReached = false;
    const all: FileMetadata[] = [];
    const visit = async (directory: string) => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (Date.now() >= deadlineAt) { deadlineReached = true; return; }
        if (all.length >= targetCount) return;
        if (entry.isSymbolicLink() || (entry.isDirectory() && ignoredDirectories.has(entry.name))) continue;
        const absolute = join(directory, entry.name);
        const path = relative(this.state.rootPath, absolute).replace(/\\/g, '/');
        if (isSensitiveWorkspacePath(path)) continue;
        const metadata = await stat(absolute);
        if (entry.isDirectory()) {
          all.push({ path, kind: 'directory', revision, modifiedAt: metadata.mtime.toISOString() });
          if (all.length >= targetCount) return;
          const depth = segments(relative(this.state.rootPath, absolute)).length - baseDepth;
          if (input.recursive && depth < maxDepth) await visit(absolute);
        } else {
          all.push({
            path,
            kind: 'file',
            size: metadata.size,
            revision,
            modifiedAt: metadata.mtime.toISOString()
          });
        }
      }
    };
    await visit(root);
    return {
      path: relative(this.state.rootPath, root).replace(/\\/g, '/') || '.',
      entries: all.slice(offset, offset + limit),
      revision,
      ...(all.length > offset + limit || deadlineReached ? { nextCursor: String(offset + limit) } : {})
    };
  }

  async statFile(input: StatFileInput): Promise<FileMetadata> {
    this.assertPermission('workspace_read');
    const absolute = await this.resolveExisting(input.path);
    const metadata = await stat(absolute);
    const revision = await this.revision();
    const path = normalizeRelative(input.path);
    return metadata.isDirectory()
      ? { path, kind: 'directory', revision, modifiedAt: metadata.mtime.toISOString() }
      : { path, kind: 'file', size: metadata.size, hash: await this.hashFile(absolute), revision, modifiedAt: metadata.mtime.toISOString() };
  }

  async readFile(input: ReadFileInput): Promise<ReadFileResult> {
    this.assertPermission('workspace_read');
    const absolute = await this.resolveExisting(input.path);
    const metadata = await stat(absolute);
    if (!metadata.isFile()) throw new Error('Requested path is not a file.');
    const maxBytes = Math.min(1_000_000, Math.max(1, input.maxBytes ?? 200_000));
    const lineRange = input.startLine !== undefined || input.endLine !== undefined;
    let content: string;
    let truncated = false;
    let startLine: number | undefined;
    let endLine: number | undefined;
    if (!lineRange) {
      const handle = await open(absolute, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(metadata.size, maxBytes + 1));
        const result = await handle.read(buffer, 0, buffer.byteLength, 0);
        const read = buffer.subarray(0, result.bytesRead);
        truncated = read.byteLength > maxBytes;
        content = read.subarray(0, maxBytes).toString('utf8');
      } finally {
        await handle.close();
      }
    } else {
      const targetStart = Math.max(1, input.startLine ?? 1);
      const targetEnd = Math.max(targetStart, input.endLine ?? Number.MAX_SAFE_INTEGER);
      const stream = createReadStream(absolute, { encoding: 'utf8', highWaterMark: 64 * 1024 });
      const reader = createInterface({ input: stream, crlfDelay: Infinity });
      const selected: string[] = [];
      let currentLine = 0;
      try {
        for await (const line of reader) {
          currentLine += 1;
          if (currentLine < targetStart) continue;
          if (currentLine > targetEnd) break;
          selected.push(line);
          if (Buffer.byteLength(selected.join('\n'), 'utf8') > maxBytes) {
            truncated = true;
            break;
          }
        }
      } finally {
        reader.close();
        stream.destroy();
      }
      content = Buffer.from(selected.join('\n'), 'utf8').subarray(0, maxBytes).toString('utf8');
      startLine = targetStart;
      endLine = Math.max(targetStart, targetStart + selected.length - 1);
    }
    const returnedBuffer = Buffer.from(content, 'utf8');
    const fullRead = !lineRange && !truncated && returnedBuffer.byteLength === metadata.size;
    return {
      path: normalizeRelative(input.path),
      content,
      encoding: 'utf-8',
      byteLength: Buffer.byteLength(content),
      truncated,
      revision: await this.revision(),
      ...(fullRead ? { hash: hashBuffer(returnedBuffer) } : {}),
      rangeHash: hashBuffer(returnedBuffer),
      fileSize: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {})
    };
  }

  async searchText(input: SearchTextInput): Promise<SearchTextResult> {
    this.assertPermission('workspace_read');
    const query = input.caseSensitive ? input.query : input.query.toLowerCase();
    if (!query) throw new Error('Search query is required.');
    const deadlineAt = input.deadlineMs ? Date.now() + Math.max(1, input.deadlineMs) : Number.POSITIVE_INFINITY;
    const listed = await this.listDirectory({ path: input.path, recursive: true, maxDepth: 12, limit: 10_000, deadlineMs: input.deadlineMs });
    const matches: SearchTextResult['matches'] = [];
    const maxResults = Math.min(1000, Math.max(1, input.maxResults ?? 100));
    for (const entry of listed.entries) {
      if (Date.now() >= deadlineAt) return { matches, truncated: true, revision: await this.revision() };
      if (entry.kind !== 'file' || !matchesGlob(entry.path, input.include, input.exclude)) continue;
      if (entry.size > 500_000) continue;
      const content = await readFile(await this.resolveExisting(entry.path), 'utf8').catch(() => '');
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (Date.now() >= deadlineAt) return { matches, truncated: true, revision: await this.revision() };
        const source = input.caseSensitive ? lines[index] : lines[index].toLowerCase();
        const column = source.indexOf(query);
        if (column < 0) continue;
        matches.push({ path: entry.path, line: index + 1, column: column + 1, preview: lines[index].slice(0, 500) });
        if (matches.length >= maxResults) {
          return { matches, truncated: true, revision: await this.revision() };
        }
      }
    }
    return { matches, truncated: false, revision: await this.revision() };
  }

  async applyChangeSet(
    changeSet: WorkspaceChangeSet,
    permissions: LocalRuntimePermissionPolicy = this.state.permissions
  ): Promise<ApplyChangeSetResult> {
    const operation = this.writeTail.then(() => this.applyChangeSetLocked(changeSet, permissions));
    this.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async applyChangeSetLocked(
    changeSet: WorkspaceChangeSet,
    permissions: LocalRuntimePermissionPolicy
  ): Promise<ApplyChangeSetResult> {
    this.assertPermission('workspace_write', permissions);
    const revision = await this.revision();
    const mergedChanges: WorkspaceChange[] = [];
    const conflicts: WorkspaceConflictError[] = [];
    for (const change of changeSet.changes) {
      if (change.operation === 'delete' || change.operation === 'move') {
        if (permissions.workspace_delete !== 'allow') {
          throw new Error('LOCAL_CONFIRMATION_REQUIRED: workspace_delete');
        }
      }
      const merged = await this.mergeChange(changeSet, change, revision);
      if (merged.conflict) {
        conflicts.push(merged.conflict);
        continue;
      }
      if (!merged.change) continue;
      const detected = await this.validateChange(changeSet, merged.change, revision);
      if (detected) conflicts.push(detected);
      else mergedChanges.push(merged.change);
    }
    if (conflicts.length) return { ok: false, changeSetId: changeSet.id, revision, conflicts };
    const snapshots = await Promise.all(this.changePaths(mergedChanges).map((path) => this.snapshotChangePath(path)));
    const snapshotByPath = new Map(snapshots.map((entry) => [entry.path, entry]));
    const appliedStates = new Map<string, { path: string; content?: Buffer }>();
    try {
      for (const change of mergedChanges) {
        const currentRevision = await this.revision();
        const changedDuringApply = await this.validateChange(changeSet, change, currentRevision);
        if (changedDuringApply) {
          throw new Error(`LOCAL_WORKSPACE_CONFLICT_DURING_APPLY: ${changedDuringApply.path}: ${changedDuringApply.message}`);
        }
        if (change.operation === 'create' || change.operation === 'update') {
          const target = await this.resolveTarget(change.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFileAtomic(target, change.content);
          appliedStates.set(change.path, { path: change.path, content: Buffer.from(change.content, 'utf8') });
        } else if (change.operation === 'delete') {
          await rm(await this.resolveExisting(change.path), { force: false });
          appliedStates.set(change.path, { path: change.path });
        } else {
          const target = await this.resolveTarget(change.toPath);
          await mkdir(dirname(target), { recursive: true });
          await rename(await this.resolveExisting(change.fromPath), target);
          const source = snapshotByPath.get(change.fromPath);
          if (!source?.content) throw new Error(`Move source snapshot is unavailable: ${change.fromPath}`);
          appliedStates.set(change.fromPath, { path: change.fromPath });
          appliedStates.set(change.toPath, { path: change.toPath, content: source.content });
        }
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const original of snapshots) {
        const expected = appliedStates.get(original.path);
        if (!expected) continue;
        const current = await this.snapshotChangePath(original.path).catch((cause) => {
          rollbackErrors.push(`${original.path}: cannot inspect current state (${String(cause)})`);
          return undefined;
        });
        if (!current) continue;
        if (!sameLocalSnapshot(current, expected)) {
          rollbackErrors.push(`${original.path}: changed after the batch write; automatic rollback was skipped`);
          continue;
        }
        await this.restoreChangePath(original).catch((cause) => {
          rollbackErrors.push(`${original.path}: rollback failed (${String(cause)})`);
        });
      }
      if (rollbackErrors.length) {
        throw new Error(`LOCAL_WORKSPACE_ROLLBACK_REQUIRES_ATTENTION: ${rollbackErrors.join('; ')}`, { cause: error });
      }
      throw error;
    }
    const appliedRevision = this.refreshRevision();
    return {
      ok: true,
      revision: appliedRevision,
      changeSetId: changeSet.id,
      appliedCount: mergedChanges.length
    };
  }

  private changePaths(changes: WorkspaceChange[]) {
    return [...new Set(changes.flatMap((change) =>
      change.operation === 'move' ? [change.fromPath, change.toPath] : [change.path]
    ))];
  }

  private async snapshotChangePath(path: string): Promise<{ path: string; content?: Buffer }> {
    const target = await this.resolveTarget(path);
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile()) throw new Error(`Workspace write target is not a file: ${path}`);
      return { path, content: await readFile(target) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path };
      throw error;
    }
  }

  private async restoreChangePath(snapshot: { path: string; content?: Buffer }) {
    const target = await this.resolveTarget(snapshot.path);
    if (snapshot.content === undefined) {
      await rm(target, { force: true });
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFileAtomic(target, snapshot.content);
  }

  private async mergeChange(
    changeSet: WorkspaceChangeSet,
    change: WorkspaceChange,
    revision: WorkspaceRevision
  ): Promise<{ change?: WorkspaceChange; conflict?: WorkspaceConflictError }> {
    if (change.operation !== 'update' || change.baseContent === undefined) return { change };
    const target = await this.resolveExisting(change.path).catch(() => undefined);
    if (!target) return { change };
    const actualHash = await this.hashFile(target);
    if (actualHash.value === change.expectedHash.value) return { change };
    const current = await readFile(target, 'utf8').catch(() => undefined);
    if (current === undefined) return { change };
    const merged = mergeWorkspaceText(change.baseContent, current, change.content);
    if (!merged.ok) {
      return {
        conflict: {
          ...conflict(
            changeSet,
            change.operation,
            change.path,
            revision,
            `Current and Session changes overlap: ${change.path}`,
            change.expectedHash,
            actualHash
          ),
          code: WORKSPACE_MERGE_CONFLICT
        }
      };
    }
    if (merged.content === current) return {};
    return { change: { ...change, content: merged.content, expectedHash: actualHash } };
  }

  private startRevisionWatcher(): void {
    try {
      this.revisionWatcher = watch(
        this.state.rootPath,
        { recursive: true, persistent: false },
        (_eventType, filename) => {
          if (filename && isIgnoredRevisionPath(filename.toString())) return;
          if (!filename) {
            this.refreshRevision();
            this.scheduleIndexRebuild(undefined, 0);
            return;
          }
          this.scheduleIncrementalIndexUpdate(filename.toString());
        }
      );
      this.revisionWatcher.on('error', () => {
        this.revisionWatcher?.close();
        this.revisionWatcher = undefined;
        this.refreshRevision();
        this.scheduleIndexRebuild(undefined, 0);
      });
    } catch {
      // Explicit Local Runtime writes still advance the revision on platforms without recursive watch support.
    }
  }

  private scheduleIncrementalIndexUpdate(rawPath: string): void {
    let path: string;
    try {
      path = normalizeRelative(rawPath.replace(/\\/g, '/'));
    } catch {
      this.refreshRevision();
      this.scheduleIndexRebuild(undefined, 0);
      return;
    }
    if (isIgnoredRevisionPath(path) || isSensitiveWorkspacePath(path)) return;
    this.pendingIndexPaths.add(path);
    this.refreshRevision();
    this.scheduleIncrementalIndexFlush(100);
  }

  private scheduleIncrementalIndexFlush(delayMs: number): void {
    if (this.indexIncrementTimer) clearTimeout(this.indexIncrementTimer);
    this.indexIncrementTimer = setTimeout(() => {
      this.indexIncrementTimer = undefined;
      if (this.indexIncrementBuild) {
        this.scheduleIncrementalIndexFlush(25);
        return;
      }
      this.indexIncrementBuild = this.applyIncrementalIndexUpdates().finally(() => {
        this.indexIncrementBuild = undefined;
        if (this.pendingIndexPaths.size) this.scheduleIncrementalIndexFlush(0);
      });
    }, delayMs);
    this.indexIncrementTimer.unref?.();
  }

  private async applyIncrementalIndexUpdates(): Promise<void> {
    const paths = [...this.pendingIndexPaths];
    this.pendingIndexPaths.clear();
    const baseComplete = this.lastStableIndexComplete;
    const current = this.state.index;
    if (!paths.length || this.closed) {
      return;
    }
    if (!current || this.indexBuild || current.generation === 0 || current.status === 'building' || current.status === 'failed') {
      this.scheduleIndexRebuild(undefined, 0);
      return;
    }

    const revision = await this.revision();
    const byPath = new Map(current.entries.map((entry) => [entry.path, entry]));
    let requiresRebuild = false;
    for (const path of paths) {
      const previous = byPath.get(path);
      const metadata = await lstat(join(this.state.rootPath, path)).catch(() => undefined);
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

    if (this.closed || this.currentRevision.id !== revision.id) return;
    const entries = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
    const snapshot: WorkspaceIndexSnapshot = {
      workspaceId: this.state.workspaceId,
      revision,
      generation: current.generation + 1,
      status: requiresRebuild ? 'stale' : 'ready',
      complete: baseComplete && !requiresRebuild,
      entries,
      entrypoints: deriveIndexEntrypoints(entries),
      detectedStack: detectStack(entries),
      indexedEntries: entries.length,
      truncated: current.truncated,
      updatedAt: new Date().toISOString(),
      coverage: {
        visitedEntries: entries.length,
        indexedEntries: entries.length,
        excludedGenerated: 0,
        sensitiveEntries: 0,
        skippedSymlinks: 0,
        failedEntries: 0
      }
    };
    this.state.index = snapshot;
    await this.onIndexUpdated?.(snapshot);
    if (requiresRebuild) this.scheduleIndexRebuild(undefined, 0);
  }

  private async validateChange(
    changeSet: WorkspaceChangeSet,
    change: WorkspaceChange,
    revision: WorkspaceRevision
  ): Promise<WorkspaceConflictError | undefined> {
    const path = change.operation === 'move' ? change.fromPath : change.path;
    if (change.operation === 'create') {
      const target = await this.resolveTarget(change.path);
      return await exists(target)
        ? conflict(changeSet, change.operation, change.path, revision, 'Target already exists.')
        : undefined;
    }
    const target = await this.resolveExisting(path).catch(() => undefined);
    if (!target) return conflict(changeSet, change.operation, path, revision, 'Target does not exist.');
    const actualHash = await this.hashFile(target);
    if (actualHash.value !== change.expectedHash.value) {
      return conflict(changeSet, change.operation, path, revision, 'File hash changed.', change.expectedHash, actualHash);
    }
    if (change.operation === 'move') {
      const destination = await this.resolveTarget(change.toPath);
      if (await exists(destination)) {
        return conflict(changeSet, change.operation, change.toPath, revision, 'Move destination already exists.');
      }
    }
    return undefined;
  }

  private assertPermission(
    key: keyof LocalRuntimePermissionPolicy,
    permissions: LocalRuntimePermissionPolicy = this.state.permissions
  ) {
    const policy = permissions[key];
    if (policy !== 'allow') {
      throw new Error(policy === 'confirm' ? `LOCAL_CONFIRMATION_REQUIRED: ${key}` : `LOCAL_PERMISSION_DENIED: ${key}`);
    }
  }

  private async resolveExisting(path: string, directory = false) {
    const target = await this.resolveTarget(path);
    const canonical = await realpath(target);
    assertInside(this.state.rootPath, canonical);
    const metadata = await lstat(canonical);
    if (metadata.isSymbolicLink()) throw new Error('Symbolic links are not allowed in Local Runtime workspaces.');
    if (directory && !metadata.isDirectory()) throw new Error('Requested path is not a directory.');
    return canonical;
  }

  private async resolveTarget(path: string) {
    const normalized = normalizeRelative(path);
    if (isSensitiveWorkspacePath(normalized)) throw new Error(`Sensitive path access denied: ${normalized}`);
    const target = resolve(this.state.rootPath, ...segments(normalized));
    assertInside(this.state.rootPath, target);
    await assertNoSymlinkPath(this.state.rootPath, target);
    return target;
  }

  private scheduleIndexRebuild(
    onIndexUpdated?: LocalWorkspaceOptions['onIndexUpdated'],
    delayMs = 250
  ): void {
    if (this.closed) return;
    if (this.indexRebuildTimer) clearTimeout(this.indexRebuildTimer);
    this.indexRebuildTimer = setTimeout(() => {
      this.indexRebuildTimer = undefined;
      if (this.indexBuild) {
        this.scheduleIndexRebuild(onIndexUpdated, delayMs);
        return;
      }
      this.indexBuild = this.rebuildIndex(onIndexUpdated ?? this.onIndexUpdated).finally(() => {
        this.indexBuild = undefined;
      });
    }, delayMs);
    this.indexRebuildTimer.unref?.();
  }

  private async rebuildIndex(onIndexUpdated?: LocalWorkspaceOptions['onIndexUpdated']): Promise<void> {
    const revision = await this.revision();
    const generation = (this.state.index?.generation ?? 0) + 1;
    const startedAt = new Date().toISOString();
    const entries: WorkspaceNavigationEntry[] = [];
    const pending = [this.state.rootPath];
    this.state.index = {
      workspaceId: this.state.workspaceId,
      revision,
      generation,
      status: 'building',
      complete: false,
      entries,
      entrypoints: [],
      detectedStack: [],
      indexedEntries: 0,
      truncated: false,
      updatedAt: startedAt,
      coverage: {
        visitedEntries: 0,
        indexedEntries: 0,
        excludedGenerated: 0,
        sensitiveEntries: 0,
        skippedSymlinks: 0,
        failedEntries: 0
      }
    };
    try {
      while (pending.length && entries.length < indexEntryLimit && !this.closed) {
        const directory = pending.shift()!;
        const children = await readdir(directory, { withFileTypes: true });
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
          if (child.isSymbolicLink()) continue;
          const absolute = join(directory, child.name);
          const path = relative(this.state.rootPath, absolute).replace(/\\/g, '/');
          if (isSensitiveWorkspacePath(path)) continue;
          if (child.isDirectory() && (ignoredDirectories.has(child.name) || isGeneratedWorkspaceDirectory(child.name))) {
            continue;
          }
          const metadata = await stat(absolute).catch(() => undefined);
          if (!metadata) continue;
          if (child.isDirectory()) {
            entries.push({
              path,
              kind: 'directory',
              modifiedAt: metadata.mtime.toISOString(),
              generated: false,
              sensitive: false
            });
            pending.push(absolute);
          } else if (child.isFile()) {
            entries.push({
              path,
              kind: 'file',
              size: metadata.size,
              modifiedAt: metadata.mtime.toISOString(),
              ...(languageForPath(path) ? { language: languageForPath(path) } : {}),
              generated: false,
              sensitive: false
            });
          }
          if (entries.length % indexYieldInterval === 0) {
            this.state.index = { ...this.state.index!, entries: [...entries], indexedEntries: entries.length };
            await yieldToEventLoop();
          }
          if (entries.length >= indexEntryLimit) break;
        }
      }
      const finalSnapshot: WorkspaceIndexSnapshot = {
        workspaceId: this.state.workspaceId,
        revision,
        generation,
        status: 'ready',
        complete: pending.length === 0,
        entries,
        entrypoints: deriveIndexEntrypoints(entries),
        detectedStack: detectStack(entries),
        indexedEntries: entries.length,
        truncated: pending.length > 0,
        updatedAt: new Date().toISOString(),
        coverage: {
          visitedEntries: entries.length,
          indexedEntries: entries.length,
          excludedGenerated: 0,
          sensitiveEntries: 0,
          skippedSymlinks: 0,
          failedEntries: 0
        }
      };
      this.state.index = finalSnapshot;
      this.lastStableIndexComplete = finalSnapshot.complete;
      await onIndexUpdated?.(finalSnapshot);
    } catch (error) {
      const failed: WorkspaceIndexSnapshot = {
        ...(this.state.index ?? this.emptyIndexSnapshot('failed')),
        revision,
        generation,
        status: 'failed',
        complete: false,
        entries: [...entries],
        indexedEntries: entries.length,
        updatedAt: new Date().toISOString(),
        errorCode: error instanceof Error ? error.name : 'INDEX_BUILD_FAILED'
      };
      this.state.index = failed;
      await onIndexUpdated?.(failed);
    }
  }

  private emptyIndexSnapshot(status: WorkspaceIndexSnapshot['status']): WorkspaceIndexSnapshot {
    return {
      workspaceId: this.state.workspaceId,
      revision: this.currentRevision,
      generation: 0,
      status,
      complete: false,
      entries: [],
      entrypoints: [],
      detectedStack: [],
      indexedEntries: 0,
      truncated: false,
      updatedAt: new Date().toISOString(),
      coverage: {
        visitedEntries: 0,
        indexedEntries: 0,
        excludedGenerated: 0,
        sensitiveEntries: 0,
        skippedSymlinks: 0,
        failedEntries: 0
      }
    };
  }
}

function sameLocalSnapshot(left: { content?: Buffer }, right: { content?: Buffer }) {
  if (left.content === undefined || right.content === undefined) return left.content === right.content;
  return left.content.equals(right.content);
}

function encodeIndexCursor(index: number): string {
  return Buffer.from(String(index), 'utf8').toString('base64url');
}

function removeIndexSubtree(entries: Map<string, WorkspaceNavigationEntry>, path: string): void {
  for (const candidate of [...entries.keys()]) {
    if (candidate === path || candidate.startsWith(`${path}/`)) entries.delete(candidate);
  }
}

function decodeIndexCursor(cursor: string | undefined, total: number): number {
  if (!cursor) return 0;
  const decoded = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isFinite(decoded) && decoded >= 0 ? Math.min(decoded, total) : 0;
}

function languageForPath(path: string): string | undefined {
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', java: 'java', kt: 'kotlin', go: 'go', rs: 'rust', vue: 'vue', svelte: 'svelte', md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml' } as Record<string, string>)[extension] : undefined;
}

function deriveIndexEntrypoints(entries: WorkspaceNavigationEntry[]): string[] {
  const preferred = new Set(['package.json', 'README.md', 'readme.md', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt']);
  return entries.filter((entry) => entry.kind === 'file' && preferred.has(entry.path)).map((entry) => entry.path).slice(0, 32);
}

function detectStack(entries: WorkspaceNavigationEntry[]): string[] {
  const paths = new Set(entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path));
  return [
    ...(paths.has('package.json') ? ['node'] : []),
    ...(paths.has('pom.xml') || paths.has('build.gradle') || paths.has('build.gradle.kts') ? ['jvm'] : []),
    ...(paths.has('Cargo.toml') ? ['rust'] : []),
    ...(paths.has('go.mod') ? ['go'] : []),
    ...(paths.has('pyproject.toml') || paths.has('requirements.txt') ? ['python'] : [])
  ];
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolveYield) => setImmediate(resolveYield));
}

function nextWorkspaceRevision(): WorkspaceRevision {
  return { id: randomUUID(), observedAt: new Date().toISOString() };
}

function isIgnoredRevisionPath(value: string) {
  const path = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = path.split('/').filter(Boolean);
  return parts.some((part) => ignoredDirectories.has(part)) || isSensitiveWorkspacePath(path);
}

export function normalizeRelative(value: string) {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.') return '.';
  if (isAbsolute(value) || /^[A-Za-z]:/.test(normalized)) throw new Error('Absolute paths are not allowed.');
  const parts = segments(normalized);
  if (parts.some((part) => part === '..' || part === '.')) throw new Error('Path traversal is not allowed.');
  return parts.join('/');
}

function segments(value: string) { return value.split(/[\\/]+/).filter(Boolean); }

function assertInside(root: string, target: string) {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const left = process.platform === 'win32' ? normalizedTarget.toLowerCase() : normalizedTarget;
  const right = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (left !== right && !left.startsWith(`${right}${sep}`)) throw new Error('Workspace boundary violation.');
}

async function assertNoSymlinkPath(root: string, target: string) {
  const parts = segments(relative(root, target));
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic link access denied: ${relative(root, current)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function fileHash(path: string): Promise<FileHash> {
  return hashBuffer(await readFile(path));
}

function hashBuffer(data: Buffer): FileHash {
  return { algorithm: 'sha256', value: createHash('sha256').update(data).digest('hex') };
}

async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function writeFileAtomic(path: string, content: string | Uint8Array) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx' });
  await rename(temporary, path);
}

function conflict(
  set: WorkspaceChangeSet,
  operation: WorkspaceConflictError['operation'],
  path: string,
  revision: WorkspaceRevision,
  message: string,
  baseHash?: FileHash,
  actualHash?: FileHash
): WorkspaceConflictError {
  return { code: 'WORKSPACE_BASE_HASH_MISMATCH', message, changeSetId: set.id, operation, path, actualRevision: revision, ...(baseHash ? { baseHash } : {}), ...(actualHash ? { actualHash } : {}) };
}

function matchesGlob(path: string, include?: string[], exclude?: string[]) {
  const matches = (pattern: string) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i').test(path);
  };
  return (!include?.length || include.some(matches)) && !exclude?.some(matches);
}

async function looksLikePlatformRepository(path: string) {
  return (await exists(join(path, 'apps', 'server', 'src'))) && (await exists(join(path, 'packages', 'shared', 'src')));
}

async function platformRepositoryAncestor(path: string) {
  const configuredRoot = process.env.AGENT_CLUSTER_PLATFORM_ROOT?.trim();
  if (configuredRoot && isAbsolute(configuredRoot)) {
    const canonicalRoot = await realpath(configuredRoot).catch(() => undefined);
    if (canonicalRoot && isInsideOrSame(canonicalRoot, path)) return canonicalRoot;
  }

  let current = resolve(path);
  while (true) {
    if (await looksLikePlatformRepository(current)) return current;
    const parent = dirname(current);
    if (samePath(parent, current)) return undefined;
    current = parent;
  }
}

function isInsideOrSame(root: string, target: string) {
  const normalizedRoot = normalizeForComparison(root);
  const normalizedTarget = normalizeForComparison(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

function normalizeForComparison(path: string) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string) {
  return normalizeForComparison(left) === normalizeForComparison(right);
}
