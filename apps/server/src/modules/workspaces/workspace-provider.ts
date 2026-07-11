import type {
  ApplyChangeSetResult,
  ListDirectoryInput,
  ListDirectoryResult,
  FileMetadata,
  ReadFileInput,
  ReadFileResult,
  SearchTextInput,
  SearchTextResult,
  StatFileInput,
  WorkspaceCapabilities,
  WorkspaceChangeSet,
  WorkspaceProviderKind,
  WorkspaceRevision
} from '@agent-cluster/shared';

export interface WorkspaceProvider {
  readonly kind: WorkspaceProviderKind;
  capabilities(): WorkspaceCapabilities;
  getRevision(): Promise<WorkspaceRevision>;
  listDirectory(input: ListDirectoryInput): Promise<ListDirectoryResult>;
  statFile(input: StatFileInput): Promise<FileMetadata>;
  readFile(input: ReadFileInput): Promise<ReadFileResult>;
  searchText(input: SearchTextInput): Promise<SearchTextResult>;
  applyChangeSet(input: WorkspaceChangeSet): Promise<ApplyChangeSetResult>;
}
