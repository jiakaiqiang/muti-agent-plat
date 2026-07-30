export type HeartbeatStatus = 'online' | 'offline';

export interface HeartbeatEntry {
  workspaceId: string;
  status: HeartbeatStatus;
  lastSeenAt: number;
}

export class HeartbeatTracker {
  private readonly entries = new Map<string, HeartbeatEntry>();

  constructor(private readonly timeoutMs: number, private readonly now: () => number = () => Date.now()) {
    if (timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  }

  record(workspaceId: string): HeartbeatEntry {
    const entry: HeartbeatEntry = {
      workspaceId,
      status: 'online',
      lastSeenAt: this.now()
    };
    this.entries.set(workspaceId, entry);
    return entry;
  }

  status(workspaceId: string): HeartbeatStatus | undefined {
    const entry = this.entries.get(workspaceId);
    if (!entry) return undefined;
    return this.isFresh(entry) ? 'online' : 'offline';
  }

  reap(): string[] {
    const offline: string[] = [];
    for (const [workspaceId, entry] of this.entries) {
      if (this.isFresh(entry)) continue;
      if (entry.status === 'online') {
        entry.status = 'offline';
        offline.push(workspaceId);
      }
    }
    return offline;
  }

  drop(workspaceId: string): void {
    this.entries.delete(workspaceId);
  }

  list(): HeartbeatEntry[] {
    return Array.from(this.entries.values());
  }

  private isFresh(entry: HeartbeatEntry): boolean {
    return this.now() - entry.lastSeenAt <= this.timeoutMs;
  }
}
