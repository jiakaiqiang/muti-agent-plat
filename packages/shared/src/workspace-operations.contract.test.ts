import type {
  FileMetadata,
  ListDirectoryInput,
  ListDirectoryResult,
  ReadFileInput,
  ReadFileResult,
  SearchTextInput,
  SearchTextMatch,
  SearchTextResult,
  StatFileInput
} from './contracts.js';

const listInput = {
  path: 'src',
  recursive: true,
  maxDepth: 2,
  limit: 100
} satisfies ListDirectoryInput;

const revision = {
  id: 'revision-1',
  observedAt: '2026-07-11T00:00:00.000Z'
} as const;

const hash = {
  algorithm: 'sha256',
  value: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
} as const;

const file = {
  path: 'src/index.ts',
  kind: 'file',
  size: 128,
  modifiedAt: '2026-07-11T00:00:00.000Z',
  revision,
  hash
} satisfies FileMetadata;

const listResult = {
  path: 'src',
  entries: [file],
  revision,
  nextCursor: 'page-2'
} satisfies ListDirectoryResult;

const statInput = { path: file.path } satisfies StatFileInput;

const readInput = {
  path: file.path,
  startLine: 1,
  endLine: 80,
  maxBytes: 32_768
} satisfies ReadFileInput;

const readResult = {
  path: file.path,
  content: 'export const ready = true;',
  encoding: 'utf-8',
  byteLength: 26,
  truncated: false,
  revision,
  hash,
  startLine: 1,
  endLine: 1
} satisfies ReadFileResult;

const searchInput = {
  query: 'ready',
  path: 'src',
  include: ['**/*.ts'],
  exclude: ['**/*.spec.ts'],
  caseSensitive: false,
  maxResults: 50
} satisfies SearchTextInput;

const match = {
  path: file.path,
  line: 1,
  column: 14,
  preview: 'export const ready = true;'
} satisfies SearchTextMatch;

const searchResult = {
  matches: [match],
  truncated: false,
  revision
} satisfies SearchTextResult;

void listInput;
void listResult;
void statInput;
void readInput;
void readResult;
void searchInput;
void searchResult;
