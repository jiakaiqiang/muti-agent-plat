import type {
  WorkspaceCapabilities,
  WorkspaceOperationRequest,
  WorkspaceOperationResult,
  WorkspaceProviderKind
} from '@agent-cluster/shared';

export interface BrokerClient {
  clientId: string;
  send(payload: unknown): void;
}

export interface BrokerWorkspaceRegistration {
  workspaceId: string;
  clientId: string;
  providerKind: WorkspaceProviderKind;
  capabilities: WorkspaceCapabilities;
  displayName: string;
  registeredAt: string;
  dataEpoch: string;
}

export interface RegisterWorkspaceInput {
  clientId: string;
  workspaceId: string;
  providerKind: WorkspaceProviderKind;
  capabilities: WorkspaceCapabilities;
  displayName: string;
  now?: string;
}

export class BrokerGateway {
  private readonly registrations = new Map<string, BrokerWorkspaceRegistration>();
  private readonly clientsByWorkspaceId = new Map<string, BrokerClient>();
  private readonly registrationWaiters = new Map<
    string,
    Set<(registration: BrokerWorkspaceRegistration) => void>
  >();

  constructor(private readonly currentDataEpoch: () => string) {}

  attachClient(client: BrokerClient): void {
    // Explicit no-op placeholder; kept for symmetry with detach and future hooks.
    void client;
  }

  detachClient(clientId: string): void {
    for (const [workspaceId, registration] of this.registrations) {
      if (registration.clientId === clientId) {
        this.registrations.delete(workspaceId);
        this.clientsByWorkspaceId.delete(workspaceId);
      }
    }
  }

  registerWorkspace(client: BrokerClient, input: RegisterWorkspaceInput): BrokerWorkspaceRegistration {
    if (this.registrations.has(input.workspaceId)) {
      throw new Error(`workspaceId already registered: ${input.workspaceId}`);
    }
    const registration: BrokerWorkspaceRegistration = {
      workspaceId: input.workspaceId,
      clientId: input.clientId,
      providerKind: input.providerKind,
      capabilities: input.capabilities,
      displayName: input.displayName,
      registeredAt: input.now ?? new Date().toISOString(),
      dataEpoch: this.currentDataEpoch()
    };
    this.registrations.set(input.workspaceId, registration);
    this.clientsByWorkspaceId.set(input.workspaceId, client);
    const waiters = this.registrationWaiters.get(input.workspaceId);
    if (waiters) {
      this.registrationWaiters.delete(input.workspaceId);
      for (const resolve of waiters) resolve(registration);
    }
    return registration;
  }

  unregisterWorkspace(clientId: string, workspaceId: string): boolean {
    const registration = this.registrations.get(workspaceId);
    if (!registration || registration.clientId !== clientId) return false;
    this.registrations.delete(workspaceId);
    this.clientsByWorkspaceId.delete(workspaceId);
    return true;
  }

  getRegistration(workspaceId: string): BrokerWorkspaceRegistration | undefined {
    return this.registrations.get(workspaceId);
  }

  listRegistrations(): BrokerWorkspaceRegistration[] {
    return Array.from(this.registrations.values());
  }

  waitForRegistration(workspaceId: string): Promise<BrokerWorkspaceRegistration> {
    const registration = this.registrations.get(workspaceId);
    if (registration) return Promise.resolve(registration);

    return new Promise((resolve) => {
      const waiters = this.registrationWaiters.get(workspaceId) ?? new Set();
      waiters.add(resolve);
      this.registrationWaiters.set(workspaceId, waiters);
    });
  }

  dispatch(request: WorkspaceOperationRequest): void {
    const registration = this.registrations.get(request.workspaceId);
    if (registration && registration.dataEpoch !== this.currentDataEpoch()) {
      throw new Error(`STALE_DATA_EPOCH: browser workspace ${request.workspaceId} belongs to ${registration.dataEpoch}.`);
    }
    const client = this.clientsByWorkspaceId.get(request.workspaceId);
    if (!client) {
      throw new Error(`no broker client for workspace: ${request.workspaceId}`);
    }
    client.send({ kind: 'workspace.operation.request', payload: request });
  }

  invalidateAll(reason: string): void {
    const clients = new Set(this.clientsByWorkspaceId.values());
    for (const client of clients) {
      client.send({ kind: 'workspace.registration.invalidated', payload: { reason } });
    }
    this.registrations.clear();
    this.clientsByWorkspaceId.clear();
  }

  handleResult(result: WorkspaceOperationResult): WorkspaceOperationResult {
    return result;
  }
}
