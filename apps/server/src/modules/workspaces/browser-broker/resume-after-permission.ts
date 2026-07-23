import type { WorkspaceLeaseMode } from '@agent-cluster/shared';

export interface SuspendedTaskEntry {
  taskId: string;
  sessionId: string;
  workspaceId: string;
  requiredMode: WorkspaceLeaseMode;
  suspendedAt: string;
  reason: 'permission-prompt' | 'permission-denied' | 'permission-unsupported' | 'broker-offline';
}

export interface ResumeCandidate extends SuspendedTaskEntry {
  resumedAt: string;
}

export class BrokerSuspensionRegistry {
  private readonly entries = new Map<string, SuspendedTaskEntry>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  suspend(entry: Omit<SuspendedTaskEntry, 'suspendedAt'>): SuspendedTaskEntry {
    const full: SuspendedTaskEntry = { ...entry, suspendedAt: this.now() };
    this.entries.set(entry.taskId, full);
    return full;
  }

  resumeReadyForWorkspace(workspaceId: string, grantedMode: WorkspaceLeaseMode): ResumeCandidate[] {
    const now = this.now();
    const resumed: ResumeCandidate[] = [];
    for (const [taskId, entry] of this.entries) {
      if (entry.workspaceId !== workspaceId) continue;
      if (!satisfies(grantedMode, entry.requiredMode)) continue;
      resumed.push({ ...entry, resumedAt: now });
      this.entries.delete(taskId);
    }
    return resumed;
  }

  list(): SuspendedTaskEntry[] {
    return Array.from(this.entries.values());
  }
}

function satisfies(grantedMode: WorkspaceLeaseMode, requiredMode: WorkspaceLeaseMode): boolean {
  if (requiredMode === 'read') return grantedMode === 'read' || grantedMode === 'read_write';
  return grantedMode === 'read_write';
}
