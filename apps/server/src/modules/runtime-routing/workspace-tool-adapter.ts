import type {
  ListDirectoryInput,
  ListDirectoryResult,
  ReadFileInput,
  ReadFileResult,
  SearchTextInput,
  SearchTextResult,
  StatFileInput,
  FileMetadata
} from '@agent-cluster/shared';
import type { WorkspaceProvider } from '../workspaces/workspace-provider.js';

export interface WorkspaceToolAdapter {
  list(input: ListDirectoryInput): Promise<ListDirectoryResult>;
  stat(input: StatFileInput): Promise<FileMetadata>;
  read(input: ReadFileInput): Promise<ReadFileResult>;
  search(input: SearchTextInput): Promise<SearchTextResult>;
}

export function createWorkspaceToolAdapter(provider: WorkspaceProvider): WorkspaceToolAdapter {
  return {
    list: (input) => provider.listDirectory(input),
    stat: (input) => provider.statFile(input),
    read: (input) => provider.readFile(input),
    search: (input) => provider.searchText(input)
  };
}
