import { afterEach, beforeEach, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import UserInputBox from './UserInputBox.vue'
import { useSessionStore } from '@/stores/session'
import { useEventStore } from '@/stores/event'
import type { SessionDetail } from '@/types/contracts'

let wrapper: ReturnType<typeof mount>
beforeEach(() => {
  setActivePinia(createPinia())
  useSessionStore().currentSession = { id: 'current', status: 'AGENT_DISCUSSING' } as SessionDetail
  const events = useEventStore()
  events.connectedSessionId = 'current'
  events.sseConnectionState = 'connected'
})
afterEach(() => wrapper?.unmount())

it('does not report a connection failure merely because input is disabled', () => {
  wrapper = mount(UserInputBox, { props: { disabled: true } })
  expect(wrapper.get('textarea').attributes('disabled')).toBeDefined()
  expect(wrapper.get('.task-activity').text()).toContain('正在等待新的执行进度')
  expect(wrapper.text()).not.toContain('连接异常')
})

it('leaves loading and load errors to the workspace, then restores activity after readiness', async () => {
  wrapper = mount(UserInputBox, { props: { disabled: true, sessionReady: false } })
  expect(wrapper.find('.task-activity').exists()).toBe(false)
  expect(wrapper.get('textarea').attributes('disabled')).toBeDefined()
  await wrapper.setProps({ connectionUnavailable: true })
  expect(wrapper.find('.task-activity').exists()).toBe(false)
  await wrapper.setProps({ sessionReady: true, connectionUnavailable: false, disabled: false })
  expect(wrapper.get('.task-activity').text()).toContain('正在等待新的执行进度')
  expect(wrapper.get('textarea').attributes('disabled')).toBeUndefined()
})

it('reports an actual connection failure and clears it when connectivity recovers', async () => {
  wrapper = mount(UserInputBox, { props: { disabled: true, connectionUnavailable: true } })
  expect(wrapper.get('.task-activity.is-warning').text()).toContain('连接异常')
  await wrapper.setProps({ connectionUnavailable: false })
  expect(wrapper.text()).not.toContain('连接异常')
  expect(wrapper.get('textarea').attributes('disabled')).toBeDefined()
})
