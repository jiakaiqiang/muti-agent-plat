import { Module } from '@nestjs/common';
import { InvocationWorkspaceBindingsService } from '../runtimes/invocation-workspace-bindings.service.js';
import { WorktreeExecutionService } from './worktree-execution.service.js';

@Module({
  providers: [InvocationWorkspaceBindingsService, WorktreeExecutionService],
  exports: [InvocationWorkspaceBindingsService, WorktreeExecutionService]
})
export class WorktreeExecutionModule {}
