import { Global, Module } from '@nestjs/common';
import { BrokerGateway } from './browser-broker/broker-gateway.js';
import { HeartbeatTracker } from './browser-broker/heartbeat-tracker.js';
import { PendingRequestRegistry } from './browser-broker/pending-request-registry.js';
import { WorkspaceBrokerTransport } from './browser-broker/workspace-broker-transport.js';
import { WorkspaceProviderResolver } from './workspace-provider-resolver.js';
import { PersistenceService } from '../persistence/persistence.service.js';

@Global()
@Module({
  providers: [
    {
      provide: BrokerGateway,
      useFactory: (persistence: PersistenceService) => new BrokerGateway(() => persistence.currentDataEpoch()),
      inject: [PersistenceService]
    },
    PendingRequestRegistry,
    {
      provide: HeartbeatTracker,
      useFactory: () => new HeartbeatTracker(45_000)
    },
    WorkspaceBrokerTransport,
    WorkspaceProviderResolver
  ],
  exports: [BrokerGateway, PendingRequestRegistry, HeartbeatTracker, WorkspaceBrokerTransport, WorkspaceProviderResolver]
})
export class WorkspacesModule {}
