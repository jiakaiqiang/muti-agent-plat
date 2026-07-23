const routeRecoveryPrefix = 'agent-cluster.route-recovery:'

const recoverableRouteLoadMessages = [
  'failed to fetch dynamically imported module',
  'importing a module script failed',
  'chunkloaderror',
  'loading chunk',
  'failed to load module script'
]

export function isRouteModuleLoadError(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const normalized = message.toLowerCase()
  return recoverableRouteLoadMessages.some((pattern) => normalized.includes(pattern))
}

export function routeRecoveryKey(fullPath: string) {
  return `${routeRecoveryPrefix}${fullPath}`
}

export function claimRouteRecovery(storage: Pick<Storage, 'getItem' | 'setItem'>, fullPath: string) {
  const key = routeRecoveryKey(fullPath)
  if (storage.getItem(key)) return false
  storage.setItem(key, new Date().toISOString())
  return true
}

export function clearRouteRecovery(storage: Pick<Storage, 'removeItem'>, fullPath: string) {
  storage.removeItem(routeRecoveryKey(fullPath))
}
