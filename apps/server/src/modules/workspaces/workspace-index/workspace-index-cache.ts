import type { WorkspaceIndexEntry, WorkspaceRevision } from '@agent-cluster/shared';

interface Snapshot {
  revision: WorkspaceRevision;
  entries: WorkspaceIndexEntry[];
}

export class WorkspaceIndexCache {
  private snapshot: Snapshot | null = null;

  set(revision: WorkspaceRevision, entries: WorkspaceIndexEntry[]): void {
    this.snapshot = { revision, entries };
  }

  get(revision: WorkspaceRevision): WorkspaceIndexEntry[] | undefined {
    if (!this.snapshot) return undefined;
    if (this.snapshot.revision.id !== revision.id) return undefined;
    return this.snapshot.entries;
  }

  invalidateOn(newRevision: WorkspaceRevision): void {
    if (!this.snapshot) return;
    if (this.snapshot.revision.id === newRevision.id) return;
    this.snapshot = null;
  }

  clear(): void {
    this.snapshot = null;
  }

  currentRevisionId(): string | null {
    return this.snapshot ? this.snapshot.revision.id : null;
  }
}
