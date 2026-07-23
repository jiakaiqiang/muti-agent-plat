import { describe, expect, it } from 'vitest'
import {
  claimRouteRecovery,
  clearRouteRecovery,
  isRouteModuleLoadError,
  routeRecoveryKey
} from './routeLoadRecovery'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  }
}

describe('route module recovery', () => {
  it('recognizes browser and bundler dynamic-import failures', () => {
    expect(isRouteModuleLoadError(new TypeError('Failed to fetch dynamically imported module'))).toBe(true)
    expect(isRouteModuleLoadError(new Error('ChunkLoadError: Loading chunk 12 failed'))).toBe(true)
    expect(isRouteModuleLoadError(new Error('ordinary component error'))).toBe(false)
  })

  it('allows only one cold recovery per route until navigation succeeds', () => {
    const storage = memoryStorage()

    expect(claimRouteRecovery(storage, '/agents')).toBe(true)
    expect(claimRouteRecovery(storage, '/agents')).toBe(false)
    expect(storage.getItem(routeRecoveryKey('/agents'))).toBeTruthy()

    clearRouteRecovery(storage, '/agents')
    expect(claimRouteRecovery(storage, '/agents')).toBe(true)
  })
})
