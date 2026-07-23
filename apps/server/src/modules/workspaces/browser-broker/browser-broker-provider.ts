import { randomUUID } from 'node:crypto';
import type {
  ApplyChangeSetResult,
  FileMetadata,
  ListDirectoryInput,
  ListDirectoryResult,
  ReadFileInput,
  ReadFileResult, SearchTextInput, SearchTextResult, StatFileInput,
  WorkspaceCapabilities,
  WorkspaceChangeSet,
  WorkspaceOperationRequest,
  WorkspaceOperationResult,
  WorkspaceRevision
} from '@agent-cluster/shared';
import type { WorkspaceProvider } from '../workspace-provider.js';
import { BrokerGateway } from './broker-gateway.js';
import { PendingRequestRegistry } from './pending-request-registry.js';
import { withRequestTimeout } from './request-timeout.js';

export interface BrowserBrokerProviderOptions {
  gateway: BrokerGateway;
  pending: PendingRequestRegistry;
  timeoutMs?: number;
  makeRequestId?: () => string;
}

type BrokerRequestPayload = WorkspaceOperationRequest extends infer Request
  ? Request extends WorkspaceOperationRequest
    ? Omit<Request, 'requestId' | 'workspaceId'>
    : never
  : never;

export class BrowserBrokerProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BrowserBrokerProviderError';
    this.code = code;
  }
}

export class BrowserBrokerProvider implements WorkspaceProvider {
  readonly kind = 'browser_broker' as const;

  constructor(
    private readonly workspaceId: string,
    private readonly options: BrowserBrokerProviderOptions
  ) {}

  capabilities(): WorkspaceCapabilities {
    return this.options.gateway.getRegistration(this.workspaceId)?.capabilities ?? {
      read: false,
      write: false,
      command: false,
      test: false
    };
  }

  getRevision(): Promise<WorkspaceRevision> {
    return this.request({ operation: 'getRevision' });
  }

  listDirectory(input: ListDirectoryInput): Promise<ListDirectoryResult> {
    return this.request({ operation: 'listDirectory', input });
  }

  statFile(input: StatFileInput): Promise<FileMetadata> {
    return this.request({ operation: 'statFile', input });
  }

  readFile(input: ReadFileInput): Promise<ReadFileResult> {
    return this.request({ operation: 'readFile', input });
  }

  searchText(input: SearchTextInput): Promise<SearchTextResult> {
    return this.request({ operation: 'searchText', input });
  }

  applyChangeSet(input: WorkspaceChangeSet): Promise<ApplyChangeSetResult> {
    return this.request({ operation: 'applyChangeSet', input });
  }

  private async request<T>(request: BrokerRequestPayload): Promise<T> {
    const requestId = this.options.makeRequestId ? this.options.makeRequestId() : randomUUID();
    const waiter = this.options.pending.waitFor(requestId, this.workspaceId);
    this.options.gateway.dispatch({
      requestId,
      workspaceId: this.workspaceId,
      ...request
    } as WorkspaceOperationRequest);
    const result = await withRequestTimeout({
      requestId,
      workspaceId: this.workspaceId,
      timeoutMs: this.options.timeoutMs ?? 15_000,
      operation: waiter,
      onTimeout: () => this.options.pending.reject(requestId, new Error('timeout'))
    });
    return unwrapResult<T>(result);
  }
}

function unwrapResult<T>(result: WorkspaceOperationResult): T {
  if (result.status !== 'ok' || !result.data) {
    const message = result.error?.message ?? 'unknown broker error';
    throw new BrowserBrokerProviderError(result.error?.code ?? 'BROKER_ERROR', message);
  }
  return result.data as T;
}
