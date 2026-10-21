import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import IntentBriefRetryPanel from './IntentBriefRetryPanel.vue'
import { briefRecoveryKey, useIntentBriefRetryStore } from '@/stores/intentBriefRetry'
const descriptor = { routingId: 'route', stepId: 'step', dataEpoch: 'epoch' }, reference = { ...descriptor, sessionId: 'session' }
const current = (status = 'failed', routingRevision = 4) => ({ ...reference, status, routingRevision, intentRevision: 1,
  operationId: routingRevision === 4 ? 'brief:step' : 'brief:step:retry:one', canRetry: status === 'failed' })
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
const accepted = (request: any) => {
  const receipt = { id: 'receipt', request, operationId: 'brief:step:retry:one', acceptedRoutingRevision: 5 }
  return { accepted: true, ...reference, receipt, step: { id: 'step', sessionId: 'session', dataEpoch: 'epoch', routingId: 'route', intentRevision: 1,
    status: 'queued', briefOperationId: receipt.operationId, briefRetryReceipts: [receipt] } }
}
let wrapper: VueWrapper | undefined
const button = (text: string) => wrapper!.findAll('button').find(row => row.text() === text)!
beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear() })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })

it('submits only after a click and treats 202 as acceptance, not a new draft', async () => {
  const posts: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return response(accepted(posts[0]), 202) }
    return response(posts.length ? current('queued', 5) : current())
  }))
  wrapper = mount(IntentBriefRetryPanel, { props: { sessionId: 'session', descriptor } }); await flushPromises()
  expect(posts).toHaveLength(0); await button('重新生成草稿').trigger('click'); await flushPromises()
  expect(posts[0]).toMatchObject({ contractVersion: 'intent-brief-retry-v1', dataEpoch: 'epoch', expectedRoutingRevision: 4,
    expectedIntentRevision: 1, expectedOperationId: 'brief:step' })
  expect(Object.keys(posts[0])).toHaveLength(6); expect(wrapper.text()).toContain('尚未生成新草稿')
  expect(button('重新生成草稿')).toBeUndefined()
})

it('lost response and reload preserve the exact original retry request', async () => {
  const posts: string[] = []; let lost = true
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts.push(init.body); if (lost) throw new TypeError('lost'); return response(accepted(JSON.parse(init.body)), 202) }
    return response(posts.length ? current('queued', 5) : current())
  }))
  wrapper = mount(IntentBriefRetryPanel, { props: { sessionId: 'session', descriptor } }); await flushPromises()
  await button('重新生成草稿').trigger('click'); await flushPromises(); expect(wrapper.text()).toContain('受理结果尚未确认')
  wrapper.unmount(); setActivePinia(createPinia()); lost = false
  wrapper = mount(IntentBriefRetryPanel, { props: { sessionId: 'session', descriptor } }); await flushPromises()
  expect(posts).toHaveLength(1); await button('核对原草稿提交').trigger('click'); await flushPromises()
  expect(posts).toHaveLength(2); expect(posts[1]).toBe(posts[0]); expect(sessionStorage.length).toBe(0)
})

it('409 refreshes without another request and mismatched receipt retains the original pending request', async () => {
  let conflict = true; const posts: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return conflict ? response({}, 409) : response({ ...accepted(posts.at(-1)), sessionId: 'other' }, 202) }
    return response(current())
  }))
  wrapper = mount(IntentBriefRetryPanel, { props: { sessionId: 'session', descriptor } }); await flushPromises()
  await button('重新生成草稿').trigger('click'); await flushPromises()
  const store = useIntentBriefRetryStore(), key = briefRecoveryKey(reference)
  expect(posts).toHaveLength(1); expect(store.pending[key]).toBeUndefined()
  conflict = false; await button('重新生成草稿').trigger('click'); await flushPromises()
  expect(posts).toHaveLength(2); expect(store.pending[key]).toEqual(posts[1]); expect(wrapper.text()).toContain('受理结果尚未确认')
})

it('stale reads cannot regress the accepted version or transfer it to another task', async () => {
  const store = useIntentBriefRetryStore(), key = briefRecoveryKey(reference)
  store.record(reference, current('completed', 8)); store.record(reference, current('failed', 4))
  expect(store.views[key].status).toBe('completed')
  expect(() => store.record(reference, { ...current(), stepId: 'other' })).toThrow('不匹配')
})

it('names the failed reviewer and retries only its frozen step, without claiming the final draft is ready', async () => {
  const posts: any[] = []; let completed = false
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(init.body) }); return response(accepted(posts[0].body), 202) }
    return response({ ...current(completed ? 'completed' : posts.length ? 'queued' : 'failed', posts.length ? 5 : 4),
      action: 'review_brief', reviewerId: 'architect', reviewerName: '架构师' })
  }))
  wrapper = mount(IntentBriefRetryPanel, { props: { sessionId: 'session', descriptor } }); await flushPromises()
  expect(wrapper.text()).toContain('审阅 Agent：架构师'); expect(wrapper.text()).toContain('已完成的其他意见会保留')
  expect(posts).toHaveLength(0); await button('仅重试此 Agent').trigger('click'); await flushPromises()
  expect(posts).toHaveLength(1); expect(posts[0].url).toContain('/intent-plan-steps/step/retry-brief')
  expect(wrapper.text()).toContain('重新审阅已受理，尚未完成')
  completed = true; await button('刷新审阅状态').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('全部意见到齐后才会生成新草稿'); expect(wrapper.text()).not.toContain('新草稿已生成')
})

it('rejects an exchanged reviewer identity even on a newer route revision', () => {
  const store = useIntentBriefRetryStore()
  store.record(reference, { ...current(), action: 'review_brief', reviewerId: 'a', reviewerName: '甲' })
  expect(() => store.record(reference, { ...current('failed', 5), action: 'review_brief', reviewerId: 'b', reviewerName: '乙' })).toThrow('不匹配')
  expect(store.views[briefRecoveryKey(reference)].reviewerId).toBe('a')
})
