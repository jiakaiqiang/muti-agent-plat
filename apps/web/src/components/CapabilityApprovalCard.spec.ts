import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CapabilityApprovalCard from './CapabilityApprovalCard.vue'

const pendingApprovals = [
  { toolId: 'cap-command-run', toolKey: 'tool.command_run', approvalId: 'approval-command', reasons: ['HUMAN_APPROVAL_REQUIRED'] },
  { toolId: 'cap-file-write', toolKey: 'tool.file_write', approvalId: 'approval-file', reasons: ['HUMAN_APPROVAL_REQUIRED'] }
]

describe('CapabilityApprovalCard', () => {
  it('disables duplicate clicks while a batch approval is running', async () => {
    const wrapper = mount(CapabilityApprovalCard, {
      props: { sessionId: 'session-1', pendingApprovals, busy: true }
    })

    const button = wrapper.get('button')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.text()).toBe('授权中...')
    await button.trigger('click')
    expect(wrapper.emitted('approve')).toBeUndefined()
  })

  it('shows partial progress and becomes final after all approvals are committed', async () => {
    const wrapper = mount(CapabilityApprovalCard, {
      props: {
        sessionId: 'session-1',
        pendingApprovals,
        approvedApprovalIds: ['approval-command']
      }
    })

    expect(wrapper.findAll('.status-pill').map((pill) => pill.text())).toEqual(['已授权', '待授权'])
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()

    await wrapper.setProps({ approvedApprovalIds: ['approval-command', 'approval-file'] })
    expect(wrapper.findAll('.status-pill').map((pill) => pill.text())).toEqual(['已授权', '已授权'])
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    expect(wrapper.get('button').text()).toBe('已全部授权')
  })
})
