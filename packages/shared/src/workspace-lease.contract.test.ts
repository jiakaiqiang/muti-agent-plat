import type { WorkspaceLease, WorkspaceLeaseMode } from './contracts.js';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

type LeaseModesAreStable = Assert<IsExact<WorkspaceLeaseMode, 'read' | 'read_write'>>;

const readLease: WorkspaceLease = {
  leaseId: '00000000-0000-4000-8000-000000000092',
  workspaceId: 'ws-92',
  mode: 'read',
  allowedOperations: ['capabilities', 'getRevision', 'listDirectory', 'statFile', 'readFile', 'searchText'],
  issuedAt: '2026-07-11T00:00:00.000Z',
  expiresAt: '2026-07-11T00:15:00.000Z',
  issuedBySessionId: '00000000-0000-4000-8000-000000000000'
};

const rwLease: WorkspaceLease = {
  leaseId: '00000000-0000-4000-8000-000000000093',
  workspaceId: 'ws-92',
  mode: 'read_write',
  allowedOperations: [
    'capabilities',
    'getRevision',
    'listDirectory',
    'statFile',
    'readFile',
    'searchText',
    'applyChangeSet'
  ],
  issuedAt: '2026-07-11T00:00:00.000Z',
  expiresAt: '2026-07-11T00:30:00.000Z',
  issuedBySessionId: '00000000-0000-4000-8000-000000000001'
};

void readLease;
void rwLease;
