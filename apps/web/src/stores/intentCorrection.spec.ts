import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { correctionKey, useIntentCorrectionStore } from './intentCorrection'
import { correctionStatusCopy, decisionsForCorrection, normalizeCorrectionTargets } from '@/utils/intentCorrectionModel'

const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
const route = (revision = 1) => ({ id: 'r1', sessionId: 's1', sourceEventId: 'e1', routingRevision: revision, status: 'ROUTED' })
const correction = (status = 'accepted', time = '2026-10-19T10:00:00Z') => ({
  id: 'c1', routingId: 'r1', sessionId: 's1', status, pendingIntentRevision: 2, routingRevision: status === 'applied' ? 7 : 5,
  request: { instruction: '超时改为 30 分钟' }, idempotencyKey: 'k1', updatedAt: time
})
const key = correctionKey('s1', 'r1')
const input = { instruction: '超时改为 30 分钟', targetWorkItemId: 'w1', supersedesDecisionId: 'd1', expectedDecisionRevision: 3 }
function readyStore() {
  const store = useIntentCorrectionStore()
  store.recordRoute({ id: 'r1', sessionId: 's1', sourceEventId: 'e1', revision: 4, status: 'ROUTED', held: false, targetWorkItemId: 'w1' })
  return store
}
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllGlobals())

describe('bound correction requests', () => {
  it('retries an uncertain POST with identical original session, revision, decision and content', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      if (calls.length === 1) throw new TypeError('Failed to fetch')
      return response({ correctionId: 'c1', routingId: 'r1', pendingIntentRevision: 2, routingRevision: 5, correctionStatus: 'accepted' })
    }))
    const store = readyStore()
    const original = { ...input }
    store.prepare('s1', 'r1', original)
    original.instruction = 'unrelated change'
    await expect(store.submit('s1', 'r1')).rejects.toThrow()
    store.recordRoute({ ...store.routes[key], revision: 50 })
    store.recordRoute({ ...store.routes[key], id: 'r2', sessionId: 's2' })
    expect(() => store.prepare('s1', 'r1', original)).toThrow('尚未确认')
    await store.submit('s1', 'r1')
    expect(calls[0]).toEqual(calls[1])
    expect(calls[0].url).toContain('/sessions/s1/message-routings/r1/corrections')
    expect(calls[0].body).toMatchObject({ ...input, expectedRoutingRevision: 4, contractVersion: 'intent-correction-v1' })
    expect(store.receipts[key].correctionStatus).toBe('accepted')
    expect(store.pending[key]).toBeUndefined()
  })

  it('refreshes a 409 but never automatically resubmits with the new revision', async () => {
    let posts = 0
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'POST') {
        posts++
        return new Response(JSON.stringify({ error: { code: 'ROUTING_REVISION_CONFLICT', message: 'conflict' } }), { status: 409 })
      }
      return String(url).endsWith('/corrections') ? response({ corrections: [correction('validating')] }) : response(route(9))
    }))
    const store = readyStore()
    store.prepare('s1', 'r1', input)
    await expect(store.submit('s1', 'r1')).rejects.toMatchObject({ status: 409 })
    expect(store.routes[key].revision).toBe(9)
    expect(store.histories[key][0].status).toBe('validating')
    expect(store.pending[key]).toBeUndefined()
    expect(posts).toBe(1)
  })

  it('reconciles a lost response by durable request identity without another POST', async () => {
    const store = readyStore()
    store.prepare('s1', 'r1', input)
    const requestKey = store.pending[key].payload.idempotencyKey
    vi.stubGlobal('fetch', vi.fn(async url => String(url).endsWith('/corrections')
      ? response({ corrections: [{ ...correction('applied'), idempotencyKey: requestKey }] }) : response(route(6))))
    await store.refresh('s1', 'r1')
    expect(store.pending[key]).toBeUndefined()
    expect(store.histories[key][0].status).toBe('applied')
  })

  it('ignores older responses arriving after a newer history read', async () => {
    const store = readyStore()
    const delayed: Array<(value: Response) => void> = []
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (++calls <= 2) return new Promise<Response>(resolve => delayed.push(resolve))
      return String(url).endsWith('/corrections')
        ? response({ corrections: [correction('applied', '2026-10-19T10:00:02Z')] }) : response(route(7))
    }))
    const oldRead = store.refresh('s1', 'r1')
    await store.refresh('s1', 'r1')
    delayed[0](response(route(5))); delayed[1](response({ corrections: [correction()] }))
    await oldRead
    expect(store.routes[key].revision).toBe(7)
    expect(store.histories[key][0].status).toBe('applied')
  })

  it('keeps the higher routing revision even when an older status has a later timestamp', async () => {
    const store = readyStore()
    let current = correction('applied')
    vi.stubGlobal('fetch', vi.fn(async url => String(url).endsWith('/corrections')
      ? response({ corrections: [current] }) : response(route(current.routingRevision))))
    await store.refresh('s1', 'r1')
    current = correction('accepted', '2026-10-19T11:00:00Z')
    await store.refresh('s1', 'r1')
    expect(store.histories[key][0].status).toBe('applied')
    expect(store.routes[key].revision).toBe(7)
  })

  it('refuses cross-session history and leaves previously verified state intact', async () => {
    const store = readyStore()
    vi.stubGlobal('fetch', vi.fn(async url => String(url).endsWith('/corrections')
      ? response({ corrections: [{ ...correction(), sessionId: 's2' }] }) : response(route(9))))
    await expect(store.refresh('s1', 'r1')).rejects.toThrow('不匹配')
    expect(store.routes[key].revision).toBe(4)
    expect(store.histories[key]).toBeUndefined()
  })

  it('does not record aborted reads and rejects unknown server status', async () => {
    const store = readyStore()
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async url => String(url).endsWith('/corrections')
      ? response({ corrections: [correction()] }) : response(route(8))))
    const read = store.refresh('s1', 'r1', controller.signal)
    controller.abort(); await read
    expect(store.routes[key].revision).toBe(4)
    vi.stubGlobal('fetch', vi.fn(async url => String(url).endsWith('/corrections')
      ? response({ corrections: [correction('mystery-success')] }) : response(route(8))))
    await expect(store.refresh('s1', 'r1')).rejects.toThrow('暂不受支持')
  })

  it('retains the request after server failure but releases it after definite 400', async () => {
    const store = readyStore()
    let code = 503
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: code })))
    store.prepare('s1', 'r1', input)
    await expect(store.submit('s1', 'r1')).rejects.toMatchObject({ status: 503 })
    expect(store.pending[key]).toBeDefined()
    code = 400
    await expect(store.submit('s1', 'r1')).rejects.toMatchObject({ status: 400 })
    expect(store.pending[key]).toBeUndefined()
  })

  it('refresh lookup binds the exact source event and cannot accept another message', async () => {
    vi.stubGlobal('fetch', vi.fn(async url => {
      expect(String(url)).toContain('sourceEventId=e%2F1')
      return response({ items: [route()] })
    }))
    await expect(readyStore().findRoutes('s1', 'e/1')).rejects.toThrow('不匹配')
  })
})

