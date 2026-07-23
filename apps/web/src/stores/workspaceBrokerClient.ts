export type BrokerConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface BrokerWorkspaceEntry {
  workspaceId: string;
  displayName: string;
  registeredAt: string;
}

export interface BrokerClientStateSnapshot {
  connection: BrokerConnectionState;
  attempt: number;
  registered: BrokerWorkspaceEntry[];
  lastError?: string;
}

export class WorkspaceBrokerClient {
  private state: BrokerConnectionState = 'idle';
  private attempt = 0;
  private lastError: string | undefined;
  private readonly registered = new Map<string, BrokerWorkspaceEntry>();

  connect(): void {
    this.state = 'connecting';
    this.attempt += 1;
  }

  markConnected(): void {
    this.state = 'connected';
    this.lastError = undefined;
  }

  markDisconnected(reason?: string): void {
    this.state = 'disconnected';
    if (reason) this.lastError = reason;
  }

  registerWorkspace(entry: BrokerWorkspaceEntry): void {
    if (this.state !== 'connected') {
      throw new Error(`cannot register workspace while connection is ${this.state}`);
    }
    this.registered.set(entry.workspaceId, entry);
  }

  reRegisterOnReconnect(): BrokerWorkspaceEntry[] {
    if (this.state !== 'connected') {
      throw new Error(`cannot re-register while connection is ${this.state}`);
    }
    return Array.from(this.registered.values());
  }

  clearWorkspace(workspaceId: string): void {
    this.registered.delete(workspaceId);
  }

  snapshot(): BrokerClientStateSnapshot {
    return {
      connection: this.state,
      attempt: this.attempt,
      registered: Array.from(this.registered.values()),
      ...(this.lastError ? { lastError: this.lastError } : {})
    };
  }
}
