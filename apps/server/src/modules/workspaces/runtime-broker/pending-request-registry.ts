import type { WorkspaceOperationResult } from '@agent-cluster/shared';

interface PendingEntry {
  requestId: string;
  workspaceId: string;
  resolve: (result: WorkspaceOperationResult) => void;
  reject: (error: Error) => void;
  registeredAt: number;
}

export class PendingRequestRegistry {
  private readonly entries = new Map<string, PendingEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  waitFor(requestId: string, workspaceId: string): Promise<WorkspaceOperationResult> {
    if (this.entries.has(requestId)) {
      return Promise.reject(new Error(`duplicate requestId: ${requestId}`));
    }
    return new Promise<WorkspaceOperationResult>((resolve, reject) => {
      this.entries.set(requestId, {
        requestId,
        workspaceId,
        resolve,
        reject,
        registeredAt: this.now()
      });
    });
  }

  settle(result: WorkspaceOperationResult): boolean {
    const entry = this.entries.get(result.requestId);
    if (!entry) return false;
    if (entry.workspaceId !== result.workspaceId) {
      entry.reject(new Error(`workspaceId mismatch for requestId ${result.requestId}`));
      this.entries.delete(result.requestId);
      return false;
    }
    entry.resolve(result);
    this.entries.delete(result.requestId);
    return true;
  }

  reject(requestId: string, reason: Error): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    entry.reject(reason);
    this.entries.delete(requestId);
    return true;
  }

  rejectByWorkspace(workspaceId: string, reason: Error): number {
    let count = 0;
    for (const [requestId, entry] of this.entries) {
      if (entry.workspaceId === workspaceId) {
        entry.reject(reason);
        this.entries.delete(requestId);
        count += 1;
      }
    }
    return count;
  }

  size(): number {
    return this.entries.size;
  }
}
