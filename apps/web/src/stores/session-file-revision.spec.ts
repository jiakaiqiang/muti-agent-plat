import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { FileRevisionState, SessionDetail } from '@/types/contracts'
import { useSessionStore } from './session'

function apiResponse(data: unknown) {
  return new Response(JSON.stringify({ data, requestId: 'file-revision-store-spec' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function health() {
  return {
    status: 'ok',
    service: 'agent-cluster-server',
    version: '0.1.0',
    buildTime: '2026-07-29T00:00:00.000Z',
    buildId: 'build-test',
    runtimeBuildStale: false,
    commit: 'test',
    processId: 1,
    startedAt: '2026-07-29T00:00:00.000Z',
    pipelineVersion: 'v2',
    dataSchemaVersion: 3,
    dataEpoch: 'epoch-v3',
    persistenceBackend: 'file',
    persistenceLocation: 'test',
    maintenanceMode: false,
    timestamp: '2026-07-29T00:00:00.000Z'
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function state(revisionId: string): FileRevisionState {
  return {
    baselines: [],
    chains: [],
    drafts: [],
    runs: [{ id: revisionId } as FileRevisionState['runs'][number]]
  }
}

describe('session file revision state isolation', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('ignores an older same-session response and keeps different sessions isolated', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    let sessionOneRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return apiResponse(health())
      if (url.endsWith('/sessions/session-1/file-revisions')) {
        sessionOneRequests += 1
        return sessionOneRequests === 1 ? first.promise : second.promise
      }
      if (url.endsWith('/sessions/session-2/file-revisions')) return apiResponse(state('revision-session-2'))
      throw new Error(`Unexpected request: ${url}`)
    }))
    const store = useSessionStore()

    const olderRequest = store.loadFileRevisions('session-1')
    await Promise.resolve()
    const newerRequest = store.loadFileRevisions('session-1')
    await Promise.resolve()
    second.resolve(apiResponse(state('revision-new')))
    await newerRequest
    first.resolve(apiResponse(state('revision-old')))
    await olderRequest
    await store.loadFileRevisions('session-2')

    expect(store.fileRevisionStatesBySession['session-1']?.runs[0]?.id).toBe('revision-new')
    expect(store.fileRevisionStatesBySession['session-2']?.runs[0]?.id).toBe('revision-session-2')
  })

  it('does not let a late file revision decision refresh replace the newly selected session', async () => {
    const oldSessionRefresh = deferred<Response>()
    const oldSession = { id: 'session-1', title: 'old' } as SessionDetail
    const newSession = { id: 'session-2', title: 'new' } as SessionDetail
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return apiResponse(health())
      if (url.endsWith('/sessions/session-1/file-revisions/revision-1/decision') && init?.method === 'POST') {
        return apiResponse({ applied: true })
      }
      if (url.endsWith('/sessions/session-1/file-revisions')) return apiResponse(state('revision-1'))
      if (url.endsWith('/sessions/session-1')) return oldSessionRefresh.promise
      throw new Error(`Unexpected request: ${url}`)
    }))
    const store = useSessionStore()
    store.currentSession = oldSession

    const decision = store.decideFileRevision('session-1', 'revision-1', {
      confirmationId: 'confirmation-1',
      candidateHash: { algorithm: 'sha256', value: 'a'.repeat(64) },
      expectedStateVersion: 2,
      decision: 'apply_candidate'
    })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/sessions/session-1'),
      expect.anything()
    ))
    store.currentSession = newSession
    oldSessionRefresh.resolve(apiResponse(oldSession))
    await decision

    expect(store.currentSession?.id).toBe('session-2')
    expect(store.currentSession?.title).toBe('new')
  })

  it('does not let a late draft read overwrite a newer saved draft', async () => {
    const staleDraftRead = deferred<Response>()
    const candidateHash = { algorithm: 'sha256' as const, value: 'a'.repeat(64) }
    const freshContent = 'fresh saved draft'
    const draftMetadata = {
      chainId: 'chain-1',
      sourceRevisionId: 'revision-1',
      sourceCandidateHash: candidateHash,
      contentRef: 'sha256:fresh',
      contentHash: { algorithm: 'sha256' as const, value: 'b'.repeat(64) },
      sizeBytes: freshContent.length,
      updatedBy: { type: 'user' as const, id: 'user-1' },
      updatedAt: '2026-07-29T00:00:00.000Z'
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return apiResponse(health())
      if (url.endsWith('/sessions/session-1/file-revisions/revision-1/draft')) {
        if (init?.method === 'PUT') return apiResponse(draftMetadata)
        return staleDraftRead.promise
      }
      if (url.endsWith('/sessions/session-1/file-revisions')) return apiResponse(state('revision-1'))
      throw new Error(`Unexpected request: ${url}`)
    }))
    const store = useSessionStore()
    store.currentSession = { id: 'session-1' } as SessionDetail

    const staleLoad = store.loadFileRevisionDraft('session-1', 'revision-1')
    await Promise.resolve()
    await store.saveFileRevisionDraft('session-1', 'revision-1', candidateHash, freshContent)
    staleDraftRead.resolve(apiResponse({ ...draftMetadata, content: 'stale draft' }))
    await staleLoad

    expect(store.fileRevisionDraftFor('session-1', 'revision-1')?.content).toBe(freshContent)
  })

  it('clears a cached draft when the current revision has no saved draft', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return apiResponse(health())
      if (url.endsWith('/sessions/session-1/file-revisions/revision-1/draft')) return apiResponse(null)
      throw new Error(`Unexpected request: ${url}`)
    }))
    const store = useSessionStore()
    store.currentSession = { id: 'session-1' } as SessionDetail
    store.fileRevisionDraftContents['session-1:revision-1'] = {
      chainId: 'chain-1',
      sourceRevisionId: 'revision-1',
      sourceCandidateHash: { algorithm: 'sha256', value: 'a'.repeat(64) },
      contentRef: 'sha256:stale',
      contentHash: { algorithm: 'sha256', value: 'b'.repeat(64) },
      sizeBytes: 11,
      updatedBy: { type: 'user', id: 'user-1' },
      updatedAt: '2026-07-29T00:00:00.000Z',
      content: 'stale draft'
    }

    await store.loadFileRevisionDraft('session-1', 'revision-1')

    expect(store.fileRevisionDraftFor('session-1', 'revision-1')).toBeUndefined()
  })
})
