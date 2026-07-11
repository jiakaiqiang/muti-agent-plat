import type { WorkspaceProviderKind } from '@agent-cluster/shared';
import type { WorkspaceProvider } from './workspace-provider.js';

export class WorkspaceProviderRegistry {
  private readonly providers = new Map<WorkspaceProviderKind, WorkspaceProvider>();

  register(provider: WorkspaceProvider): void {
    if (this.providers.has(provider.kind)) {
      throw new Error(`WorkspaceProvider already registered for kind: ${provider.kind}`);
    }
    this.providers.set(provider.kind, provider);
  }

  resolve(kind: WorkspaceProviderKind): WorkspaceProvider {
    const provider = this.providers.get(kind);
    if (!provider) {
      throw new Error(`No WorkspaceProvider registered for kind: ${kind}`);
    }
    return provider;
  }

  has(kind: WorkspaceProviderKind): boolean {
    return this.providers.has(kind);
  }
}
