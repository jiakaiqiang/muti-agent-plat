import type {
  FileHash,
  WorkspaceConflictError,
  WorkspaceConflictErrorCode,
  WorkspaceRevision
} from './contracts.js';
import { WORKSPACE_BASE_HASH_MISMATCH, WORKSPACE_MERGE_CONFLICT } from './contracts.js';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

type ConflictCodeIsStable = Assert<
  IsExact<WorkspaceConflictErrorCode, 'WORKSPACE_BASE_HASH_MISMATCH' | 'WORKSPACE_MERGE_CONFLICT'>
>;

const baseHash = {
  algorithm: 'sha256',
  value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
} satisfies FileHash;

const actualHash = {
  algorithm: 'sha256',
  value: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
} satisfies FileHash;

const actualRevision = {
  id: 'revision-43',
  observedAt: '2026-07-11T00:01:00.000Z'
} satisfies WorkspaceRevision;

const conflict = {
  code: WORKSPACE_BASE_HASH_MISMATCH,
  message: 'File changed after the ChangeSet was prepared.',
  changeSetId: '00000000-0000-4000-8000-000000000049',
  operation: 'update',
  path: 'src/current.ts',
  baseHash,
  actualHash,
  actualRevision
} satisfies WorkspaceConflictError;

void conflict;
void WORKSPACE_MERGE_CONFLICT;
