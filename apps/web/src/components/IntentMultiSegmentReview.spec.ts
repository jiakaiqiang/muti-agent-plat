import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { intentUnderstandingExample, type IntentMultiSegmentReview as Review } from '@agent-cluster/shared'
import IntentMultiSegmentReview from './IntentMultiSegmentReview.vue'
import WebTimeline from './ChatTimeline.vue'
import DesktopTimeline from '../../../desktop/renderer/components/ChatTimeline.vue'
import { useEventStore } from '@/stores/event'

function descriptor(): Review {
  const understanding = structuredClone(intentUnderstandingExample)
  understanding.segments = Array.from({ length: 8 }, (_, index) => ({ ...structuredClone(understanding.segments[0]), localKey: `part-${index}`,
    goal: index === 7 ? '<img src=x onerror=alert(1)>最后一个目标' : `目标 ${index + 1}`,
    target: { ...understanding.segments[0].target, workItemId: 'login', agentIds: ['one', 'two'], decisionIds: ['limit'] },
    prohibitions: [{ effectKind: 'modify_source', object: { kind: 'workspace', refId: 'workspace' }, scope: 'subsequent', evidenceRefs: ['request'] }],
    dependencies: index ? [{ segmentKey: `part-${index - 1}`, condition: 'execution_completed' }] : [] }))
  understanding.missingFields = ['请说明第二项的范围']; understanding.ambiguityReasons = ['当前确认尚未批准']
  return { contractVersion: 'intent-multi-segment-review-v1', mode: 'clarify_only', sessionId: 'session', dataEpoch: 'epoch', routingId: 'route',
    sourceEventId: 'message-1', routingRevision: 4, understanding,
    referenceLabels: [{ id: 'login', label: '登录修复' }, { id: 'one', label: '评审成员' }, { id: 'two', label: '测试成员' }, { id: 'limit', label: '不得记录手机号' }] }
}
const route = (review: Review, extra = {}) => ({ id: review.routingId, sessionId: review.sessionId, sourceEventId: review.sourceEventId,
  semanticIngress: { dataEpoch: review.dataEpoch }, status: 'CLARIFICATION_REQUIRED', routingRevision: review.routingRevision,
  semanticPlan: { outcome: 'needs_clarification' }, semanticProposal: { understanding: review.understanding }, ...extra })
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } })
let wrapper: VueWrapper | undefined
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals() })

it('renders eight goals, all targets, prohibitions, dependencies and evidence as escaped text, with GET only', async () => {
  const review = descriptor(), fetch = vi.fn(async () => response(route(review))); vi.stubGlobal('fetch', fetch)
  wrapper = mount(IntentMultiSegmentReview, { props: { sessionId: 'session', descriptor: review } }); await flushPromises()
  expect(wrapper.findAll('ol > li')).toHaveLength(8); expect(wrapper.findAll('blockquote')).toHaveLength(8)
  for (const text of ['整组等待澄清', '最后一个目标', '评审成员、测试成员', '不得记录手机号', '禁止修改源码', '后续处理', '第 7 项执行完成', '请说明第二项的范围']) expect(wrapper.text()).toContain(text)
  expect(wrapper.find('img').exists()).toBe(false); expect(wrapper.findAll('button')).toHaveLength(1)
  await wrapper.find('button').trigger('click'); await flushPromises()
  expect(fetch.mock.calls).toHaveLength(2)
  expect(fetch.mock.calls.every(args => !(args[1] as any)?.method || (args[1] as any).method === 'GET')).toBe(true)
})

it('new revisions from SSE invalidate the pending claim without changing the historical goals or sending a mutation', async () => {
  const review = descriptor(); let changed = false
  vi.stubGlobal('fetch', vi.fn(async () => response(route(review, changed ? { routingRevision: 5, status: 'ROUTED', effectiveIntentRevision: 2 } : {}))))
  wrapper = mount(IntentMultiSegmentReview, { props: { sessionId: 'session', descriptor: review } }); await flushPromises()
  changed = true
  useEventStore().eventsBySessionId.session = [{ id: 'new', type: 'intent_plan_committed', metadata: { payload: { routingId: 'route' } } }] as any
  await flushPromises(); expect(wrapper.text()).toContain('路由状态已变化'); expect(wrapper.text()).not.toContain('整组等待澄清')
  expect(wrapper.findAll('ol > li')).toHaveLength(8)
})

it('invalid/cross-session descriptors never query or show a truncated executable subset', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const review = descriptor(); review.understanding.segments.push(structuredClone(review.understanding.segments[0]))
  wrapper = mount(IntentMultiSegmentReview, { props: { sessionId: 'session', descriptor: review } }); await flushPromises()
  expect(wrapper.find('section').exists()).toBe(false); expect(fetch).not.toHaveBeenCalled()
  await wrapper.setProps({ sessionId: 'other', descriptor: descriptor() }); await flushPromises(); expect(fetch).not.toHaveBeenCalled()
})

it.each(['BLOCKED', 'REJECTED'])('shows %s as denied rather than pending or an approved subset', async status => {
  const review = descriptor(); vi.stubGlobal('fetch', vi.fn(async () => response(route(review, { status }))))
  wrapper = mount(IntentMultiSegmentReview, { props: { sessionId: 'session', descriptor: review } }); await flushPromises()
  expect(wrapper.text()).toContain('这组请求未获执行许可'); expect(wrapper.text()).not.toContain('整组等待澄清')
  expect(wrapper.findAll('ol > li')).toHaveLength(8)
})

it.each(['epoch', 'source', 'revision', 'network'])('marks %s read failures unknown without asserting a current pending outcome', async mode => {
  const review = descriptor()
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (mode === 'network') throw new TypeError('offline')
    return response(route(review, mode === 'epoch' ? { semanticIngress: { dataEpoch: 'old' } } : mode === 'source' ? { sourceEventId: 'other' } : { routingRevision: 3 }))
  }))
  wrapper = mount(IntentMultiSegmentReview, { props: { sessionId: 'session', descriptor: review } }); await flushPromises()
  expect(wrapper.text()).toContain('当前状态尚未确认'); expect(wrapper.findAll('ol > li')).toHaveLength(8)
})

it.each([['Web', WebTimeline], ['Desktop', DesktopTimeline]] as const)('%s timeline preserves the full review while disconnected and provides no execution action', async (_name, component) => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  wrapper = mount(component, { props: { sessionId: 'session', disconnected: true, readOnly: true, messages: [{ id: 'notice', sessionId: 'session', rawEventId: 'notice',
    senderType: 'system', toAgentIds: [], messageType: 'text', content: '待澄清', createdAt: '2026-10-20T00:00:00Z', payload: { multiSegmentReview: descriptor() } }] },
    global: { stubs: { AgentPortrait: true, ChatScrollArea: { props: ['messages'], template: '<div><slot :visible-messages="messages" /></div>' } } } })
  await flushPromises(); expect(wrapper.findAll('ol > li')).toHaveLength(8); expect(fetch).not.toHaveBeenCalled()
  const button = wrapper.findAll('button').find(row => row.text() === '核对当前状态')!
  expect(button.attributes('disabled')).toBeDefined()
})
