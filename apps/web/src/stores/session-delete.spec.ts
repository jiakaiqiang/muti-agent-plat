import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  SESSION_DELETE_REQUEST_TIMEOUT_MS,
  useSessionStore
} from './session'

function apiResponse(data: unknown) {
  return new Response(JSON.stringify({ data, requestId: 'session-delete-spec' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function health() {
  return {
    status: 'ok',
    service: 'agent-cluster-server',
    version: '0.1.0',
    buildTime: '2026-07-25T00:00:00.000Z',
    buildId: 'build-abc1234',
    runtimeBuildStale: false,
    commit: 'abc1234',
    processId: 48020,
    startedAt: '2026-07-25T00:00:00.000Z',
    pipelineVersion: 'v2',
    dataSchemaVersion: 3,
    dataEpoch: 'epoch-v3',
    persistenceBackend: 'file',
    persistenceLocation: 'D:\\data\\state.v3.json',
    maintenanceMode: false,
    timestamp: '2026-07-25T00:01:00.000Z'
  }
}

function seedSession() {
  const store = useSessionStore()
  store.sessions = [{
    id: 'session-1',
    title: 'Delete timeout regression',
    status: 'FAILED',
    agentCount: 1,
    requiresUserAction: false,
    tokenBudget: 1_000,
    tokenUsed: 0,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z'
  }]
  return store
}

describe('session deletion failure recovery', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('releases deleting state when the delete request never returns', async () => {
    fetchMock
      .mockResolvedValueOnce(apiResponse(health()))
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
    const store = seedSession()

    const deletion = store.deleteSession('session-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(store.deletingSessionIds).toContain('session-1')

    const rejection = expect(deletion).rejects.toThrow('删除会话请求超时')
    await vi.advanceTimersByTimeAsync(SESSION_DELETE_REQUEST_TIMEOUT_MS)
    await rejection

    expect(store.deletingSessionIds).not.toContain('session-1')
    expect(store.sessions.map((session) => session.id)).toContain('session-1')
  })

  it('turns a disconnected backend into an actionable error and releases deleting state', async () => {
    fetchMock
      .mockResolvedValueOnce(apiResponse(health()))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const store = seedSession()

    await expect(store.deleteSession('session-1')).rejects.toThrow('后端连接已中断')

    expect(store.deletingSessionIds).not.toContain('session-1')
    expect(store.sessions.map((session) => session.id)).toContain('session-1')
  })
})
