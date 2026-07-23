const workspaceWriteTails = new Map<string, Promise<unknown>>()

export async function runBrowserWorkspaceWrite<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const previous = workspaceWriteTails.get(workspaceId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  workspaceWriteTails.set(workspaceId, current)
  try {
    return await current
  } finally {
    if (workspaceWriteTails.get(workspaceId) === current) workspaceWriteTails.delete(workspaceId)
  }
}
