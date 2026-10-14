import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { reactive } from 'vue'
import { unknownRuntimeHealthCapabilities, type CollaborationEvent, type RuntimeHealthSnapshot } from '@agent-cluster/shared'
import { useRuntimeRequestHealthStore } from '@/stores/runtimeRequestHealth'
import RuntimeRequestHealthPanel from './RuntimeRequestHealthPanel.vue'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), events: [] as CollaborationEvent[] }))
vi.mock('@/api/client', () => ({ apiGet: mocks.get, apiPost: mocks.post }))
vi.mock('@/stores/event', () => ({ useEventStore: () => ({ eventsForSession: (id: string) => reactive(mocks.events).filter(event => event.sessionId === id) }) }))
vi.mock('@/stores/agent', () => ({ useAgentStore: () => ({ agents: [{ id: 'agent', name: '前端开发工程师' }] }) }))
const snapshot = (patch: Partial<RuntimeHealthSnapshot> = {}): RuntimeHealthSnapshot => ({
  schemaVersion: 1, policyVersion: 'request-health-v1', sessionId: 's', operationId: 'op', invocationId: 'one',
  sessionGeneration: 1, observerEpoch: 'epoch', version: 2, phase: 'discussion', agentId: 'agent', runtimeType: 'generic_llm',
  stage: 'unknown_wait', health: 'unknown', reasonCode: 'no_observable_progress', capabilities: unknownRuntimeHealthCapabilities(),
  processStatus: 'unknown', requestStatus: 'unknown', startedAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:30Z',
  observationDue: true, canWait: true, canStop: true, ...patch
})
let wrapper: VueWrapper | undefined
beforeEach(() => {
  setActivePinia(createPinia())
  mocks.events.length = 0
  mocks.get.mockReset().mockResolvedValue({ items: [snapshot()] })
  mocks.post.mockReset().mockResolvedValue(snapshot({ version: 3, lastWaitAcknowledgedAt: 'now' }))
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; document.body.innerHTML = '' })

it('wait acknowledges the original invocation without resume/start and stop clearly affects the session', async () => {
  wrapper = mount(RuntimeRequestHealthPanel, { props: { sessionId: 's', canStop: true } })
  await flushPromises()
  expect(wrapper.text()).toContain('等待模型响应／状态未知')
  await wrapper.findAll('button').find(button => button.text() === '继续等待')!.trigger('click')
  await flushPromises()
  expect(mocks.post).toHaveBeenCalledTimes(1)
  expect(mocks.post).toHaveBeenCalledWith('/sessions/s/runtime-health/one/wait', {
    expectedVersion: 2, sessionGeneration: 1, idempotencyKey: expect.any(String)
  }, expect.any(Object))
  await wrapper.findAll('button').find(button => button.text() === '停止会话全部调用')!.trigger('click')
  expect(wrapper.emitted('stop')).toHaveLength(1)
  expect(wrapper.text()).toContain('已确认继续等待')
})

it('ignores stale, foreign-session, epoch and non-terminal replay over a terminal snapshot', async () => {
  const store = useRuntimeRequestHealthStore()
  store.merge('s', snapshot({ version: 8, stage: 'responding', health: 'progressing' }))
  store.merge('s', snapshot({ version: 999, observerEpoch: 'old' }))
  expect(store.items('s')[0].stage).toBe('responding')
  store.merge('s', snapshot({ version: 8, stage: 'terminal', health: 'terminal', canWait: false, canStop: false }))
  for (const item of [snapshot(), snapshot({ version: 9 }), snapshot({ sessionId: 'foreign' }),
    snapshot({ version: 8, observerEpoch: 'old' })]) store.merge('s', item)
  expect(store.items('s')).toHaveLength(1)
  expect(store.items('s')[0].stage).toBe('terminal')
  mocks.get.mockRejectedValue(new Error('offline'))
  await store.load('s')
  expect(store.items('s')[0].stage).toBe('terminal')
  expect(store.queryErrors.s).toContain('观测不可用')
})

it('historical state has no wait/stop authority and leaving the view only aborts observation', async () => {
  mocks.get.mockResolvedValue({ items: [
    snapshot({ historical: true, reasonCode: 'historical_observation', canWait: false, canStop: false }),
    snapshot({ invocationId: 'ended', stage: 'terminal', health: 'terminal', canWait: false, canStop: false })
  ] })
  wrapper = mount(RuntimeRequestHealthPanel, { props: { sessionId: 's', canStop: true }, attachTo: document.body })
  await flushPromises()
  expect(wrapper.findAll('button').map(button => button.text())).toEqual(['Runtime 消息'])
  expect(wrapper.find('.runtime-request-health').text()).toContain('暂无进行中的模型调用')
  expect(wrapper.findAll('.runtime-request-health-item')).toHaveLength(0)
  const dialog = await openMessages()
  expect(dialog.querySelector('.runtime-call-detail')).toBeNull()
  expect(dialog.querySelectorAll('.runtime-message-list > li')).toHaveLength(2)
  expect(useRuntimeRequestHealthStore().items('s')).toHaveLength(2)
  const signal = mocks.get.mock.calls[0][1].signal as AbortSignal
  wrapper.unmount(); wrapper = undefined
  expect(signal.aborted).toBe(true)
  expect(mocks.post).not.toHaveBeenCalled()
})