describe('correction presentation boundary', () => {
  it('offers only confirmed local or unoverridden inherited decisions', () => {
    const { workItems, decisions } = normalizeCorrectionTargets({ items: [
      { id: 'child', sessionId: 's1', title: 'Child', inheritedDecisionIds: ['parent-old', 'parent-active'] }
    ] }, { items: [
      { id: 'parent-old', workItemId: 'parent', sessionId: 's1', content: 'old', revision: 1, status: 'confirmed' },
      { id: 'parent-active', workItemId: 'parent', sessionId: 's1', content: 'active', revision: 2, status: 'confirmed' },
      { id: 'local', workItemId: 'child', sessionId: 's1', content: 'local', revision: 1, status: 'confirmed', overridesDecisionId: 'parent-old' },
      { id: 'sibling', workItemId: 'sibling', sessionId: 's1', content: 'sibling', revision: 1, status: 'confirmed' },
      { id: 'superseded', workItemId: 'child', sessionId: 's1', status: 'superseded' }
    ] }, 's1')
    expect(decisionsForCorrection(workItems[0], decisions).map(row => row.id)).toEqual(['parent-active', 'local'])
  })
  it('distinguishes transport/configuration failure, clarification and irreversible effects', () => {
    expect(correctionStatusCopy('rejected', 'auth')).toContain('模型连接或配置异常')
    expect(correctionStatusCopy('clarification_required')).toContain('进一步说明')
    expect(correctionStatusCopy('reconciliation_required')).toContain('核对已发生')
    expect(correctionStatusCopy('accepted')).toContain('尚未生效')
    expect(correctionStatusCopy('applied')).toContain('仍需单独恢复')
  })
})
