import type { SessionWorkingDirectory, WorkspaceProviderKind } from './contracts.js';
import { WORKSPACE_PROVIDER_KINDS } from './contracts.js';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

type WorkspaceProviderKindsAreStable = Assert<
  IsExact<WorkspaceProviderKind, 'server_local' | 'local_bridge'>
>;

const providerKinds = WORKSPACE_PROVIDER_KINDS satisfies readonly WorkspaceProviderKind[];

void providerKinds;

type SessionKindsAreLocalOrServer = Assert<
  IsExact<SessionWorkingDirectory['kind'], 'local_bridge' | 'server_local'>
>;

const sessionKindsAreLocalOrServer = true satisfies SessionKindsAreLocalOrServer;
void sessionKindsAreLocalOrServer;
