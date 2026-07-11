import type { WorkspaceIndexEntry, WorkspaceRevision } from '@agent-cluster/shared';
import { WorkspaceIndexCache } from './workspace-index-cache.js';

export class WorkspaceIndexService {
  private readonly cachesByWorkspaceId = new Map<string, WorkspaceIndexCache>();

  setIndex(workspaceId: string, revision: WorkspaceRevision, entries: WorkspaceIndexEntry[]): void {
    const cache = this.getOrCreate(workspaceId);
    cache.set(revision, entries);
  }

  getIndex(workspaceId: string, revision: WorkspaceRevision): WorkspaceIndexEntry[] | undefined {
    return this.cachesByWorkspaceId.get(workspaceId)?.get(revision);
  }

  invalidateOn(workspaceId: string, newRevision: WorkspaceRevision): void {
    const cache = this.cachesByWorkspaceId.get(workspaceId);
    if (!cache) return;
    cache.invalidateOn(newRevision);
  }

  drop(workspaceId: string): void {
    this.cachesByWorkspaceId.delete(workspaceId);
  }

  currentRevisionId(workspaceId: string): string | null {
    return this.cachesByWorkspaceId.get(workspaceId)?.currentRevisionId() ?? null;
  }

  private getOrCreate(workspaceId: string): WorkspaceIndexCache {
    let cache = this.cachesByWorkspaceId.get(workspaceId);
    if (!cache) {
      cache = new WorkspaceIndexCache();
      this.cachesByWorkspaceId.set(workspaceId, cache);
    }
    return cache;
  }
}
