import type {
  FileHash,
  WorkspaceIndexEntry,
  WorkspaceIndexEntryKind,
  WorkspaceRevision
} from './contracts.js';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

type WorkspaceIndexEntryKindsAreStable = Assert<
  IsExact<WorkspaceIndexEntryKind, 'file' | 'directory'>
>;

const revision = {
  id: 'revision-61',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

const hash = {
  algorithm: 'sha256',
  value: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
} satisfies FileHash;

const fileEntry: WorkspaceIndexEntry = {
  path: 'src/index.ts',
  kind: 'file',
  size: 42,
  hash,
  revision,
  generated: false,
  sensitive: false
};

const directoryEntry: WorkspaceIndexEntry = {
  path: 'src',
  kind: 'directory',
  revision,
  generated: false,
  sensitive: false
};

const generatedEntry: WorkspaceIndexEntry = {
  path: 'dist/index.js',
  kind: 'file',
  size: 128,
  hash,
  revision,
  generated: true,
  sensitive: false
};

const sensitiveEntry: WorkspaceIndexEntry = {
  path: '.env',
  kind: 'file',
  size: 32,
  hash,
  revision,
  generated: false,
  sensitive: true
};

void fileEntry;
void directoryEntry;
void generatedEntry;
void sensitiveEntry;
