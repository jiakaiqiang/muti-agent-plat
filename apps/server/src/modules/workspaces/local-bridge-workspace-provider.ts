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
import { BrokerWorkspaceProvider, type BrokerWorkspaceProviderOptions } from './runtime-broker/broker-workspace-provider.js';
import type { WorkspaceProvider } from './workspace-provider.js';

export class LocalBridgeWorkspaceProvider implements WorkspaceProvider {
  readonly kind = 'local_bridge' as const;
  private readonly delegate: BrokerWorkspaceProvider;

  constructor(workspaceId: string, options: BrokerWorkspaceProviderOptions) {
    this.delegate = new BrokerWorkspaceProvider(workspaceId, options);
  }

  capabilities(): WorkspaceCapabilities { return this.delegate.capabilities(); }
  getRevision(): Promise<WorkspaceRevision> { return this.delegate.getRevision(); }
  getIndexSnapshot(input: WorkspaceIndexSnapshotInput): Promise<WorkspaceIndexSnapshotPage> { return this.delegate.getIndexSnapshot(input); }
  queryWorkspaceIndex(input: WorkspaceIndexQueryInput): Promise<WorkspaceIndexQueryResult> { return this.delegate.queryWorkspaceIndex(input); }
  listDirectory(input: ListDirectoryInput): Promise<ListDirectoryResult> { return this.delegate.listDirectory(input); }
  statFile(input: StatFileInput): Promise<FileMetadata> { return this.delegate.statFile(input); }
  readFile(input: ReadFileInput): Promise<ReadFileResult> { return this.delegate.readFile(input); }
  searchText(input: SearchTextInput): Promise<SearchTextResult> { return this.delegate.searchText(input); }
  applyChangeSet(input: WorkspaceChangeSet): Promise<ApplyChangeSetResult> { return this.delegate.applyChangeSet(input); }
}
