import type { WorkspaceProviderKind } from './contracts.js';
import { WORKSPACE_PROVIDER_KINDS } from './contracts.js';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

type WorkspaceProviderKindsAreStable = Assert<
  IsExact<WorkspaceProviderKind, 'server_local' | 'browser_broker' | 'local_bridge'>
>;

const providerKinds = WORKSPACE_PROVIDER_KINDS satisfies readonly WorkspaceProviderKind[];

void providerKinds;
