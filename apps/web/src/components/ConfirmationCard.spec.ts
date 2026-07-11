import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfirmationCard from './ConfirmationCard.vue'
import type { ConfirmationCardState } from '@/types/contracts'

function postReviewConfirmation(): ConfirmationCardState {
  return {
    confirmationId: 'confirmation-post-review',
    reason: 'coordinator_routing_needs_user_decision' as ConfirmationCardState['reason'],
    title: '复盘需要用户选择',
    description: '当前证据不足，请选择下一步。',
    status: 'pending',
    options: [
      { key: 'resume', label: '继续执行', style: 'primary' },
      { key: 'cancel', label: '取消', style: 'default' }
    ],
    actions: [
      {
        action: 'request_workspace_context',
        reason: '复盘需要读取实现文件。',
        missingPaths: ['src/feature.ts']
      },
      {
        action: 'deliver_with_limitations',
        limitations: ['src/feature.ts 尚未复核。']
      },
      { action: 'save_progress' },
      { action: 'cancel', reason: '停止当前任务。' }
    ]
  }
}

describe('ConfirmationCard Post Review actions', () => {
  it('渲染补读、受限交付、保存和取消，并发出结构化 action key', async () => {
    const wrapper = mount(ConfirmationCard, {
      props: { confirmation: postReviewConfirmation() }
    })

    expect(wrapper.text()).toContain('补读工作区')
    expect(wrapper.text()).toContain('src/feature.ts')
    expect(wrapper.text()).toContain('受限交付')
    expect(wrapper.text()).toContain('src/feature.ts 尚未复核。')
    expect(wrapper.text()).toContain('保存当前进度')
    expect(wrapper.text()).toContain('取消任务')
    expect(wrapper.text()).not.toContain('继续执行')

    const contextAction = wrapper.get('[data-action="request_workspace_context"]')
    await contextAction.trigger('click')

    expect(wrapper.emitted('resolve')).toEqual([['request_workspace_context']])
  })
})
