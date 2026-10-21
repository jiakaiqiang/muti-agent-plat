import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useIntentBriefConfirmationStore } from './intentBriefConfirmation'

const binding = { dataEpoch: 'epoch', confirmationId: 'card', expectedBriefVersion: 1, expectedIntentRevision: 2 }
const response = (request: unknown, extra = {}) => new Response(JSON.stringify({ data: { accepted: true, sessionId: 's', briefId: 'b',
  dataEpoch: 'epoch', status: 'WAIT_WORKFLOW_SELECT', idempotentReplay: false,
  receipt: { id: 'receipt', request, resultStatus: 'WAIT_WORKFLOW_SELECT' }, ...extra } }), { status: 200 })
beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear() })
afterEach(() => vi.unstubAllGlobals())

it('reuses exactly the same request after a renderer reload and uncertain transport', async () => {
  const calls: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request)
    if (calls.length === 1) throw new TypeError('Failed to fetch')
    return response(request)
  }))
  await expect(useIntentBriefConfirmationStore().confirm('s', 'b', binding)).rejects.toThrow()
  setActivePinia(createPinia())
  await expect(useIntentBriefConfirmationStore().confirm('s', 'b', { ...binding, expectedBriefVersion: 3 })).rejects.toThrow('原草稿')
  await useIntentBriefConfirmationStore().confirm('s', 'b', binding)
  expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]); expect(sessionStorage.length).toBe(0)
})

it('accepts an equivalent confirmation receipt from another client without granting execution', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => response({ ...JSON.parse(init.body), idempotencyKey: 'other-client' }, { idempotentReplay: true })))
  const result = await useIntentBriefConfirmationStore().confirm('s', 'b', binding)
  expect(result.status).toBe('WAIT_WORKFLOW_SELECT'); expect(result.receipt.request.idempotencyKey).toBe('other-client')
})

it('409 clears the failed request without automatically retrying', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: 'STALE' }), { status: 409 })); vi.stubGlobal('fetch', fetcher)
  await expect(useIntentBriefConfirmationStore().confirm('s', 'b', binding)).rejects.toMatchObject({ status: 409 })
  expect(fetcher).toHaveBeenCalledTimes(1); expect(sessionStorage.length).toBe(0)
})

it('rejects mismatched receipts and keeps the original request for reconciliation', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => response(JSON.parse(init.body), { briefId: 'foreign' })))
  await expect(useIntentBriefConfirmationStore().confirm('s', 'b', binding)).rejects.toThrow('不匹配')
  expect(sessionStorage.length).toBe(1)
})

it('blocks simultaneous submissions while the first response is outstanding', async () => {
  let release!: () => void
  const fetcher = vi.fn(async (_url, init) => { await new Promise<void>(resolve => { release = resolve }); return response(JSON.parse(init.body)) })
  vi.stubGlobal('fetch', fetcher)
  const store = useIntentBriefConfirmationStore(), first = store.confirm('s', 'b', binding)
  await expect(store.confirm('s', 'b', binding)).rejects.toThrow('正在提交')
  release(); await first; expect(fetcher).toHaveBeenCalledTimes(1)
})
