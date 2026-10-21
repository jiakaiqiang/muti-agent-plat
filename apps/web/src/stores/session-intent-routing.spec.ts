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
  it('submits the clicked draft revision with explicit question answers and a version-bound request', async () => {
    let body: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return apiResponse(health())
      if (url.endsWith('/sessions/session-1')) return apiResponse({ ...session, intentContractVersion: 'intent-understanding-v1' })
      if (url.endsWith('/briefs')) return apiResponse([{ id: 'original', sessionId: session.id, version: 3, intentBinding: { intentRevision: 4 } }])
      if (url.endsWith('/briefs/original/reject')) {
        body = JSON.parse(String(init?.body))
        return apiResponse({ accepted: true, sessionId: session.id, briefId: 'original', dataEpoch: session.dataEpoch,
          status: 'REVISING_BRIEF', routingId: 'revision-route', request: body, idempotentReplay: false })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    const store = useSessionStore(); store.currentSession = { ...session, id: 'other-selected-session' }
    await store.reviseBrief(session.id, 'original', { confirmationId: 'original-card', userMessage: '补充部署要求',
      reason: '用户修改', questionAnswers: [{ question: '区域？', answer: '华东' }] })
    expect(body).toMatchObject({ contractVersion: 'intent-brief-revise-v1', expectedBriefVersion: 3, expectedIntentRevision: 4,
      confirmationId: 'original-card', userMessage: '补充部署要求', questionAnswers: [{ question: '区域？', answer: '华东' }] })
    expect(body).not.toHaveProperty('reason'); expect(store.currentSession?.id).toBe('other-selected-session')
  })
  it('binds new-contract brief approval to the clicked brief even when another session is selected', async () => {
    let body: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return apiResponse(health())
      if (url.endsWith('/sessions/session-1')) return apiResponse({ ...session, intentContractVersion: 'intent-understanding-v1' })
      if (url.endsWith('/briefs')) return apiResponse([{ id: 'clicked', sessionId: session.id, version: 3, intentBinding: { intentRevision: 4 } },
        { id: 'latest-other', sessionId: session.id, version: 7, intentBinding: { intentRevision: 8 } }])
      if (url.endsWith('/briefs/clicked/confirm')) {
        body = JSON.parse(String(init?.body))
        return apiResponse({ accepted: true, sessionId: session.id, briefId: 'clicked', dataEpoch: session.dataEpoch,
          status: 'WAIT_WORKFLOW_SELECT', idempotentReplay: false, receipt: { id: 'receipt', request: body, resultStatus: 'WAIT_WORKFLOW_SELECT' } })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    const store = useSessionStore(); store.currentSession = { ...session, id: 'other-selected-session' }
    await store.confirmBrief(session.id, 'clicked', 'clicked-card')
    expect(body).toMatchObject({ contractVersion: 'intent-brief-confirm-v1', confirmationId: 'clicked-card',
      expectedBriefVersion: 3, expectedIntentRevision: 4, dataEpoch: session.dataEpoch })
    expect(store.currentSession?.id).toBe('other-selected-session')
  })
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

function routed(revision = 4): IntentRoutingRecord {
  return { id: 'routing-1', sessionId: session.id, sourceEventId: 'event-message', sessionSeq: 1,
    status: 'ROUTED', routingRevision: revision, policyVersion: 'intent-policy-v1', rolloutMode: 'enforce_all_current_epoch',
    reasonCodes: [], retryCount: 0, idempotencyKey: 'route-1', createdAt: '', updatedAt: '' }
}

describe('Versioned clarification and blocked state', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('ignores stale routing responses and records blocked as terminal', async () => {
    const store = useSessionStore()
    store.recordIntentRouting(session.id, { ...routed(5), status: 'BLOCKED', blockedReason: 'INTENT_AUTH_FAILED' })
    store.recordIntentRouting(session.id, { ...routed(3), status: 'CLASSIFYING' })
    store.recordIntentRouting('unrelated-session', routed(99))
    expect(store.intentRoutingsById['routing-1'].routingRevision).toBe(5)
    expect(store.intentRoutingsById['routing-1'].status).toBe('BLOCKED')
    expect(store.pendingIntentRoutingCount(session.id)).toBe(0)
  })

  it('binds retries to the original session, confirmation and choice after navigation', async () => {
    const posts: Array<{url: string; body: Record<string, unknown>}> = []
    let failFirst = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return apiResponse(health())
      if (url.endsWith('/clarify')) {
        posts.push({ url, body: JSON.parse(String(init?.body)) })
        if (failFirst) { failFirst = false; throw new TypeError('Network response lost') }
        return apiResponse({ routing: routed(), workItem })
      }
      if (url.endsWith('/work-items')) return apiResponse({ items: [workItem], hasMore: false })
      if (url.endsWith('/sessions/session-1')) return apiResponse(session)
      throw new Error(`Unexpected request: ${url}`)
    }))
    const store = useSessionStore()
    store.currentSession = structuredClone(session)
    const input = { choice: 'independent_new' as const, confirmationId: 'card-1', expectedRoutingRevision: 3 }
    await expect(store.clarifyIntentRouting(session.id, 'routing-1', input)).rejects.toThrow()
    store.currentSession = { ...session, id: 'session-2' }
    await store.clarifyIntentRouting(session.id, 'routing-1', input)
    expect(posts).toHaveLength(2)
    expect(posts[0]).toEqual(posts[1])
    expect(posts[1].body.contractVersion).toBe('intent-clarify-v1')
    expect(posts[1].body.idempotencyKey).toBeTruthy()
    expect(posts[1].url).toContain('/sessions/session-1/')
    expect(store.currentSession.id).toBe('session-2')
  })

  it('refreshes authoritative state after a 409 and preserves the conflict error', async () => {
    const reads: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return apiResponse(health())
      if (url.endsWith('/clarify')) return new Response(JSON.stringify({ error: { code: 'CLARIFICATION_CHOICE_CONFLICT', message: 'choice conflict' } }), {
        status: 409, headers: { 'content-type': 'application/json' }
      })
      reads.push(url)
      if (url.endsWith('/message-routings/routing-1')) return apiResponse(routed(8))
      if (url.endsWith('/work-items')) return apiResponse({ items: [workItem], hasMore: false })
      if (url.endsWith('/sessions/session-1')) return apiResponse(session)
      throw new Error(`Unexpected request: ${url}`)
    }))
    const store = useSessionStore()
    store.currentSession = structuredClone(session)
    await expect(store.clarifyIntentRouting(session.id, 'routing-1', { choice: 'continue_current', confirmationId: 'card-1',
      expectedRoutingRevision: 3 })).rejects.toMatchObject({ status: 409, code: 'CLARIFICATION_CHOICE_CONFLICT' })
    expect(store.intentRoutingsById['routing-1'].routingRevision).toBe(8)
    expect(reads.some(url => url.endsWith('/work-items'))).toBe(true)
  })
})