const openMessages = async () => {
  await wrapper!.findAll('button').find(button => button.text() === 'Runtime 消息')!.trigger('click')
  await flushPromises()
  return document.body.querySelector('[role="dialog"]')!
}

it('counts only current invocations, retaining unknown and stopping calls without changing history', async () => {
  mocks.get.mockResolvedValue({ items: [
    snapshot({ invocationId: 'historical', historical: true, reasonCode: 'historical_observation', canWait: false, canStop: false }),
    snapshot({ invocationId: 'ended', stage: 'terminal', health: 'terminal', canWait: false, canStop: false }),
    snapshot({ invocationId: 'pending', stage: 'awaiting_response', canWait: false }),
    snapshot({ invocationId: 'unknown' }),
    snapshot({ invocationId: 'stopping', stage: 'stopping', canWait: false, canStop: false })
  ] })
  wrapper = mount(RuntimeRequestHealthPanel, { props: { sessionId: 's', canStop: true }, attachTo: document.body })
  await flushPromises()
  const summary = wrapper.find('.runtime-request-health')
  expect(summary.text()).toContain('当前 3 个调用')
  expect(summary.findAll('.runtime-request-health-item')).toHaveLength(3)
  expect(summary.text()).toContain('等待模型响应／状态未知')
  expect(summary.text()).toContain('正在等待可信停止确认')
  expect(summary.text()).not.toContain('历史调用')
  expect(summary.text()).not.toContain('调用已结束')
  const dialog = await openMessages()
  expect(dialog.querySelectorAll('.runtime-call-detail')).toHaveLength(3)
  expect(dialog.querySelectorAll('.runtime-message-list > li')).toHaveLength(5)
  expect(useRuntimeRequestHealthStore().items('s')).toHaveLength(5)
  expect(mocks.post).not.toHaveBeenCalled()
})

it('removes a completed call from current status without falling back to its historical record', async () => {
  wrapper = mount(RuntimeRequestHealthPanel, { props: { sessionId: 's', canStop: true }, attachTo: document.body })
  await flushPromises()
  expect(wrapper.find('.runtime-request-health').text()).toContain('当前 1 个调用')
  const dialog = await openMessages()
  expect(dialog.querySelectorAll('.runtime-call-detail')).toHaveLength(1)
  useRuntimeRequestHealthStore().merge('s', snapshot({ version: 3, stage: 'terminal', health: 'terminal', canWait: false, canStop: false }))
  await flushPromises()
  expect(wrapper.find('.runtime-request-health').text()).toContain('暂无进行中的模型调用')
  expect(wrapper.findAll('.runtime-request-health-item')).toHaveLength(0)
  expect(dialog.querySelector('.runtime-call-detail')).toBeNull()
  expect(dialog.querySelectorAll('.runtime-message-list > li')).toHaveLength(1)
  expect(mocks.post).not.toHaveBeenCalled()
})

it('does not turn historical observations into current calls when an equal-version event is replayed', () => {
  const store = useRuntimeRequestHealthStore()
  const historical = snapshot({ historical: true, reasonCode: 'historical_observation', canWait: false, canStop: false })
  store.merge('s', snapshot())
  store.merge('s', historical)
  store.merge('s', snapshot())
  expect(store.items('s')[0]).toEqual(historical)
  store.merge('s', snapshot({ version: 3, stage: 'terminal', health: 'terminal', canWait: false, canStop: false }))
  expect(store.items('s')[0].stage).toBe('terminal')
})

