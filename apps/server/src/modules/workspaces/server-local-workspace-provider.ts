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
  WorkspaceRevision
} from '@agent-cluster/shared';
import { applyServerLocalChangeSet } from './workspace-apply-change-set.js';
import { listServerLocalDirectory } from './workspace-list-directory.js';
import type { WorkspaceProvider } from './workspace-provider.js';
import { readServerLocalFile } from './workspace-read-file.js';
import { createWorkspaceRevision } from './workspace-revision.js';
import { searchServerLocalText } from './workspace-search-text.js';
import { statServerLocalFile } from './workspace-stat-file.js';

export class ServerLocalWorkspaceProvider implements WorkspaceProvider {
  readonly kind = 'server_local' as const;
  private revision: WorkspaceRevision;

  constructor(
    private readonly rootPath: string,
    revision: WorkspaceRevision = createWorkspaceRevision(),
    private readonly writable = true
  ) {
    this.revision = revision;
  }

  capabilities(): WorkspaceCapabilities {
    return { read: true, write: this.writable, command: true, test: true };
  }

  async getRevision(): Promise<WorkspaceRevision> {
    return this.revision;
  }

  listDirectory(input: ListDirectoryInput): Promise<ListDirectoryResult> {
    return listServerLocalDirectory({ rootPath: this.rootPath, revision: this.revision, input });
  }

  statFile(input: StatFileInput): Promise<FileMetadata> {
    return statServerLocalFile({ rootPath: this.rootPath, revision: this.revision, input });
  }

  readFile(input: ReadFileInput): Promise<ReadFileResult> {
    return readServerLocalFile({ rootPath: this.rootPath, revision: this.revision, input });
  }

  searchText(input: SearchTextInput): Promise<SearchTextResult> {
    return searchServerLocalText({ rootPath: this.rootPath, revision: this.revision, input });
  }

  async applyChangeSet(input: WorkspaceChangeSet): Promise<ApplyChangeSetResult> {
    if (!this.writable) throw new Error('server_local workspace is read-only');
    const result = await applyServerLocalChangeSet({
      rootPath: this.rootPath,
      currentRevision: this.revision,
      changeSet: input
    });
    this.revision = result.revision;
    return result;
  }
}
