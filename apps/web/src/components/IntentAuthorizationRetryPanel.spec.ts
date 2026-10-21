import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import IntentAuthorizationRetryPanel from './IntentAuthorizationRetryPanel.vue'
import WebTimeline from './ChatTimeline.vue'
import DesktopTimeline from '../../../desktop/renderer/components/ChatTimeline.vue'
import { authorizationRetryKey, useIntentAuthorizationRetryStore } from '@/stores/intentAuthorizationRetry'

const descriptor = { routingId: 'route', sourceEventId: 'message', dataEpoch: 'epoch', expectedRoutingRevision: 4 }
const reference = { sessionId: 'session', ...descriptor }
const props = { sessionId: 'session', descriptor }
const current = (applied = false, revision = 4) => ({ id: 'route', sessionId: 'session', sourceEventId: 'message', routingRevision: revision,
  status: applied ? 'ROUTED' : 'CLARIFICATION_REQUIRED', rolloutMode: 'enforce_all_current_epoch', effectiveIntentRevision: applied ? 2 : undefined,
  semanticProposal: { dataEpoch: 'epoch', understanding: { segments: [] } }, semanticPlan: { outcome: applied ? 'applicable' : 'needs_clarification',
    validation: { errorCodes: applied ? [] : ['EFFECT_NOT_AUTHORIZED'] } } })
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
const success = (request: any) => ({ routing: { ...current(true, 5), authorizationRetryReceipts: [{ request, actorId: 'user',
  intentRevision: 2, resultRoutingRevision: 5, createdAt: '2026-10-20T00:00:00Z' }] } })
let wrapper: VueWrapper | undefined
const button = (label: string) => wrapper!.findAll('button').find(row => row.text() === label)!
beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear() })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })

it('fetches state but only explicit click submits a version-bound original request; no model data is sent', async () => {
  const posts: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return response(success(posts[0])) }
    return response(current())
  }))
  wrapper = mount(IntentAuthorizationRetryPanel, { props }); await flushPromises()
  expect(posts).toHaveLength(0); expect(wrapper.attributes('aria-label')).toBe('重新校验原请求')
  await button('授权后重新校验原请求').trigger('click'); await flushPromises()
  expect(posts).toHaveLength(1); expect(Object.keys(posts[0]).sort()).toEqual(['contractVersion', 'dataEpoch', 'expectedRoutingRevision', 'idempotencyKey'].sort())
  expect(posts[0]).toMatchObject({ contractVersion: 'intent-authorization-retry-v1', dataEpoch: 'epoch', expectedRoutingRevision: 4 })
  expect(wrapper.text()).toContain('已重新校验原请求'); expect(button('授权后重新校验原请求')).toBeUndefined()
})

it('unknown submission survives store reload and resends the identical request, even if GET already sees the applied plan', async () => {
  const posts: string[] = []; let failed = true
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts.push(init.body); if (failed) throw new TypeError('network'); return response(success(JSON.parse(init.body))) }
    return response(current(!failed, failed ? 4 : 5))
  }))
  wrapper = mount(IntentAuthorizationRetryPanel, { props }); await flushPromises()
  await button('授权后重新校验原请求').trigger('click'); await flushPromises()
  expect(wrapper.find('[role="alert"]').text()).toContain('提交结果尚未确认')
  wrapper.unmount(); setActivePinia(createPinia()); failed = false
  wrapper = mount(IntentAuthorizationRetryPanel, { props }); await flushPromises(); expect(posts).toHaveLength(1)
  await button('核对原提交结果').trigger('click'); await flushPromises()
  expect(posts[1]).toBe(posts[0]); expect(sessionStorage.length).toBe(0)
})

it('409 refreshes state without silently resubmitting, disabled panels cannot submit', async () => {
  let posts = 0, reads = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts++; return response({}, 409) }
    reads++; return response(current(false, reads > 1 ? 6 : 4))
  }))
  wrapper = mount(IntentAuthorizationRetryPanel, { props }); await flushPromises()
  await button('授权后重新校验原请求').trigger('click'); await flushPromises()
  expect(posts).toBe(1); expect(reads).toBe(2); expect(wrapper.text()).toContain('请核对授权和最新状态')
  await wrapper.setProps({ disabled: true }); expect(button('授权后重新校验原请求').attributes('disabled')).toBeDefined()
  expect(useIntentAuthorizationRetryStore().pending[authorizationRetryKey(reference)]).toBeUndefined()
})

it('source mismatches or poisoned persisted requests cannot enable submission; another epoch has separate state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ ...current(), sourceEventId: 'other' })))
  const key = authorizationRetryKey(reference)
  sessionStorage.setItem(`intent-authorization-retry:v1:${key}`, JSON.stringify({ contractVersion: 'intent-authorization-retry-v1', dataEpoch: 'epoch',
    expectedRoutingRevision: 4, idempotencyKey: 'key', plan: {} }))
  wrapper = mount(IntentAuthorizationRetryPanel, { props }); await flushPromises()
  expect(button('授权后重新校验原请求')).toBeUndefined(); expect(button('核对原提交结果')).toBeUndefined()
  expect(wrapper.text()).toContain('无法核对原请求'); expect(sessionStorage.length).toBe(0)
})

it('deduplicates simultaneous submissions and ignores late reads older than a successful POST', async () => {
  let releaseRead!: (value: Response) => void, releasePost!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'POST' ? new Promise<Response>(done => { releasePost = done }) : new Promise<Response>(done => { releaseRead = done })))
  const store = useIntentAuthorizationRetryStore(), key = authorizationRetryKey(reference)
  store.record(reference, current()); store.prepare(reference)
  const read = store.refresh(reference), post = store.submit(reference)
  await expect(store.submit(reference)).rejects.toThrow('正在处理')
  releasePost(response(success({ ...store.pending[key] }))); await post
  releaseRead(response(current())); await read
  expect(store.routes[key].routingRevision).toBe(5); expect(store.stale[key]).toBe(false)
})

it('a success response without the matching receipt leaves the original request pending', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => response(init?.method === 'POST' ? { routing: current(true, 5) } : current())))
  wrapper = mount(IntentAuthorizationRetryPanel, { props }); await flushPromises()
  await button('授权后重新校验原请求').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('提交结果尚未确认'); expect(button('核对原提交结果')).toBeDefined()
  expect(useIntentAuthorizationRetryStore().pending[authorizationRetryKey(reference)]).toBeDefined()
})

it.each([['Web', WebTimeline], ['Desktop', DesktopTimeline]] as const)('%s timeline displays the original-request retry action', async (_name, component) => {
  vi.stubGlobal('fetch', vi.fn(async () => response(current())))
  wrapper = mount(component, { props: { sessionId: 'session', messages: [{ id: 'notice', sessionId: 'session', rawEventId: 'notice',
    senderType: 'system', toAgentIds: [], messageType: 'system_notice', content: '等待授权', createdAt: '2026-10-20T00:00:00Z', payload: { authorizationRetry: descriptor } }] },
    global: { stubs: { AgentPortrait: true, ChatScrollArea: { props: ['messages'], template: '<div><slot :visible-messages="messages" /></div>' } } } })
  await flushPromises(); expect(wrapper.text()).toContain('授权后重新校验原请求')
})
