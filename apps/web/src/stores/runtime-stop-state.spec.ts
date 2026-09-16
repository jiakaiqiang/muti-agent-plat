import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { RuntimeStopSummary } from '@/types/contracts'
import { useSessionStore } from './session'

function summary(version: number, status: RuntimeStopSummary['status'], updatedAt: string): RuntimeStopSummary {
  return {
    sessionId: 'session-1',
    stopRequestId: 'stop-1',
    version,
    status,
    requestedCount: 1,
    confirmedCount: status === 'confirmed' ? 1 : 0,
    targets: [{ invocationId: 'invocation-1', state: status === 'confirmed' ? 'confirmed' : 'waiting', updatedAt }],
    blockers: status === 'confirmed' ? [] : [{ invocationId: 'invocation-1', reason: 'process_running', message: '等待结束' }],
    canResume: status === 'confirmed',
    updatedAt
  }
}

describe('runtime stop-state convergence', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('does not let an older SSE version overwrite a newer snapshot', () => {
    const store = useSessionStore()
    expect(store.applyStopState(summary(3, 'confirmed', '2026-09-15T00:00:03.000Z'))).toBe(true)
    expect(store.applyStopState(summary(2, 'waiting', '2026-09-15T00:00:02.000Z'))).toBe(false)
    expect(store.stopStatesBySession['session-1']?.status).toBe('confirmed')
  })

  it('accepts a newer stop round but rejects an older round by timestamp', () => {
    const store = useSessionStore()
    store.applyStopState(summary(3, 'confirmed', '2026-09-15T00:00:03.000Z'))
    expect(store.applyStopState({ ...summary(1, 'waiting', '2026-09-15T00:00:04.000Z'), stopRequestId: 'stop-2' })).toBe(true)
    expect(store.applyStopState({ ...summary(9, 'confirmed', '2026-09-15T00:00:01.000Z'), stopRequestId: 'stop-old' })).toBe(false)
  })

  it('fails closed when the authoritative stop-state query fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'stop-state unavailable' }
    }), { status: 503, headers: { 'content-type': 'application/json' } })))
    const store = useSessionStore()
    store.applyStopState(summary(3, 'confirmed', '2026-09-15T00:00:03.000Z'))

    const result = await store.loadStopState('session-1')

    expect(result.status).toBe('unknown')
    expect(result.canResume).toBe(false)
    expect(result.stopRequestId).toBe('stop-1')
    expect(result.version).toBe(3)
    expect(result.blockers).toEqual([{
      reason: 'state_query_failed',
      message: '停止状态查询失败，暂不能确认是否可继续。'
    }])
    expect(store.stopStateErrorsBySession['session-1']).toContain('stop-state unavailable')
  })
})
