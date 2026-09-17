import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  SESSION_DELETE_REQUEST_TIMEOUT_MS,
  useSessionStore
} from './session'

function apiResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data, requestId: 'session-delete-spec' }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function page(items: unknown[]) {
  return { items, page: 1, pageSize: 50, total: items.length }
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

  it('keeps a Session visible when deletion is accepted but still stopping', async () => {
    const deleting = {
      ...seedSession().sessions[0]!,
      lifecycleState: 'deleting' as const,
      lifecycleAdmission: 'closed' as const,
      lifecycleGeneration: 2,
      lifecycleRevision: 2,
      lifecycleStopStatus: 'pending' as const
    }
    fetchMock
      .mockResolvedValueOnce(apiResponse(health()))
      .mockResolvedValueOnce(apiResponse({
        sessionId: deleting.id,
        deleted: false,
        lifecycle: {
          sessionId: deleting.id,
          dataEpoch: 'epoch-v3',
          generation: 2,
          revision: 2,
          state: 'deleting',
          admission: 'closed',
          stopStatus: 'pending'
        }
      }, 202))
      .mockResolvedValueOnce(apiResponse(page([deleting])))
    const store = useSessionStore()

    await expect(store.deleteSession(deleting.id)).resolves.toBe(false)

    expect(store.sessions).toEqual([expect.objectContaining({
      id: deleting.id,
      lifecycleState: 'deleting'
    })])
    expect(store.deletingSessionIds).toEqual([deleting.id])
  })

  it('retains deleted tombstones in the all-sessions projection', async () => {
    const deleted = {
      ...seedSession().sessions[0]!,
      status: 'PAUSED' as const,
      lifecycleState: 'deleted' as const,
      lifecycleAdmission: 'closed' as const,
      lifecycleGeneration: 3,
      lifecycleRevision: 4,
      lifecycleStopStatus: 'confirmed' as const
    }
    fetchMock
      .mockResolvedValueOnce(apiResponse(health()))
      .mockResolvedValueOnce(apiResponse(page([deleted])))
    const store = useSessionStore()

    await store.loadSessions()

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/sessions?visibility=all')
    expect(store.sessions).toEqual([expect.objectContaining({
      id: deleted.id,
      lifecycleState: 'deleted'
    })])
  })

  it('restores the current generation and refreshes the Session as paused', async () => {
    const store = seedSession()
    store.sessions[0] = {
      ...store.sessions[0]!,
      status: 'PAUSED',
      lifecycleState: 'deleted',
      lifecycleAdmission: 'closed',
      lifecycleGeneration: 7,
      lifecycleRevision: 8,
      lifecycleStopStatus: 'confirmed'
    }
    const restored = {
      ...store.sessions[0]!,
      lifecycleState: 'active' as const,
      lifecycleGeneration: 8,
      lifecycleRevision: 9
    }
    fetchMock
      .mockResolvedValueOnce(apiResponse(health()))
      .mockResolvedValueOnce(apiResponse({ session: restored, restored: true }))
      .mockResolvedValueOnce(apiResponse(page([restored])))

    await expect(store.restoreSession('session-1')).resolves.toEqual({ session: restored, restored: true })

    const restoreRequest = fetchMock.mock.calls[1]
    expect(String(restoreRequest?.[0])).toContain('/sessions/session-1/restore')
    expect(JSON.parse(String(restoreRequest?.[1]?.body))).toEqual(expect.objectContaining({ expectedGeneration: 7 }))
    expect(store.sessions[0]).toEqual(expect.objectContaining({
      status: 'PAUSED',
      lifecycleState: 'active',
      lifecycleGeneration: 8
    }))
  })
})
