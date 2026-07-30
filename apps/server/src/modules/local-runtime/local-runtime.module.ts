import { Global, Module } from '@nestjs/common';
import { LocalRuntimeAuthService } from './local-runtime-auth.service.js';
import { LocalRuntimeConnectionService } from './local-runtime-connection.service.js';
import { LocalRuntimeController } from './local-runtime.controller.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { LocalRuntimeAdminGuard } from './local-runtime-admin.guard.js';
import { HeartbeatTracker } from '../workspaces/runtime-broker/heartbeat-tracker.js';

@Global()
@Module({
  imports: [WorkspacesModule],
  controllers: [LocalRuntimeController],
  providers: [HeartbeatTracker, LocalRuntimeAdminGuard, LocalRuntimeAuthService, LocalRuntimeConnectionService],
  exports: [LocalRuntimeAuthService, LocalRuntimeConnectionService]
})
export class LocalRuntimeModule {}
