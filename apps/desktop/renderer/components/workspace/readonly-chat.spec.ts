import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ChatTimeline from '../ChatTimeline.vue'
import { useWorkspaceUiStore } from '@/stores/workspaceUi'
import type { ChatMessage } from '@/types/contracts'

describe('workspace read-only interactions', () => {
  beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear(); vi.stubGlobal('requestAnimationFrame', () => 0) })
  it('does not mount a decision component in the right chat projection', async () => {
    const message = { id: 'notice', sessionId: 'a', senderType: 'system', messageType: 'confirmation', content: '等待验证', createdAt: new Date().toISOString(), payload: { confirmationId: 'confirm-1', reason: 'confirm_workflow_human_gate', title: '验证结果', status: 'pending', options: [{ key: 'approve', label: '批准' }] } } as ChatMessage
    const wrapper = mount(ChatTimeline, { props: { messages: [message], readOnly: true } })
    expect(wrapper.findComponent({ name: 'ConfirmationCard' }).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('批准')
    await wrapper.get('.readonly-confirmation button').trigger('click')
    expect(wrapper.emitted('goToConfirmation')).toEqual([['confirm-1']])
    expect(wrapper.emitted('resolveConfirmation')).toBeUndefined()
  })
  it('isolates drafts when switching between requirements', () => {
    const ui = useWorkspaceUiStore()
    ui.activateTask('a'); ui.messageDraft = '补充 A'
    ui.activateTask('b'); expect(ui.messageDraft).toBe('')
    ui.messageDraft = '补充 B'; ui.activateTask('a')
    expect(ui.messageDraft).toBe('补充 A')
    ui.activateTask('b'); expect(ui.messageDraft).toBe('补充 B')
  })
  it('restores a draft after reloading without assigning it to another task', () => {
    const ui = useWorkspaceUiStore(); ui.activateTask('a'); ui.messageDraft = '尚未提交'
    setActivePinia(createPinia())
    const restored = useWorkspaceUiStore(); restored.activateTask('b'); expect(restored.messageDraft).toBe('')
    restored.activateTask('a'); expect(restored.messageDraft).toBe('尚未提交')
  })
})
