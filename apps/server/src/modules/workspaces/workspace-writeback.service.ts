import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ConflictFileView,
  ConflictView,
  FileHash,
  ResolveWorkspaceWritebackInput,
  RuntimeWorkspaceExecution,
  SessionDetail,
  WorkspaceChange,
  WorkspaceChangeSet,
  WorkspaceConflictError,
  WorkspaceProviderKind,
  WorkspaceWritebackRecord
} from '@agent-cluster/shared';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import type { WorkspaceProvider } from './workspace-provider.js';
import { WorkspaceProviderResolver } from './workspace-provider-resolver.js';

const COLLECTION = 'workspaceWritebacks';
const MAX_CONFLICT_TEXT_BYTES = 512 * 1024;
type StoredWriteback = WorkspaceWritebackRecord & {
  conflictView?: ConflictView;
  conflictObservedHashes?: Record<string, string | null>;
};

@Injectable()
export class WorkspaceWritebackService {
  private readonly records = new Map<string, StoredWriteback>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly resolutionTails = new Map<string, Promise<unknown>>();
  private readonly activeOperations = new Map<string, Promise<WorkspaceWritebackRecord>>();
  private readonly lifecycle: SessionLifecycleStore;

  constructor(
    private readonly persistence: PersistenceService,
    private readonly providers: WorkspaceProviderResolver
  ) {
    this.lifecycle = new SessionLifecycleStore(persistence);
    let recovered = false;
    for (const record of persistence.getCollection<StoredWriteback[]>(COLLECTION, [])) {
      if (['queued', 'merging', 'applying'].includes(record.status)) {
        record.status = 'failed';
        record.error = 'Workspace writeback was interrupted by a backend restart. Retry merge to continue.';
        record.updatedAt = new Date().toISOString();
        recovered = true;
      }
      if (record.status === 'conflicted' && !record.conflictView) {
        record.status = 'failed';
        record.error = 'Workspace conflict predates the editor. Retry merge to rebuild its file snapshots.';
        record.updatedAt = new Date().toISOString();
        recovered = true;
      }
      this.records.set(record.id, record);
    }
    if (recovered) void this.persist().catch(() => undefined);
  }

