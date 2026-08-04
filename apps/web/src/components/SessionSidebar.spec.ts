import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import type { SessionListItem, SessionStatus } from '@/types/contracts'
import SessionSidebar from './SessionSidebar.vue'

const statuses: Array<{ status: SessionStatus; label: string; tone: string }> = [
  { status: 'DRAFT_INPUT', label: '待理解', tone: 'draft' },
  { status: 'AGENT_DISCUSSING', label: '讨论中', tone: 'running' },
  { status: 'WAIT_USER_CONFIRM', label: '待确认', tone: 'waiting' },
  { status: 'WAIT_WORKFLOW_SELECT', label: '选流程', tone: 'waiting' },
  { status: 'WAIT_WORKFLOW_STEP_CONFIRM', label: '待确认', tone: 'waiting' },
  { status: 'REVISING_BRIEF', label: '修订中', tone: 'running' },
  { status: 'EXECUTING', label: '执行中', tone: 'running' },
  { status: 'POST_REVIEW', label: '复盘中', tone: 'running' },
  { status: 'REWORKING', label: '返工中', tone: 'running' },
  { status: 'APPLYING_CHANGES', label: '写回中', tone: 'running' },
  { status: 'WAIT_WORKSPACE_CONFLICT_RESOLUTION', label: '待处理冲突', tone: 'waiting' },
  { status: 'WAIT_USER_DECISION', label: '待决策', tone: 'waiting' },
  { status: 'PAUSED', label: '已停止', tone: 'waiting' },
  { status: 'INTERRUPTED', label: '已中断', tone: 'waiting' },
  { status: 'COMPLETED', label: '已完成', tone: 'completed' },
  { status: 'FAILED', label: '失败', tone: 'failed' },
  { status: 'CANCELLED', label: '已取消', tone: 'cancelled' }
]

function session(status: SessionStatus, index: number): SessionListItem {
  return {
    id: `session-${index}`,
    title: `会话 ${index}`,
    status,
    agentCount: 1,
    requiresUserAction: false,
    tokenUsed: 0,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z'
  }
}

function mountSidebar(sessions: SessionListItem[]) {
  return mount(SessionSidebar, {
    props: {
      sessions,
      favoriteSessionIds: [],
      deletingSessionIds: []
    },
    global: {
      plugins: [createPinia()],
      stubs: {
        AgentPortrait: true,
        UiIcon: true
      }
    }
  })
}

describe('SessionSidebar status badges', () => {
  it('renders every session contract status as a compact text badge', () => {
    const wrapper = mountSidebar(statuses.map(({ status }, index) => session(status, index)))
    const badges = wrapper.findAll('.session-status-badge')

    expect(badges).toHaveLength(statuses.length)
    statuses.forEach(({ label, tone }, index) => {
      expect(badges[index]?.text()).toBe(label)
      expect(badges[index]?.classes()).toContain(`status-${tone}`)
      expect(badges[index]?.attributes('aria-label')).toBe(`会话状态：${label}`)
    })
  })

  it('updates the avatar badge when a session finishes', async () => {
    const running = session('EXECUTING', 1)
    const wrapper = mountSidebar([running])

    expect(wrapper.get('.session-status-badge').text()).toBe('执行中')
    await wrapper.setProps({ sessions: [{ ...running, status: 'COMPLETED' }] })
    expect(wrapper.get('.session-status-badge').text()).toBe('已完成')
    expect(wrapper.get('.session-status-badge').classes()).toContain('status-completed')
  })

  it('emits the selected session id when the delete button is clicked', async () => {
    const wrapper = mountSidebar([session('COMPLETED', 1)])

    await wrapper.get('.session-delete-button').trigger('click')

    expect(wrapper.emitted('delete')).toEqual([['session-1']])
  })
})
