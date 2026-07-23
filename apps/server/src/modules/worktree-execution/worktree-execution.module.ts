import { Module } from '@nestjs/common';
import { InvocationWorkspaceBindingsService } from '../runtimes/invocation-workspace-bindings.service.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { BrowserWorkspaceMirrorService } from './browser-workspace-mirror.service.js';
import { WorktreeExecutionService } from './worktree-execution.service.js';

@Module({
  imports: [WorkspacesModule],
  providers: [InvocationWorkspaceBindingsService, WorktreeExecutionService, BrowserWorkspaceMirrorService],
  exports: [InvocationWorkspaceBindingsService, WorktreeExecutionService, BrowserWorkspaceMirrorService]
})
export class WorktreeExecutionModule {}
