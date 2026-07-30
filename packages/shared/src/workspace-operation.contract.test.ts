import type {
  WorkspaceOperationKind,
  WorkspaceOperationRequest,
  WorkspaceOperationResult,
  WorkspaceOperationStatus
} from './contracts.js';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

type OperationKindsAreStable = Assert<
  IsExact<
    WorkspaceOperationKind,
    | 'capabilities'
    | 'getRevision'
    | 'getIndexSnapshot'
    | 'queryWorkspaceIndex'
    | 'listDirectory'
    | 'statFile'
    | 'readFile'
    | 'searchText'
    | 'applyChangeSet'
  >
>;

type StatusesAreStable = Assert<
  IsExact<WorkspaceOperationStatus, 'pending' | 'ok' | 'error'>
>;

const readRequest: WorkspaceOperationRequest = {
  requestId: '00000000-0000-4000-8000-000000000091',
  invocationId: '00000000-0000-4000-8000-000000000191',
  workspaceId: 'ws-91',
  operation: 'readFile',
  input: { path: 'src/index.ts' }
};

const listRequest: WorkspaceOperationRequest = {
  requestId: '00000000-0000-4000-8000-000000000092',
  invocationId: '00000000-0000-4000-8000-000000000192',
  workspaceId: 'ws-91',
  operation: 'listDirectory',
  input: { path: 'src', limit: 20 }
};

const okResult: WorkspaceOperationResult<{ path: string }> = {
  requestId: '00000000-0000-4000-8000-000000000091',
  workspaceId: 'ws-91',
  operation: 'readFile',
  status: 'ok',
  data: { path: 'src/index.ts' }
};

const errorResult: WorkspaceOperationResult = {
  requestId: '00000000-0000-4000-8000-000000000091',
  workspaceId: 'ws-91',
  operation: 'readFile',
  status: 'error',
  error: { code: 'ENOENT', message: 'not found' }
};

void readRequest;
void listRequest;
void okResult;
void errorResult;
