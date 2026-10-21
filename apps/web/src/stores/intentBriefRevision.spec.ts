import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useIntentBriefRevisionStore } from './intentBriefRevision'

const input = { dataEpoch: 'epoch', confirmationId: 'card', expectedBriefVersion: 2, expectedIntentRevision: 3,
  userMessage: '补充部署要求', questionAnswers: [{ question: '区域？', answer: '华东' }] }
const response = (request: unknown, extra = {}) => new Response(JSON.stringify({ data: { accepted: true, sessionId: 's', briefId: 'b', dataEpoch: 'epoch',
  routingId: 'route', status: 'REVISING_BRIEF', request, idempotentReplay: false, ...extra } }), { status: 200 })
beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear() })
afterEach(() => vi.unstubAllGlobals())

it('freezes assigned reviewers across an uncertain response and rejects substituted receipt targets', async () => {
  const assigned = { ...input, assignedAgentKeys: ['architect', 'reviewer'] }
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => response({ ...JSON.parse(init.body), assignedAgentKeys: ['reviewer'] })))
  await expect(useIntentBriefRevisionStore().submit('s', 'b', assigned)).rejects.toThrow('不匹配')
  setActivePinia(createPinia())
  await expect(useIntentBriefRevisionStore().submit('s', 'b', { ...assigned, assignedAgentKeys: ['reviewer'] })).rejects.toThrow('保持原修改')
  expect(sessionStorage.length).toBe(1)
})

it('preserves the request and question answers across a lost response and renderer restart', async () => {
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); bodies.push(request)
    if (bodies.length === 1) throw new TypeError('Failed to fetch')
    return response(request, { idempotentReplay: true })
  }))
  await expect(useIntentBriefRevisionStore().submit('s', 'b', input)).rejects.toThrow()
  setActivePinia(createPinia())
  await expect(useIntentBriefRevisionStore().submit('s', 'b', { ...input, userMessage: '另一需求' })).rejects.toThrow('保持原修改')
  await useIntentBriefRevisionStore().submit('s', 'b', input)
  expect(bodies).toHaveLength(2); expect(bodies[0]).toEqual(bodies[1]); expect(sessionStorage.length).toBe(0)
})

it('409 does not rebind or automatically retry the old card', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: 'STALE' }), { status: 409 })); vi.stubGlobal('fetch', fetcher)
  await expect(useIntentBriefRevisionStore().submit('s', 'b', input)).rejects.toMatchObject({ status: 409 })
  expect(fetcher).toHaveBeenCalledTimes(1); expect(sessionStorage.length).toBe(0)
})

it('foreign receipts remain uncertain and cannot clear the frozen request', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => response(JSON.parse(init.body), { briefId: 'other' })))
  await expect(useIntentBriefRevisionStore().submit('s', 'b', input)).rejects.toThrow('不匹配')
  expect(sessionStorage.length).toBe(1)
})

it('rejects duplicate concurrent submission and sends one request only', async () => {
  let release!: () => void
  const fetcher = vi.fn(async (_url, init) => { await new Promise<void>(done => { release = done }); return response(JSON.parse(init.body)) })
  vi.stubGlobal('fetch', fetcher)
  const store = useIntentBriefRevisionStore(), first = store.submit('s', 'b', input)
  await expect(store.submit('s', 'b', input)).rejects.toThrow('正在提交')
  release(); await first; expect(fetcher).toHaveBeenCalledTimes(1)
})
