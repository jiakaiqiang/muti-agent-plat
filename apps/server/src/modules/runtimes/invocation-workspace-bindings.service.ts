import { Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import type { InvocationPlan, SessionDetail } from '@agent-cluster/shared';

@Injectable()
export class InvocationWorkspaceBindingsService {
  private readonly serverRoots = new Map<string, string>();
  private readonly invocationRoots = new Map<string, string>();

  bindSession(session: SessionDetail) {
    const workingDirectory = session.workingDirectory;
    if (workingDirectory?.kind !== 'server_local' || !workingDirectory.path) return;
    const rootPath = resolve(workingDirectory.path);
    this.serverRoots.set(workingDirectory.id, rootPath);
    this.serverRoots.set(session.workspaceId, rootPath);
  }

  resolveServerRoot(input: InvocationPlan): string | undefined {
    const invocationRoot = this.invocationRoots.get(input.invocationId);
    if (invocationRoot) return invocationRoot;
    if (input.executionTarget.workspaceProviderKind !== 'server_local') return undefined;
    return this.resolveSessionRoot(input);
  }

  resolveSessionRoot(input: InvocationPlan): string | undefined {
    if (input.executionTarget.workspaceProviderKind !== 'server_local') return undefined;
    return this.serverRoots.get(input.contextEnvelope.workspaceId);
  }

  bindInvocation(invocationId: string, rootPath: string) {
    this.invocationRoots.set(invocationId, resolve(rootPath));
  }

  unbindInvocation(invocationId: string) {
    this.invocationRoots.delete(invocationId);
  }
}
