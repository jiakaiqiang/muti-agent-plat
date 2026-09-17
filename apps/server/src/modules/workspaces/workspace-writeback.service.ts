import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ResolveWorkspaceWritebackInput,
  RuntimeWorkspaceExecution,
  SessionDetail,
  WorkspaceChange,
  WorkspaceChangeSet,
  WorkspaceProviderKind,
  WorkspaceWritebackRecord
} from '@agent-cluster/shared';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { SessionLifecycleStore } from '../runtimes/session-lifecycle-store.js';
import type { WorkspaceProvider } from './workspace-provider.js';
import { WorkspaceProviderResolver } from './workspace-provider-resolver.js';

const COLLECTION = 'workspaceWritebacks';

@Injectable()
export class WorkspaceWritebackService {
  private readonly records = new Map<string, WorkspaceWritebackRecord>();
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
    for (const record of persistence.getCollection<WorkspaceWritebackRecord[]>(COLLECTION, [])) {
      if (['queued', 'merging', 'applying'].includes(record.status)) {
        record.status = 'failed';
        record.error = 'Workspace writeback was interrupted by a backend restart. Retry merge to continue.';
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
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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
        : structuredClone(existing);
    }
    const now = new Date().toISOString();
    const record: WorkspaceWritebackRecord = {
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
    input: ResolveWorkspaceWritebackInput
  ): Promise<WorkspaceWritebackRecord> {
    const record = this.records.get(writebackId);
    if (!record || record.sessionId !== session.id) throw new NotFoundException('Workspace writeback not found.');
    this.assertActiveGeneration(record.sessionId, record.sessionGeneration);
    const previous = this.resolutionTails.get(record.id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.resolveLocked(record, session, input));
    this.resolutionTails.set(record.id, operation);
    try {
      return await operation;
    } finally {
      if (this.resolutionTails.get(record.id) === operation) this.resolutionTails.delete(record.id);
    }
  }

  private async resolveLocked(
    record: WorkspaceWritebackRecord,
    session: SessionDetail,
    input: ResolveWorkspaceWritebackInput
  ): Promise<WorkspaceWritebackRecord> {
    if (!['conflicted', 'failed'].includes(record.status)) {
      throw new BadRequestException(`Workspace writeback cannot be resolved from status ${record.status}.`);
    }
    if (input.action === 'keep_workspace' || input.action === 'abandon_writeback') {
      return this.update(record, { status: 'abandoned', resolution: input.action, conflicts: [] });
    }
    if (input.action === 'resolve_with_agent') {
      return this.update(record, { status: 'abandoned', resolution: input.action, conflicts: [] });
    }
    if (input.action === 'use_session' && input.confirmationId !== record.id) {
      throw new BadRequestException('The current writeback id is required to confirm applying the Session version.');
    }
    await this.update(record, { status: 'queued', resolution: input.action, error: undefined });
    return this.runSerialized(record, session, input.action === 'use_session');
  }

  private async runSerialized(record: WorkspaceWritebackRecord, session: SessionDetail, force: boolean) {
    const active = this.activeOperations.get(record.id);
    if (active) return active;
    const operation = this.scheduleSerialized(record, session, force);
    this.activeOperations.set(record.id, operation);
    try {
      return await operation;
    } finally {
      if (this.activeOperations.get(record.id) === operation) this.activeOperations.delete(record.id);
    }
  }

  private async scheduleSerialized(record: WorkspaceWritebackRecord, session: SessionDetail, force: boolean) {
    const previous = this.tails.get(record.workspaceId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.apply(record, session, force));
    this.tails.set(record.workspaceId, operation);
    try {
      return await operation;
    } finally {
      if (this.tails.get(record.workspaceId) === operation) this.tails.delete(record.workspaceId);
    }
  }

  private async apply(record: WorkspaceWritebackRecord, session: SessionDetail, force: boolean) {
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
      const changeSet = force ? await forceChangeSet(provider, record.changeSet) : record.changeSet;
      await this.update(record, { status: 'applying' });
      const result = await provider.applyChangeSet(changeSet);
      if (!result.ok) {
        workspaceMetrics.increment('workspace_writeback_conflict_total', result.conflicts.length, {
          providerKind: record.providerKind
        });
        return this.update(record, { status: 'conflicted', conflicts: result.conflicts });
      }
      return this.update(record, {
        status: 'applied',
        conflicts: [],
        appliedRevision: result.revision,
        error: undefined
      });
    } catch (error) {
      return this.update(record, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async update(record: WorkspaceWritebackRecord, patch: Partial<WorkspaceWritebackRecord>) {
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    await this.persist();
    return structuredClone(record);
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
