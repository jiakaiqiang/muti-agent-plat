import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from './session'
import { apiGet, apiPost } from '@/api/client'

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn(),
  apiPage: vi.fn(async () => ({ items: [] })),
  isNetworkRequestError: () => false, isSessionNotFoundError: () => false
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const detail = (id: string) => ({ id, updatedAt: '2026-09-29T00:00:00Z' }) as never

describe('session navigation isolation', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

  it('finishes an A confirmation without activating A after the user selects B', async () => {
    const store = useSessionStore()
    vi.spyOn(store, 'assertBackendCompatible').mockResolvedValue()
    const write = deferred<unknown>()
    vi.mocked(apiPost).mockReturnValue(write.promise)
    vi.mocked(apiGet).mockResolvedValue(detail('A'))
    store.currentSession = detail('A')
    const operation = store.resolveMemberAddition('A', 'discussion-A', { confirmationId: 'card-A', decision: 'approve' })
    await Promise.resolve()
    store.currentSession = detail('B')
    write.resolve({ session: detail('A') })
    await operation
    expect(store.currentSession?.id).toBe('B')
    expect(apiPost).toHaveBeenCalledWith('/sessions/A/discussions/discussion-A/member-addition', {
      confirmationId: 'card-A', decision: 'approve'
    })
  })
})
