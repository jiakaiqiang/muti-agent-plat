import type {
  FileHash,
  WorkspaceChange,
  WorkspaceChangeOperation,
  WorkspaceChangeSet,
  WorkspaceRevision
} from './contracts.js';
import { WORKSPACE_CHANGE_OPERATIONS } from './contracts.js';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

type WorkspaceChangeOperationsAreStable = Assert<
  IsExact<WorkspaceChangeOperation, 'create' | 'update' | 'delete' | 'move'>
>;

const revision = {
  id: 'revision-42',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

const expectedHash = {
  algorithm: 'sha256',
  value: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
} satisfies FileHash;

const changes = [
  {
    operation: 'create',
    path: 'src/new.ts',
    content: 'export const created = true;',
    encoding: 'utf-8'
  },
  {
    operation: 'update',
    path: 'src/current.ts',
    content: 'export const updated = true;',
    encoding: 'utf-8',
    expectedHash
  },
  {
    operation: 'delete',
    path: 'src/obsolete.ts',
    expectedHash
  },
  {
    operation: 'move',
    fromPath: 'src/old-name.ts',
    toPath: 'src/new-name.ts',
    expectedHash
  }
] satisfies WorkspaceChange[];

const changeSet = {
  id: '00000000-0000-4000-8000-000000000049',
  baseRevision: revision,
  changes,
  createdAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceChangeSet;

const operations = WORKSPACE_CHANGE_OPERATIONS satisfies readonly WorkspaceChangeOperation[];

void changeSet;
void operations;
