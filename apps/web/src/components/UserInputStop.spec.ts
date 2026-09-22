import { afterEach, beforeEach, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import UserInputBox from './UserInputBox.vue'
import { useWorkspaceUiStore } from '@/stores/workspaceUi'

let wrapper: ReturnType<typeof mount>
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => wrapper?.unmount())
it('can stop while the composer is empty or sending and preserves the draft', async () => {
  wrapper = mount(UserInputBox, { props: { canStop: true, busy: true } })
  const store = useWorkspaceUiStore()
  store.messageDraft = '未发送的补充信息'
  await wrapper.get('[aria-label="停止当前会话"]').trigger('click')
  expect(wrapper.emitted('stop')).toHaveLength(1)
  expect(wrapper.findAll('.user-input-box__actions button')).toHaveLength(1)
  expect(wrapper.find('[aria-label="发送"]').exists()).toBe(false)
  expect(store.messageDraft).toBe('未发送的补充信息')
  await wrapper.setProps({ controlBusy: true })
  expect(wrapper.get('[aria-label="停止当前会话"]').attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('正在停止')
})
it('switches the same button from send to stop immediately while sending, without sending a draft again', async () => {
  wrapper = mount(UserInputBox)
  const store = useWorkspaceUiStore()
  store.messageDraft = '开始任务'
  await wrapper.vm.$nextTick()
  const button = wrapper.get('[aria-label="发送"]').element
  await wrapper.get('[aria-label="发送"]').trigger('click')
  expect(wrapper.emitted('send')?.[0]?.[0]).toBe('开始任务')
  await wrapper.setProps({ busy: true })
  expect(wrapper.get('[aria-label="停止当前会话"]').element).toBe(button)
  await wrapper.get('[aria-label="停止当前会话"]').trigger('click')
  expect(wrapper.emitted('stop')).toHaveLength(1)
  await wrapper.setProps({ busy: false, canStop: true })
  store.messageDraft = '保留补充草稿'
  await wrapper.get('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true })
  expect(wrapper.emitted('send')).toHaveLength(1)
  expect(store.messageDraft).toBe('保留补充草稿')
  await wrapper.setProps({ canStop: false })
  expect(wrapper.get('[aria-label="发送"]').element).toBe(button)
})
it('keeps a single action after stop and sends queued drafts without implicitly resuming', async () => {
  wrapper = mount(UserInputBox, { props: { canResume: true } })
  expect(wrapper.findAll('.user-input-box__actions button')).toHaveLength(1)
  useWorkspaceUiStore().messageDraft = '下一步补充'
  await wrapper.vm.$nextTick()
  await wrapper.get('[aria-label="发送"]').trigger('click')
  expect(wrapper.emitted('send')?.[0]?.[0]).toBe('下一步补充')
  expect(wrapper.emitted('resume')).toBeUndefined()
})
it('offers resume after confirmed stop and shows an unconfirmed stop error', async () => {
  wrapper = mount(UserInputBox, { props: { canResume: true } })
  await wrapper.get('[aria-label="继续当前会话"]').trigger('click')
  expect(wrapper.emitted('resume')).toHaveLength(1)
  await wrapper.setProps({ canStop: true, controlError: '停止状态待确认，请重试' })
  expect(wrapper.find('[aria-label="继续当前会话"]').exists()).toBe(false)
  expect(wrapper.get('[role="alert"]').text()).toContain('停止状态待确认')
})
