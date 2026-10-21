import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ElSelect } from 'element-plus'
import type { ChatMessage } from '@/types/contracts'
import WebChatTimeline from './ChatTimeline.vue'
import DesktopChatTimeline from '../../../desktop/renderer/components/ChatTimeline.vue'
import IntentCorrectionPanel from './IntentCorrectionPanel.vue'
import { correctionKey, useIntentCorrectionStore } from '@/stores/intentCorrection'

const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
const message: ChatMessage = { id: 'message-1', sessionId: 's1', rawEventId: 'source-1', senderType: 'user',
  content: '超时为 10 分钟', toAgentIds: [], messageType: 'text', createdAt: '2026-10-19T10:00:00Z' }
const wrappers: VueWrapper[] = []
let state: 'none' | 'accepted' | 'reconciliation_required' | 'applied' | 'rejected' = 'none'
let failPost = false
let routeStatus = 'ROUTED'
let correctionAlias = false
const posts: Array<{ url: string; body: Record<string, unknown> }> = []
function fakeFetch() {
  return vi.fn(async (input, init) => {
    const url = String(input)
    const route = { id: 'r1', sessionId: 's1', sourceEventId: 'source-1', routingRevision: 4,
      status: routeStatus, decision: { selectedWorkItemId: 'w1' } }
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body) })
      if (failPost) throw new TypeError('Failed to fetch')
      state = 'accepted'
      return response({ correctionId: 'c1', routingId: 'r1', pendingIntentRevision: 2, routingRevision: 5, correctionStatus: state })
    }
    if (url.includes('message-routings?')) return response({ items: [correctionAlias
      ? { ...route, id: 'chat-correction-route', correctionTargetRoutingId: 'r1' } : route] })
    if (url.endsWith('/corrections')) return response({ corrections: state === 'none' ? [] : [{
      id: 'c1', routingId: 'r1', sessionId: 's1', status: state, pendingIntentRevision: 2, routingRevision: state === 'applied' ? 6 : 5,
      failureClass: state === 'rejected' ? 'auth' : undefined,
      idempotencyKey: posts[0]?.body.idempotencyKey ?? 'prior-request',
      request: { instruction: '超时改为 30 分钟' }, updatedAt: '2026-10-19T10:00:01Z'
    }] })
    if (url.endsWith('/r1')) return response(route)
    if (url.endsWith('/work-items')) return response({ items: [{ id: 'w1', sessionId: 's1', title: '验证超时', inheritedDecisionIds: [] }] })
    if (url.endsWith('/decisions')) return response({ items: [{ id: 'd1', sessionId: 's1', workItemId: 'w1', status: 'confirmed',
      content: '超时为 10 分钟', revision: 3 }] })
    throw new Error(`Unexpected request: ${url}`)
  })
}
beforeEach(() => {
  setActivePinia(createPinia()); sessionStorage.clear(); state = 'none'; failPost = false; routeStatus = 'ROUTED'; correctionAlias = false; posts.length = 0
  vi.stubGlobal('fetch', fakeFetch())
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})
function button(text: string) {
  const element = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text)
  if (!element) throw new Error(`Button not found: ${text}`)
  return element as HTMLButtonElement
}
async function openPanel(component: typeof WebChatTimeline | typeof DesktopChatTimeline) {
  const wrapper = mount(component, { attachTo: document.body, props: { messages: [message] }, global: { stubs: {
    ChatScrollArea: { props: ['messages'], template: '<div><slot :visible-messages="messages" /></div>' }, AgentPortrait: true
  } } })
  wrappers.push(wrapper)
  button('纠正理解').click(); await flushPromises()
  return wrapper
}
async function setInstruction(wrapper: VueWrapper) {
  const panel = wrapper.findComponent(IntentCorrectionPanel)
  panel.findAllComponents(ElSelect)[1].vm.$emit('update:modelValue', 'd1')
  const textarea = document.querySelector('textarea')!
  textarea.value = '超时改为 30 分钟'; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

describe.each([['Web', WebChatTimeline], ['Desktop renderer', DesktopChatTimeline]] as const)('%s correction entry', (_name, component) => {
  it('opens canonical correction history from a consumed chat correction input', async () => {
    correctionAlias = true; state = 'applied'
    await openPanel(component)
    expect(document.body.textContent).toContain('纠错已生效')
    expect(document.body.textContent).toContain('查看纠错记录（1）')
    expect(posts).toHaveLength(0)
  })
  it('binds original message and decision, distinguishes accepted from applied, and restores history on reopen', async () => {
    const wrapper = await openPanel(component)
    expect(document.body.textContent).toContain(message.content)
    await setInstruction(wrapper)
    button('提交纠正').click(); await flushPromises()
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toContain('/sessions/s1/message-routings/r1/corrections')
    expect(posts[0].body).toMatchObject({ instruction: '超时改为 30 分钟', targetWorkItemId: 'w1', supersedesDecisionId: 'd1', expectedDecisionRevision: 3, expectedRoutingRevision: 4 })
    expect(document.body.textContent).toContain('已受理，尚未生效')
    expect(button('提交纠正').disabled).toBe(true)
    state = 'applied'
    button('刷新结果').click(); await flushPromises()
    expect(document.body.textContent).toContain('纠错已生效')
    expect(button('提交纠正').disabled).toBe(true)
    button('关闭').click(); await flushPromises()
    button('纠正理解').click(); await flushPromises()
    expect(document.body.textContent).toContain('纠错已生效')
    expect(document.body.textContent).toContain('暂停的会话仍需单独恢复')
    expect(posts).toHaveLength(1)
  })

  it('keeps uncertain request across close/reopen and retries identical payload', async () => {
    const wrapper = await openPanel(component)
    await setInstruction(wrapper)
    failPost = true
    button('提交纠正').click(); await flushPromises()
    expect(document.body.textContent).toContain('结果尚未确认')
    button('关闭').click(); await flushPromises()
    button('纠正理解').click(); await flushPromises()
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('超时改为 30 分钟')
    failPost = false
    button('重试原请求').click(); await flushPromises()
    expect(posts).toHaveLength(2)
    expect(posts[0]).toEqual(posts[1])
  })

  it('shows unknown effects as reconciliation and blocks another request', async () => {
    state = 'reconciliation_required'
    await openPanel(component)
    expect(document.body.textContent).toContain('核对已发生的执行效果')
    expect(button('提交纠正').disabled).toBe(true)
    expect(posts).toHaveLength(0)
  })

  it('does not present authentication failure as a semantic choice', async () => {
    state = 'rejected'; routeStatus = 'BLOCKED'
    await openPanel(component)
    expect(document.body.textContent).toContain('模型连接或配置异常')
    expect(document.body.textContent).not.toContain('需要进一步说明')
  })
})

it('Desktop read-only timeline has no correction write entry', () => {
  const wrapper = mount(DesktopChatTimeline, { props: { messages: [message], readOnly: true }, global: { stubs: {
    ChatScrollArea: { props: ['messages'], template: '<div><slot :visible-messages="messages" /></div>' }, AgentPortrait: true
  } } })
  wrappers.push(wrapper)
  expect(wrapper.findComponent(IntentCorrectionPanel).exists()).toBe(false)
})

it('closing on message/session switch keeps the original pending request and never posts to the new session', async () => {
  const wrapper = await openPanel(WebChatTimeline)
  await setInstruction(wrapper)
  failPost = true
  button('提交纠正').click(); await flushPromises()
  await wrapper.setProps({ messages: [{ ...message, id: 'message-2', sessionId: 's2', rawEventId: 'source-2' }] })
  await flushPromises()
  const store = useIntentCorrectionStore()
  expect(store.pending[correctionKey('s1', 'r1')].sessionId).toBe('s1')
  expect(posts).toHaveLength(1)
  expect(posts[0].url).not.toContain('/sessions/s2/')
})
