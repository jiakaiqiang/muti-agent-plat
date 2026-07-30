import { Injectable } from '@nestjs/common';
import type { SessionDetail, SessionWorkingDirectory } from '@agent-cluster/shared';
import { BrokerGateway } from './runtime-broker/broker-gateway.js';
import { PendingRequestRegistry } from './runtime-broker/pending-request-registry.js';
import { ServerLocalWorkspaceProvider } from './server-local-workspace-provider.js';
import type { WorkspaceProvider } from './workspace-provider.js';
import { LocalBridgeWorkspaceProvider } from './local-bridge-workspace-provider.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { dirname, join } from 'node:path';

@Injectable()
export class WorkspaceProviderResolver {
  constructor(
    private readonly gateway: BrokerGateway,
    private readonly pending: PendingRequestRegistry,
    private readonly persistence: PersistenceService
  ) {}

  resolve(session: SessionDetail): WorkspaceProvider | undefined {
    return this.resolveWorkingDirectory(session.workingDirectory);
  }

  resolveWorkingDirectory(workingDirectory: SessionWorkingDirectory | undefined): WorkspaceProvider | undefined {
    if (!workingDirectory) return undefined;
    if (workingDirectory.kind === 'server_local' && workingDirectory.path) {
      return new ServerLocalWorkspaceProvider(workingDirectory.path, undefined, true, {
        indexCacheDirectory: join(dirname(this.persistence.dataFilePath()), 'workspace-indexes')
      });
    }
    if (workingDirectory.kind === 'local_bridge') {
      return new LocalBridgeWorkspaceProvider(workingDirectory.id, {
        gateway: this.gateway,
        pending: this.pending
      });
    }
    return undefined;
  }

}
