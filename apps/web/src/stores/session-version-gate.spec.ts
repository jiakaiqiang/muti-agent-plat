import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { runtimeHealthCompatible, useSessionStore } from './session'

function apiResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(status >= 400 ? { error: data } : { data, requestId: 'version-gate-spec' }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function health(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    service: 'agent-cluster-server',
    version: '0.1.0',
    buildTime: '2026-07-13T01:00:00.000Z',
    commit: 'abc1234',
    processId: 48020,
    startedAt: '2026-07-13T01:00:00.000Z',
    pipelineVersion: 'v2',
    dataSchemaVersion: 3,
    dataEpoch: 'epoch-v3',
    persistenceBackend: 'file',
    persistenceLocation: 'D:\\data\\state.v3.json',
    maintenanceMode: false,
    timestamp: '2026-07-13T01:01:00.000Z',
    ...overrides
  }
}

describe('session backend version gate', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('allows session listing only after a schema v3 health response', async () => {
    fetchMock
      .mockResolvedValueOnce(apiResponse(health()))
      .mockResolvedValueOnce(apiResponse({ items: [], hasMore: false }))

    await useSessionStore().loadSessions()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/health')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/sessions')
  })

  it('blocks listing and resume when backend schema is not v3', async () => {
    fetchMock.mockImplementation(async () => apiResponse(health({ dataSchemaVersion: 1 })))
    const store = useSessionStore()

    await expect(store.loadSessions()).rejects.toThrow('BACKEND_VERSION_MISMATCH')
    await expect(store.resumeSession('legacy-session')).rejects.toThrow('BACKEND_VERSION_MISMATCH')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/sessions'))).toBe(false)
  })

  it('detects an explicitly configured backend commit mismatch', () => {
    expect(runtimeHealthCompatible(health() as never, 'different-commit')).toBe(false)
    expect(runtimeHealthCompatible(health() as never, 'abc1234')).toBe(true)
  })
})
