import type {
  FileHash,
  FileMetadata,
  ListDirectoryResult,
  ReadFileResult,
  SearchTextResult,
  WorkspaceRevision
} from './contracts.js';

const revision = {
  id: 'revision-42',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

const hash = {
  algorithm: 'sha256',
  value: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
} satisfies FileHash;

const file = {
  path: 'src/index.ts',
  kind: 'file',
  size: 4,
  revision,
  hash
} satisfies FileMetadata;

const listResult = {
  path: 'src',
  entries: [file],
  revision
} satisfies ListDirectoryResult;

const readResult = {
  path: file.path,
  content: 'test',
  encoding: 'utf-8',
  byteLength: 4,
  truncated: false,
  revision,
  hash
} satisfies ReadFileResult;

const searchResult = {
  matches: [],
  truncated: false,
  revision
} satisfies SearchTextResult;

const hasConflict = (expectedRevision: WorkspaceRevision, actualRevision: WorkspaceRevision) =>
  expectedRevision.id !== actualRevision.id;

void listResult;
void readResult;
void searchResult;
void hasConflict;
