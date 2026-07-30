export class WorkspaceRequestTimeoutError extends Error {
  readonly code = 'WORKSPACE_REQUEST_TIMEOUT';
  readonly requestId: string;
  readonly workspaceId: string;
  readonly timeoutMs: number;

  constructor(requestId: string, workspaceId: string, timeoutMs: number) {
    super(`workspace request ${requestId} timed out after ${timeoutMs}ms`);
    this.name = 'WorkspaceRequestTimeoutError';
    this.requestId = requestId;
    this.workspaceId = workspaceId;
    this.timeoutMs = timeoutMs;
  }
}

export interface WithRequestTimeoutArgs<T> {
  requestId: string;
  workspaceId: string;
  timeoutMs: number;
  operation: Promise<T>;
  onTimeout?: (error: WorkspaceRequestTimeoutError) => void;
}

export function withRequestTimeout<T>(args: WithRequestTimeoutArgs<T>): Promise<T> {
  const { requestId, workspaceId, timeoutMs, operation, onTimeout } = args;
  if (timeoutMs <= 0) return operation;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new WorkspaceRequestTimeoutError(requestId, workspaceId, timeoutMs);
      onTimeout?.(error);
      reject(error);
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
