import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import IntentRecognitionRetryPanel from './IntentRecognitionRetryPanel.vue'
import WebTimeline from './ChatTimeline.vue'
import DesktopTimeline from '../../../desktop/renderer/components/ChatTimeline.vue'
import { recognitionRetryKey, useIntentRecognitionRetryStore } from '@/stores/intentRecognitionRetry'
import { useEventStore } from '@/stores/event'

const descriptor = { routingId: 'route', sourceEventId: 'message', dataEpoch: 'epoch' }
const reference = { sessionId: 'session', ...descriptor }, props = { sessionId: 'session', descriptor }
const current = (status = 'BLOCKED', revision = 4) => ({ id: 'route', sessionId: 'session', sourceEventId: 'message', routingRevision: revision,
  status, rolloutMode: 'enforce_all_current_epoch', semanticContractVersion: 'intent-understanding-v1', failureClass: 'auth',
  semanticIngress: { dataEpoch: 'epoch', sessionGeneration: 1, entryPoint: 'first_message' } })
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
function accepted(request: any, status = 'RECEIVED') {
  const receipt = { id: 'receipt', request, actorId: 'user', operationId: 'new-operation', previousOperationId: 'route', acceptedRoutingRevision: 5, createdAt: 'now' }
  return { receipt, routing: { ...current(status, 5), recognitionOperationId: 'new-operation', recognitionRetryReceipts: [receipt] } }
}
let wrapper: VueWrapper | undefined
const button = (text: string) => wrapper!.findAll('button').find(row => row.text() === text)!
beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear() })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })

it('input overflow offers one-call continue and message-only end, with estimate visible and explicit budget decision', async () => {
  const posts: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return response(accepted(posts[0], 'REJECTED'), 202) }
    return response({ ...current(), failureClass: 'budget', blockedReason: 'INTENT_INPUT_BUDGET_EXCEEDED',
      inputBudgetDecision: { id: 'budget-hold', status: 'pending', estimatedInputTokens: 8404, outputReservationTokens: 1500, effectiveMaxInputTokens: 5400 } })
  }))
  wrapper = mount(IntentRecognitionRetryPanel, { props }); await flushPromises()
  expect(wrapper.text()).toContain('8404')
  expect(button('继续（仅本次放行）')).toBeDefined()
  await button('结束此消息').trigger('click'); await flushPromises()
  expect(posts[0].inputBudget).toEqual({ decisionId: 'budget-hold', decision: 'end' })
  expect(wrapper.text()).toContain('原消息未通过校验')
});

it('requires explicit click, submits only identity/CAS fields and displays 202 as accepted, not successful recognition', async () => {
  const posts: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return response(accepted(posts[0]), 202) }
    return response(current())
  }))
  wrapper = mount(IntentRecognitionRetryPanel, { props }); await flushPromises(); expect(posts).toHaveLength(0)
  expect(wrapper.text()).toContain('重新识别会调用模型'); await button('重新识别原消息').trigger('click'); await flushPromises()
  expect(posts[0]).toMatchObject({ contractVersion: 'intent-recognition-retry-v1', dataEpoch: 'epoch', expectedRoutingRevision: 4 })
  expect(Object.keys(posts[0]).sort()).toEqual(['contractVersion', 'dataEpoch', 'expectedRoutingRevision', 'idempotencyKey'].sort())
  expect(wrapper.text()).toContain('尚未完成识别与校验'); expect(button('重新识别原消息')).toBeUndefined()
})

it('lost response and tab reload keep the same request; a successful replay does not submit another recognition', async () => {
  const posts: string[] = []; let fail = true
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts.push(init.body); if (fail) throw new TypeError('network'); return response(accepted(JSON.parse(init.body), 'ROUTED'), 202) }
    return response(current(fail ? 'BLOCKED' : 'ROUTED', fail ? 4 : 5))
  }))
  wrapper = mount(IntentRecognitionRetryPanel, { props }); await flushPromises()
  await button('重新识别原消息').trigger('click'); await flushPromises(); expect(wrapper.text()).toContain('受理结果尚未确认')
  wrapper.unmount(); setActivePinia(createPinia()); fail = false
  wrapper = mount(IntentRecognitionRetryPanel, { props }); await flushPromises(); expect(posts).toHaveLength(1)
  await button('核对原识别提交').trigger('click'); await flushPromises()
  expect(posts[0]).toBe(posts[1]); expect(sessionStorage.length).toBe(0); expect(wrapper.text()).toContain('已完成识别与路由')
})

it('conflict refreshes facts without automatic POST, and SSE changes refresh only the original route', async () => {
  let posts = 0, state = current()
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { posts++; return response({}, 409) }
    return response(state)
  }))
  wrapper = mount(IntentRecognitionRetryPanel, { props }); await flushPromises()
  await button('重新识别原消息').trigger('click'); await flushPromises(); expect(posts).toBe(1)
  expect(wrapper.text()).toContain('停止尚未确认'); state = current('ROUTED', 9)
  useEventStore().eventsBySessionId.session = [{ id: 'new', type: 'intent_plan_committed', metadata: { payload: { routingId: 'route' } } }] as any
  await flushPromises(); expect(wrapper.text()).toContain('已完成识别与路由'); expect(posts).toBe(1)
})

it('missing or inconsistent receipts do not clear unknown submissions', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => response(init?.method === 'POST' ? { routing: current('RECEIVED', 5) } : current(), init?.method === 'POST' ? 202 : 200)))
  wrapper = mount(IntentRecognitionRetryPanel, { props }); await flushPromises()
  await button('重新识别原消息').trigger('click'); await flushPromises()
  expect(button('核对原识别提交')).toBeDefined(); expect(useIntentRecognitionRetryStore().pending[recognitionRetryKey(reference)]).toBeDefined()
})

it('a source/epoch mismatch or poisoned saved request cannot enable a retry', async () => {
  const key = recognitionRetryKey(reference)
  sessionStorage.setItem(`intent-recognition-retry:v1:${key}`, JSON.stringify({ contractVersion: 'intent-recognition-retry-v1', dataEpoch: 'epoch', expectedRoutingRevision: 4, idempotencyKey: 'key', attempts: 100 }))
  vi.stubGlobal('fetch', vi.fn(async () => response({ ...current(), sourceEventId: 'another' })))
  wrapper = mount(IntentRecognitionRetryPanel, { props }); await flushPromises()
  expect(wrapper.text()).toContain('无法确认识别状态'); expect(button('重新识别原消息')).toBeUndefined(); expect(sessionStorage.length).toBe(0)
})

it.each([['Web', WebTimeline], ['Desktop', DesktopTimeline]] as const)('%s timeline shows the retry panel and disables writes when disconnected', async (_name, component) => {
  vi.stubGlobal('fetch', vi.fn(async () => response(current())))
  wrapper = mount(component, { props: { sessionId: 'session', disconnected: true, messages: [{ id: 'notice', sessionId: 'session', rawEventId: 'notice',
    senderType: 'system', toAgentIds: [], messageType: 'text', content: '识别受阻', createdAt: '2026-10-20T00:00:00Z', payload: { recognitionRetry: descriptor } }] },
    global: { stubs: { AgentPortrait: true, ChatScrollArea: { props: ['messages'], template: '<div><slot :visible-messages="messages" /></div>' } } } })
  await flushPromises(); expect(button('重新识别原消息').attributes('disabled')).toBeDefined()
})