it('current fault summary and messages explain rate limits and confirmed-stop fallback with no restart', async () => {
  mocks.get.mockResolvedValue({ items: [snapshot({ stage: 'retrying', health: 'abnormal', reasonCode: 'provider_retry',
    canWait: false, failure: { code: 'rate_limit', httpStatus: 429, retryAttempt: 7 } })] })
  wrapper = mount(RuntimeRequestHealthPanel, { props: { sessionId: 's', canStop: true }, attachTo: document.body })
  await flushPromises()
  expect(wrapper.text()).toContain('模型服务限流')
  expect(wrapper.text()).toContain('第 7 次重试记录')
  expect(wrapper.text()).not.toContain('继续等待')
  const dialog = await openMessages()
  expect(dialog.textContent).toContain('模型服务限流（429）')
  useRuntimeRequestHealthStore().merge('s', snapshot({ version: 3, stage: 'stopping', health: 'unknown', canWait: false,
    reasonCode: 'stop_requested', budgetFallbackReason: 'provider_or_tool_error' }))
  await flushPromises()
  expect(wrapper.text()).toContain('异常未恢复／等待停止确认')
  expect(dialog.textContent).toContain('确认结束前不会重跑任务')
  expect(mocks.post).not.toHaveBeenCalled()
})

it('uses understandable agent/phase labels and explains every health field in the dialog', async () => {
  wrapper = mount(RuntimeRequestHealthPanel, { props: { sessionId: 's' }, attachTo: document.body })
  await flushPromises()
  const summary = wrapper.find('.runtime-request-health').text()
  expect(summary).toContain('前端开发工程师 · 群聊讨论 · 通用大模型')
  expect(summary).not.toMatch(/discussion|generic_llm|unknown|unsupported|request-health-v1/)
  const dialog = await openMessages()
  expect(dialog.textContent).toContain('Runtime 是负责请求模型')
  expect(dialog.textContent).toContain('运行程序状态')
  expect(dialog.textContent).toContain('模型请求状态')
  expect(dialog.textContent).toContain('思考活动反馈')
  expect(dialog.textContent).toContain('运行程序检测')
  expect(dialog.textContent).toContain('模型服务状态查询')
  expect(dialog.textContent).toContain('当前不支持')
  expect(dialog.textContent).toContain('不代表调用失败')
  expect(dialog.textContent).toContain('未收到提示不代表模型未工作')
  expect(dialog.textContent).toContain('不是预算或超时限制')
  expect(dialog.querySelector('time')!.textContent).toMatch(/^\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}:\d{2}$/)
  expect(dialog.querySelector('button[aria-label="关闭此对话框"]')).not.toBeNull()
  expect(mocks.post).not.toHaveBeenCalled()
})

it('makes the message button available immediately, even before the first invocation', async () => {
  mocks.get.mockResolvedValue({ items: [] })
  wrapper = mount(RuntimeRequestHealthPanel, { props: { sessionId: 's' }, attachTo: document.body })
  await flushPromises()
  expect(wrapper.text()).toContain('暂无进行中的模型调用')
  expect((await openMessages()).textContent).toContain('暂无 Runtime 消息')
})

it('lists each runtime and tool message, paginates history, and never sends a model request', async () => {
  mocks.get.mockResolvedValue({ items: [] })
  mocks.events.push(...Array.from({ length: 25 }, (_, i): CollaborationEvent => ({
    id: `event-${i}`, sessionId: 's', type: i % 2 ? 'tool_called' : 'runtime_progress',
    actor: { type: 'agent', id: 'agent' }, toAgentIds: [], content: `消息内容 ${i}`,
    metadata: { schemaVersion: '0.1', payload: { phase: 'discussion' } }, createdAt: new Date(1700000000000 + i * 1000).toISOString()
  })))
  wrapper = mount(RuntimeRequestHealthPanel, { props: { sessionId: 's' }, attachTo: document.body })
  await flushPromises()
  const dialog = await openMessages()
  expect(dialog.querySelectorAll('.runtime-message-list > li')).toHaveLength(20)
  expect(dialog.textContent).toContain('共 25 条')
  expect(dialog.querySelector('.runtime-message-content')!.textContent).toBe('消息内容 24')
  ;(dialog.querySelector('.btn-next') as HTMLButtonElement).click()
  await flushPromises()
  expect(dialog.querySelectorAll('.runtime-message-list > li')).toHaveLength(5)
  expect(dialog.querySelector('.runtime-message-content')!.textContent).toBe('消息内容 4')
  expect(dialog.querySelector('button[aria-label="下一页"]')).not.toBeNull()
  expect(mocks.post).not.toHaveBeenCalled()
})

it('closes the dialog on session switch and does not show another session history', async () => {
  wrapper = mount(RuntimeRequestHealthPanel, { props: { sessionId: 's' }, attachTo: document.body })
  await flushPromises()
  await openMessages()
  mocks.get.mockResolvedValue({ items: [] })
  await wrapper.setProps({ sessionId: 'other' })
  await flushPromises()
  expect(wrapper.find('.runtime-request-health').text()).not.toContain('前端开发工程师')
  expect((await openMessages()).textContent).toContain('暂无 Runtime 消息')
})
