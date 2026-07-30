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
  WorkspaceIndexSnapshotInput,
  WorkspaceIndexSnapshotPage,
  WorkspaceIndexQueryInput,
  WorkspaceIndexQueryResult,
  WorkspaceProviderKind,
  WorkspaceRevision,
  SessionWorkingDirectory
} from '@agent-cluster/shared';

export function workspaceProviderKindForDirectory(
  kind: SessionWorkingDirectory['kind'] | undefined
): WorkspaceProviderKind {
  if (kind === 'local_bridge') return 'local_bridge';
  return 'server_local';
}

export interface WorkspaceProvider {
  readonly kind: WorkspaceProviderKind;
  capabilities(): WorkspaceCapabilities;
  getRevision(): Promise<WorkspaceRevision>;
  getIndexSnapshot?(input: WorkspaceIndexSnapshotInput): Promise<WorkspaceIndexSnapshotPage>;
  queryWorkspaceIndex?(input: WorkspaceIndexQueryInput): Promise<WorkspaceIndexQueryResult>;
  listDirectory(input: ListDirectoryInput): Promise<ListDirectoryResult>;
  statFile(input: StatFileInput): Promise<FileMetadata>;
  readFile(input: ReadFileInput): Promise<ReadFileResult>;
  searchText(input: SearchTextInput): Promise<SearchTextResult>;
  applyChangeSet(input: WorkspaceChangeSet): Promise<ApplyChangeSetResult>;
}
