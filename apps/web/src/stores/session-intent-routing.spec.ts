import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { IntentRoutingRecord, SessionDetail, WorkItem } from '@/types/contracts'
import { useSessionStore } from './session'

function apiResponse(data: unknown) {
  return new Response(JSON.stringify({ data, requestId: 'intent-routing-spec' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function health() {
  return {
    status: 'ok', service: 'agent-cluster-server', version: '0.1.0',
    buildTime: '2026-08-07T00:00:00.000Z', buildId: 'build-intent', runtimeBuildStale: false,
    commit: 'intent', processId: 1, startedAt: '2026-08-07T00:00:00.000Z',
    pipelineVersion: 'v2', dataSchemaVersion: 3, dataEpoch: 'epoch-v3',
    persistenceBackend: 'file', persistenceLocation: 'state.v3.json', maintenanceMode: false,
    timestamp: '2026-08-07T00:00:01.000Z'
  }
}

const session = {
  id: 'session-1', dataEpoch: 'epoch-v3', revision: 2, activeWorkItemId: 'work-1',
  title: 'Intent routing', originalInput: 'Keep decisions', status: 'COMPLETED',
  ownerId: 'user-1', workspaceId: 'workspace-1', tokenUsed: 0, participatingAgentIds: [],
  createdAt: '2026-08-07T00:00:00.000Z', updatedAt: '2026-08-07T00:00:00.000Z'
} as SessionDetail

const workItem: WorkItem = {
  id: 'work-1', sessionId: 'session-1', title: 'Keep decisions', goal: 'Keep decisions',
  status: 'OPEN', revision: 1, createdFromEventId: 'event-initial',
  inheritedDecisionIds: [], inheritedArtifactIds: [],
  createdAt: '2026-08-07T00:00:00.000Z', updatedAt: '2026-08-07T00:00:00.000Z'
}

describe('Session intent routing state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends an idempotency key and exposes pending routing until the server reaches a terminal state', async () => {
    let resolveRouting!: (response: Response) => void
    const pendingRouting = new Promise<Response>((resolve) => { resolveRouting = resolve })
    let messageHeaders: Headers | undefined
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return apiResponse(health())
      if (url.endsWith('/sessions/session-1/messages')) {
        messageHeaders = new Headers(init?.headers)
        return apiResponse({
          event: {
            id: 'event-message', sessionId: 'session-1', type: 'user_message', content: '继续',
            priority: 'normal', metadata: { renderAs: 'chat_message' },
            createdAt: '2026-08-07T00:00:01.000Z'
          },
          routingId: 'routing-1', routingStatus: 'SNAPSHOT_READY'
        })
      }
      if (url.endsWith('/sessions/session-1/message-routings/routing-1')) return pendingRouting
      if (url.endsWith('/sessions/session-1/work-items')) {
        return apiResponse({ items: [workItem], hasMore: false })
      }
      if (url.endsWith('/sessions/session-1')) return apiResponse(session)
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = useSessionStore()
    store.currentSession = structuredClone(session)

    const result = await store.sendMessage('session-1', '继续')

    expect(result.routingId).toBe('routing-1')
    expect(messageHeaders?.get('Idempotency-Key')).toBeTruthy()
    expect(store.pendingIntentRoutingCount('session-1')).toBe(1)

    const routed: IntentRoutingRecord = {
      id: 'routing-1', sessionId: 'session-1', sourceEventId: 'event-message', sessionSeq: 1,
      status: 'ROUTED', policyVersion: 'intent-v2.1', rolloutMode: 'enforce_all_current_epoch',
      reasonCodes: [], retryCount: 0, idempotencyKey: 'route-key',
      createdAt: '2026-08-07T00:00:01.000Z', updatedAt: '2026-08-07T00:00:02.000Z'
    }
    resolveRouting(apiResponse(routed))

    await vi.waitFor(() => expect(store.pendingIntentRoutingCount('session-1')).toBe(0))
    await vi.waitFor(() => expect(store.activeWorkItem?.id).toBe('work-1'))
  })
})