  list(sessionId: string) {
    return [...this.records.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(publicRecord);
  }

  async clearSessionDrafts(sessionId: string) {
    if ([...this.activeOperations.keys()].some((id) => this.records.get(id)?.sessionId === sessionId)) {
      throw new ConflictException('WORKSPACE_WRITEBACK_ACTIVE');
    }
    const previous: Array<{ record: StoredWriteback; snapshot: StoredWriteback }> = [];
    for (const record of this.records.values()) {
      if (record.sessionId !== sessionId || !record.conflictView) continue;
      previous.push({ record, snapshot: structuredClone(record) });
      record.conflictView = undefined;
      record.conflictObservedHashes = undefined;
      if (record.status === 'conflicted' || record.status === 'failed') {
        record.status = 'abandoned';
        record.resolution = 'abandon_writeback';
        record.conflicts = [];
        record.error = undefined;
      }
      record.updatedAt = new Date().toISOString();
    }
    if (!previous.length) return;
    try { await this.persist(); }
    catch (error) {
      for (const { record, snapshot } of previous) Object.assign(record, snapshot);
      throw error;
    }
  }

  hasConflict(sessionId: string, conflictId: string) {
    const record = this.records.get(conflictId);
    return record?.sessionId === sessionId && ['conflicted', 'failed'].includes(record.status) &&
      Boolean(record.conflictView);
  }

  conflictView(sessionId: string, conflictId: string): ConflictView {
    const record = this.requireConflict(sessionId, conflictId);
    return structuredClone(record.conflictView!);
  }

  async saveConflictFile(sessionId: string, conflictId: string, fileId: string, input: {
    expectedVersion: number; resultContent?: string; binaryChoice?: 'ours' | 'theirs'; confirm: boolean;
  }): Promise<ConflictView> {
    const record = this.requireConflict(sessionId, conflictId);
    return this.serializeResolution(record, async () => {
      this.requireConflict(sessionId, conflictId);
      const view = record.conflictView!;
      if (view.version !== input.expectedVersion) throw new ConflictException('WORKSPACE_CONFLICT_VERSION_CONFLICT');
      const file = view.files.find((item) => item.fileId === fileId);
      if (!file) throw new NotFoundException('Workspace conflict file not found.');
      if (file.status === 'confirmed') throw new ConflictException('WORKSPACE_CONFLICT_FILE_CONFIRMED');
      if (file.kind === 'text') {
        if (typeof input.resultContent !== 'string' ||
            Buffer.byteLength(input.resultContent, 'utf8') > MAX_CONFLICT_TEXT_BYTES) {
          throw new BadRequestException('A complete conflict result within the size limit is required.');
        }
        if (input.confirm && containsConflictMarkers(input.resultContent)) {
          throw new BadRequestException('Unresolved conflict markers remain in the result.');
        }
        file.resultContent = input.resultContent;
      } else {
        if (input.binaryChoice !== 'ours' && input.binaryChoice !== 'theirs') {
          throw new BadRequestException('A version choice is required for this conflict.');
        }
        file.binaryChoice = input.binaryChoice;
      }
      file.status = input.confirm ? 'confirmed' : 'draft';
      file.version += 1;
      view.version += 1;
      view.updatedAt = new Date().toISOString();
      await this.persist();
      return structuredClone(view);
    });
  }

  async enqueue(input: {
    session: SessionDetail;
    taskId?: string;
    invocationId: string;
    execution: RuntimeWorkspaceExecution;
    resultSummary?: string;
  }): Promise<WorkspaceWritebackRecord> {
    const sessionGeneration = this.lifecycle.generation(input.session.id);
    this.assertActiveGeneration(input.session.id, sessionGeneration);
    const existing = input.execution.writeback?.id
      ? this.records.get(input.execution.writeback.id)
      : [...this.records.values()].find((record) => record.changeSet.id === input.execution.changeSet.id);
    if (existing) {
      this.assertActiveGeneration(existing.sessionId, existing.sessionGeneration);
      return ['queued', 'merging', 'applying'].includes(existing.status)
        ? this.runSerialized(existing, input.session, false)
        : publicRecord(existing);
    }
    const now = new Date().toISOString();
    const record: StoredWriteback = {
      id: crypto.randomUUID(),
      sessionId: input.session.id,
      ...(sessionGeneration !== undefined ? { sessionGeneration } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      invocationId: input.invocationId,
      workspaceId: input.session.workspaceId,
      providerKind: input.session.workspaceContext?.binding.providerKind ?? 'server_local',
      changeSet: input.execution.changeSet,
      ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
      status: 'queued',
      conflicts: [],
      createdAt: now,
      updatedAt: now
    };
    this.records.set(record.id, record);
    const operation = this.persist()
      .then(() => this.scheduleSerialized(record, input.session, false))
      .catch((error) => {
        if (record.status === 'queued') this.records.delete(record.id);
        throw error;
      });
    this.activeOperations.set(record.id, operation);
    try {
      return await operation;
    } finally {
      if (this.activeOperations.get(record.id) === operation) this.activeOperations.delete(record.id);
    }
  }

  async resolve(
    session: SessionDetail,
    writebackId: string,
    input: ResolveWorkspaceWritebackInput,
    authorizeResolvedDelete?: (changeSet: WorkspaceChangeSet) => Promise<void>
  ): Promise<WorkspaceWritebackRecord> {
    const record = this.records.get(writebackId);
    if (!record || record.sessionId !== session.id) throw new NotFoundException('Workspace writeback not found.');
    this.assertActiveGeneration(record.sessionId, record.sessionGeneration);
    return this.serializeResolution(record, () => this.resolveLocked(record, session, input, authorizeResolvedDelete));
  }

  private async serializeResolution<T>(record: StoredWriteback, work: () => Promise<T>): Promise<T> {
    const previous = this.resolutionTails.get(record.id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(work);
    this.resolutionTails.set(record.id, operation);
    try { return await operation; }
    finally { if (this.resolutionTails.get(record.id) === operation) this.resolutionTails.delete(record.id); }
  }

  private async resolveLocked(
    record: StoredWriteback,
    session: SessionDetail,
    input: ResolveWorkspaceWritebackInput,
    authorizeResolvedDelete?: (changeSet: WorkspaceChangeSet) => Promise<void>
  ): Promise<WorkspaceWritebackRecord> {
    if (!['conflicted', 'failed'].includes(record.status)) {
      throw new BadRequestException(`Workspace writeback cannot be resolved from status ${record.status}.`);
    }
    if (input.action === 'keep_workspace' || input.action === 'abandon_writeback') {
      return this.update(record, { status: 'abandoned', resolution: input.action, conflicts: [],
        conflictView: undefined, conflictObservedHashes: undefined });
    }
    if (input.action === 'resolve_with_agent') {
      return this.update(record, { status: 'abandoned', resolution: input.action, conflicts: [],
        conflictView: undefined, conflictObservedHashes: undefined });
    }
    if (input.action === 'use_session' && input.confirmationId !== record.id) {
      throw new BadRequestException('The current writeback id is required to confirm applying the Session version.');
    }
    if (input.action === 'use_session' && record.status === 'conflicted' && record.conflictView) {
      throw new BadRequestException('Use the conflict editor to confirm each workspace file.');
    }
    if (input.action === 'apply_conflict') {
      return this.applyConfirmedConflict(record, session, input.expectedConflictVersion, authorizeResolvedDelete);
    }
    await this.update(record, { status: 'queued', resolution: input.action, error: undefined });
    return this.runSerialized(record, session, input.action === 'use_session');
  }

  private async runSerialized(record: StoredWriteback, session: SessionDetail, force: boolean,
    resolvedChangeSet?: WorkspaceChangeSet) {
    const active = this.activeOperations.get(record.id);
    if (active) return active;
    const operation = this.scheduleSerialized(record, session, force, resolvedChangeSet);
    this.activeOperations.set(record.id, operation);
    try {
      return await operation;
    } finally {
      if (this.activeOperations.get(record.id) === operation) this.activeOperations.delete(record.id);
    }
  }

  private async scheduleSerialized(record: StoredWriteback, session: SessionDetail, force: boolean,
    resolvedChangeSet?: WorkspaceChangeSet) {
    const previous = this.tails.get(record.workspaceId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.apply(record, session, force, resolvedChangeSet));
    this.tails.set(record.workspaceId, operation);
    try {
      return await operation;
    } finally {
      if (this.tails.get(record.workspaceId) === operation) this.tails.delete(record.workspaceId);
    }
  }

  private async apply(record: StoredWriteback, session: SessionDetail, force: boolean,
    resolvedChangeSet?: WorkspaceChangeSet) {
    try {
      this.assertActiveGeneration(record.sessionId, record.sessionGeneration);
    } catch (error) {
      return this.update(record, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'SESSION_ADMISSION_CLOSED'
      });
    }
    const provider = this.providers.resolve(session);
    if (!provider) return this.update(record, { status: 'failed', error: 'Workspace provider is unavailable.' });
    try {
      await this.update(record, { status: 'merging', conflicts: [] });
      const changeSet = resolvedChangeSet ?? (force ? await forceChangeSet(provider, record.changeSet) : record.changeSet);
      await this.update(record, { status: 'applying' });
      const result = await provider.applyChangeSet(changeSet);
      if (!result.ok) {
        workspaceMetrics.increment('workspace_writeback_conflict_total', result.conflicts.length, {
          providerKind: record.providerKind
        });
        const captured = await this.captureConflictView(record, provider, result.conflicts);
        return this.update(record, { status: 'conflicted', conflicts: result.conflicts,
          conflictView: captured.view, conflictObservedHashes: captured.hashes });
      }
      return this.update(record, {
        status: 'applied',
        conflicts: [],
        appliedRevision: result.revision,
        error: undefined,
        conflictView: undefined,
        conflictObservedHashes: undefined
      });
    } catch (error) {
      return this.update(record, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private requireConflict(sessionId: string, conflictId: string): StoredWriteback {
    const record = this.records.get(conflictId);
    if (!record || record.sessionId !== sessionId ||
        !['conflicted', 'failed'].includes(record.status) || !record.conflictView) {
      throw new NotFoundException('Workspace conflict not found.');
    }
    this.assertActiveGeneration(record.sessionId, record.sessionGeneration);
    return record;
  }

  private async captureConflictView(record: StoredWriteback, provider: WorkspaceProvider,
    conflicts: WorkspaceConflictError[]): Promise<{ view: ConflictView; hashes: Record<string, string | null> }> {
    const hashes: Record<string, string | null> = {};
    const files: ConflictFileView[] = [];
    for (const conflict of conflicts) {
      const change = record.changeSet.changes.find((item) =>
        (item.operation === 'move' ? item.fromPath : item.path) === conflict.path);
      if (!change) throw new Error(`Workspace conflict has no matching change: ${conflict.path}`);
      const path = change.operation === 'move' ? change.toPath : change.path;
      const current = await inspectWorkspaceFile(provider, path);
      hashes[path] = current.hash;
      if (change.operation === 'move') {
        hashes[change.fromPath] = (await inspectWorkspaceFile(provider, change.fromPath)).hash;
      }
      const candidate = change.operation === 'create' || change.operation === 'update' ? change.content : undefined;
      const kind: ConflictFileView['kind'] = change.operation === 'move' ? 'renamed'
        : change.operation === 'delete' ? 'deleted'
        : current.readable && Buffer.byteLength(candidate ?? '', 'utf8') <= MAX_CONFLICT_TEXT_BYTES
          ? 'text' : 'binary';
      files.push({
        fileId: crypto.randomUUID(), path,
        ...(change.operation === 'move' ? { previousPath: change.fromPath } : {}),
        kind, status: 'unresolved', version: 1,
        ...(change.operation === 'update' || change.operation === 'delete'
          ? { baseObjectId: change.expectedHash.value } : {}),
        ...(candidate !== undefined ? { oursContent: kind === 'text' ? candidate : undefined } : {}),
        ...(current.content !== undefined && kind === 'text' ? { theirsContent: current.content } : {}),
        ...(kind === 'text' ? { resultContent: candidate } : {})
      });
    }
    const now = new Date().toISOString();
    return { hashes, view: {
      id: record.id, sessionId: record.sessionId, deliveryRound: 0,
      source: 'workspace_writeback', targetOperation: 'writeback',
      version: 1, files, createdAt: now, updatedAt: now
    } };
  }

  private async applyConfirmedConflict(record: StoredWriteback, session: SessionDetail,
    expectedVersion: number | undefined,
    authorizeResolvedDelete?: (changeSet: WorkspaceChangeSet) => Promise<void>
  ): Promise<WorkspaceWritebackRecord> {
    const view = this.requireConflict(session.id, record.id).conflictView!;
    if (view.version !== expectedVersion) throw new ConflictException('WORKSPACE_CONFLICT_VERSION_CONFLICT');
    if (!view.files.length || view.files.some((file) => file.status !== 'confirmed')) {
      throw new BadRequestException('Every workspace conflict file must be confirmed.');
    }
    const provider = this.providers.resolve(session);
    if (!provider) throw new ConflictException('WORKSPACE_PROVIDER_UNAVAILABLE');
    for (const [path, expectedHash] of Object.entries(record.conflictObservedHashes ?? {})) {
      const current = await inspectWorkspaceFile(provider, path);
      if (current.hash !== expectedHash) throw new ConflictException('WORKSPACE_CONFLICT_SOURCE_CHANGED');
    }
    const filesByPath = new Map(view.files.map((file) =>
      [file.previousPath ?? file.path, file]));
    const changes: WorkspaceChange[] = [];
    for (const change of record.changeSet.changes) {
      const file = filesByPath.get(change.operation === 'move' ? change.fromPath : change.path);
      if (!file) { changes.push(change); continue; }
      if (file.kind !== 'text' && file.binaryChoice === 'theirs') continue;
      if (change.operation === 'move') {
        const forced = await forceChangeSet(provider, { ...record.changeSet, changes: [change] });
        const sourceHash = record.conflictObservedHashes?.[change.fromPath];
        if (!sourceHash) throw new ConflictException('WORKSPACE_CONFLICT_MOVE_SOURCE_MISSING');
        changes.push(...forced.changes.map((part) => {
          if (part.operation === 'delete' && part.path === change.fromPath) {
            return { ...part, expectedHash: hashFromValue(sourceHash) };
          }
          if (part.operation === 'update' && part.path === change.toPath) {
            const targetHash = record.conflictObservedHashes?.[change.toPath];
            if (!targetHash) throw new ConflictException('WORKSPACE_CONFLICT_TARGET_CHANGED');
            return { ...part, expectedHash: hashFromValue(targetHash) };
          }
          return part;
        }));
        continue;
      }
      const currentHash = record.conflictObservedHashes?.[change.path];
      if (change.operation === 'delete') {
        if (currentHash) changes.push({ ...change, expectedHash: hashFromValue(currentHash) });
        continue;
      }
      const content = file.kind === 'text' ? file.resultContent! : change.content;
      if (file.kind === 'text' && file.theirsContent === content) continue;
      changes.push(currentHash
        ? { operation: 'update', path: change.path, content, encoding: 'utf-8',
            expectedHash: hashFromValue(currentHash) }
        : { operation: 'create', path: change.path, content, encoding: 'utf-8' });
    }
    const resolvedChangeSet = { ...record.changeSet, changes };
    if (record.providerKind === 'local_bridge' && changes.some((item) =>
      item.operation === 'delete' || item.operation === 'move')) {
      if (!authorizeResolvedDelete) throw new ConflictException('LOCAL_WRITEBACK_AUTHORIZATION_UNAVAILABLE');
      await authorizeResolvedDelete(resolvedChangeSet);
    }
    await this.update(record, { status: 'queued', resolution: 'apply_conflict', error: undefined });
    return this.runSerialized(record, session, false, resolvedChangeSet);
  }

  private async update(record: StoredWriteback, patch: Partial<StoredWriteback>) {
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    await this.persist();
    return publicRecord(record);
  }

  private persist() {
    return this.persistence.setCollection(COLLECTION, [...this.records.values()]).then((persisted) => {
      if (!persisted) throw new Error('WORKSPACE_WRITEBACK_PERSISTENCE_FAILED: writeback state was not durably stored.');
    });
  }

  private assertActiveGeneration(sessionId: string, expectedGeneration?: number) {
    if (!this.lifecycle.isActive(sessionId, expectedGeneration)) {
      throw new ConflictException('SESSION_ADMISSION_CLOSED');
    }
  }
}

function publicRecord(record: StoredWriteback): WorkspaceWritebackRecord {
  const { conflictView: _view, conflictObservedHashes: _hashes, ...publicFields } = record;
  return structuredClone({ ...publicFields,
    hasConflictDraft: Boolean(record.conflictView && ['conflicted', 'failed'].includes(record.status)) });
}

function hashFromValue(value: string): FileHash {
  return { algorithm: 'sha256', value };
}

function containsConflictMarkers(content: string): boolean {
  return /^(<<<<<<< |=======\s*$|>>>>>>> )/m.test(content);
}

async function inspectWorkspaceFile(provider: WorkspaceProvider, path: string): Promise<{
  hash: string | null; content?: string; readable: boolean;
}> {
  let metadata: Awaited<ReturnType<WorkspaceProvider['statFile']>>;
  try { metadata = await provider.statFile({ path }); }
  catch (error) {
    if (isMissingWorkspaceFile(error)) return { hash: null, content: '', readable: true };
    throw error;
  }
  if (!('kind' in metadata)) return { hash: null, content: '', readable: true };
  if (metadata.kind !== 'file' || !metadata.hash) {
    throw new ConflictException('WORKSPACE_CONFLICT_PATH_NOT_FILE');
  }
  if (metadata.size > MAX_CONFLICT_TEXT_BYTES) return { hash: metadata.hash.value, readable: false };
  try {
    const read = await provider.readFile({ path, maxBytes: MAX_CONFLICT_TEXT_BYTES });
    if (!read.truncated && read.hash?.value === metadata.hash.value) {
      return { hash: metadata.hash.value, content: read.content, readable: true };
    }
  } catch (error) {
    if (!/binary/i.test(String(error))) throw error;
  }
  return { hash: metadata.hash.value, readable: false };
}

function isMissingWorkspaceFile(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code) : '';
  return code === 'ENOENT' || /ENOENT|file not found/i.test(String(error));
}

async function forceChangeSet(provider: WorkspaceProvider, changeSet: WorkspaceChangeSet): Promise<WorkspaceChangeSet> {
  const changes: WorkspaceChange[] = [];
  for (const change of changeSet.changes) {
    if (change.operation === 'move') {
      const metadata = await provider.statFile({ path: change.fromPath }).catch(() => undefined);
      if (!metadata || metadata.kind !== 'file' || !metadata.hash) {
        throw new Error(`Cannot force Session move because the current source is missing: ${change.fromPath}`);
      }
      const source = await provider.readFile({ path: change.fromPath });
      if (source.truncated || source.encoding !== 'utf-8') {
        throw new Error(`Cannot force Session move because the current source is not complete UTF-8 text: ${change.fromPath}`);
      }
      const target = await provider.statFile({ path: change.toPath }).catch(() => undefined);
      if (target?.kind === 'file' && target.hash) {
        changes.push({
          operation: 'update',
          path: change.toPath,
          content: source.content,
          encoding: 'utf-8',
          expectedHash: target.hash
        });
      } else {
        changes.push({ operation: 'create', path: change.toPath, content: source.content, encoding: 'utf-8' });
      }
      changes.push({ operation: 'delete', path: change.fromPath, expectedHash: metadata.hash });
      continue;
    }
    const metadata = await provider.statFile({ path: change.path }).catch(() => undefined);
    if (change.operation === 'delete') {
      if (metadata?.kind === 'file' && metadata.hash) changes.push({ ...change, expectedHash: metadata.hash });
      continue;
    }
    if (metadata?.kind === 'file' && metadata.hash) {
      changes.push({
        operation: 'update',
        path: change.path,
        content: change.content,
        encoding: 'utf-8',
        expectedHash: metadata.hash
      });
    } else {
      changes.push({ operation: 'create', path: change.path, content: change.content, encoding: 'utf-8' });
    }
  }
  return { ...changeSet, changes };
}
