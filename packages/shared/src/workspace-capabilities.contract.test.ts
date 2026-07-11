import type { WorkspaceCapabilities, WorkspaceCapabilityKey } from './contracts.js';
import { WORKSPACE_CAPABILITY_KEYS } from './contracts.js';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

type WorkspaceCapabilityKeysAreStable = Assert<
  IsExact<WorkspaceCapabilityKey, 'read' | 'write' | 'command' | 'test'>
>;

const capabilities = {
  read: true,
  write: false,
  command: false,
  test: false
} satisfies WorkspaceCapabilities;

const capabilityKeys = WORKSPACE_CAPABILITY_KEYS satisfies readonly WorkspaceCapabilityKey[];
const runtimeCanWrite = capabilities.write;

void capabilityKeys;
void runtimeCanWrite;
