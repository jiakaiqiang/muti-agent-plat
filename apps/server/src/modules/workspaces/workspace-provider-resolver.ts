import { Injectable } from '@nestjs/common';
import type { SessionDetail } from '@agent-cluster/shared';
import { BrowserBrokerProvider } from './browser-broker/browser-broker-provider.js';
import { BrokerGateway } from './browser-broker/broker-gateway.js';
import { PendingRequestRegistry } from './browser-broker/pending-request-registry.js';
import { ServerLocalWorkspaceProvider } from './server-local-workspace-provider.js';
import type { WorkspaceProvider } from './workspace-provider.js';

@Injectable()
export class WorkspaceProviderResolver {
  constructor(
    private readonly gateway: BrokerGateway,
    private readonly pending: PendingRequestRegistry
  ) {}

  resolve(session: SessionDetail): WorkspaceProvider | undefined {
    const workingDirectory = session.workingDirectory;
    if (!workingDirectory) return undefined;
    if (workingDirectory.kind === 'server_local' && workingDirectory.path) {
      return new ServerLocalWorkspaceProvider(workingDirectory.path);
    }
    if (workingDirectory.kind === 'browser_local') {
      return this.resolveBrowser(workingDirectory.id);
    }
    return undefined;
  }

  resolveBrowser(workspaceId: string): BrowserBrokerProvider {
    return new BrowserBrokerProvider(workspaceId, {
      gateway: this.gateway,
      pending: this.pending
    });
  }
}
