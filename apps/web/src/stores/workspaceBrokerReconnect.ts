const INITIAL_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 30_000

export function workspaceBrokerReconnectDelay(
  registeredWorkspaceCount: number,
  reconnectAlreadyScheduled: boolean,
  failedAttempts = 0
): number | undefined {
  if (registeredWorkspaceCount <= 0 || reconnectAlreadyScheduled) return undefined
  const exponent = Math.max(0, Math.min(10, Math.floor(failedAttempts)))
  return Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * 2 ** exponent)
}
