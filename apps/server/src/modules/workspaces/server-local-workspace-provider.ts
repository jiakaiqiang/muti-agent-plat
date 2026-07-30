import type {
  ApplyChangeSetResult,
  FileMetadata,
  ListDirectoryInput,
  ListDirectoryResult,
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
  WorkspaceRevision
} from '@agent-cluster/shared';
import { applyServerLocalChangeSet } from './workspace-apply-change-set.js';
import { listServerLocalDirectory } from './workspace-list-directory.js';
import type { WorkspaceProvider } from './workspace-provider.js';
import { readServerLocalFile } from './workspace-read-file.js';
import { searchServerLocalText } from './workspace-search-text.js';
import { statServerLocalFile } from './workspace-stat-file.js';
import {
  getServerLocalIndexSnapshot,
  getServerLocalWorkspaceState,
  queryServerLocalIndex,
  updateServerLocalWorkspaceRevision,
  type ServerLocalWorkspaceState
} from './server-local-workspace-index.js';

export class ServerLocalWorkspaceProvider implements WorkspaceProvider {
  readonly kind = 'server_local' as const;
  private readonly state: ServerLocalWorkspaceState;

  constructor(
    private readonly rootPath: string,
    revision?: WorkspaceRevision,
    private readonly writable = true,
    options: { indexCacheDirectory?: string } = {}
  ) {
    this.state = getServerLocalWorkspaceState(rootPath, options.indexCacheDirectory);
    if (revision && revision.id !== this.state.revision.id) updateServerLocalWorkspaceRevision(rootPath, this.state, revision);
  }

  capabilities(): WorkspaceCapabilities {
    return { read: true, write: this.writable, command: true, test: true };
  }

  async getRevision(): Promise<WorkspaceRevision> {
    return this.state.revision;
  }

  async getIndexSnapshot(input: WorkspaceIndexSnapshotInput): Promise<WorkspaceIndexSnapshotPage> {
    return getServerLocalIndexSnapshot(this.state, input);
  }

  async queryWorkspaceIndex(input: WorkspaceIndexQueryInput): Promise<WorkspaceIndexQueryResult> {
    return queryServerLocalIndex(this.state, input);
  }

  listDirectory(input: ListDirectoryInput): Promise<ListDirectoryResult> {
    return listServerLocalDirectory({ rootPath: this.rootPath, revision: this.state.revision, input });
  }

  statFile(input: StatFileInput): Promise<FileMetadata> {
    return statServerLocalFile({ rootPath: this.rootPath, revision: this.state.revision, input });
  }

  readFile(input: ReadFileInput): Promise<ReadFileResult> {
    return readServerLocalFile({ rootPath: this.rootPath, revision: this.state.revision, input });
  }

  searchText(input: SearchTextInput): Promise<SearchTextResult> {
    return searchServerLocalText({ rootPath: this.rootPath, revision: this.state.revision, input });
  }

  async applyChangeSet(input: WorkspaceChangeSet): Promise<ApplyChangeSetResult> {
    if (!this.writable) throw new Error('server_local workspace is read-only');
    const result = await applyServerLocalChangeSet({
      rootPath: this.rootPath,
      currentRevision: this.state.revision,
      changeSet: input
    });
    updateServerLocalWorkspaceRevision(this.rootPath, this.state, result.revision);
    return result;
  }
}
