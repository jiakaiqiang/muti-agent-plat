import { Global, Module } from '@nestjs/common';
import { BrokerGateway } from './runtime-broker/broker-gateway.js';
import { PendingRequestRegistry } from './runtime-broker/pending-request-registry.js';
import { WorkspaceProviderResolver } from './workspace-provider-resolver.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { WorkspaceWritebackService } from './workspace-writeback.service.js';

@Global()
@Module({
  providers: [
    {
      provide: BrokerGateway,
      useFactory: (persistence: PersistenceService) => new BrokerGateway(() => persistence.currentDataEpoch()),
      inject: [PersistenceService]
    },
    PendingRequestRegistry,
    WorkspaceProviderResolver,
    WorkspaceWritebackService
  ],
  exports: [BrokerGateway, PendingRequestRegistry, WorkspaceProviderResolver, WorkspaceWritebackService]
})
export class WorkspacesModule {}
