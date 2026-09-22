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
      deletingSessionIds: [],
      archiveGroups: []
    },
    global: {
      plugins: [createPinia()],
      stubs: {
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

  it('updates the task status badge when a session finishes', async () => {
    const running = session('EXECUTING', 1)
    const wrapper = mountSidebar([running])

    expect(wrapper.get('.session-status-badge').text()).toBe('执行中')
    await wrapper.setProps({ sessions: [{ ...running, status: 'COMPLETED' }] })
    expect(wrapper.get('.session-status-badge').text()).toBe('已完成')
    expect(wrapper.get('.session-status-badge').classes()).toContain('status-completed')
  })

  it('opens the session actions from the three-dot button', async () => {
    const wrapper = mountSidebar([session('COMPLETED', 1)])

    await wrapper.get('.session-more-button').trigger('click')

    expect(document.body.textContent).toContain('归档会话')
    expect(document.body.textContent).toContain('删除会话')
  })

  it('shows deleted Sessions only in the deleted tab and emits restore', async () => {
    const deleted = { ...session('PAUSED', 2), lifecycleState: 'deleted' as const, lifecycleGeneration: 2 }
    const wrapper = mountSidebar([session('EXECUTING', 1), deleted])

    expect(wrapper.text()).toContain('会话 1')
    expect(wrapper.text()).not.toContain('会话 2')
    await wrapper.findAll('.session-tabs button')[3]!.trigger('click')

    expect(wrapper.text()).not.toContain('会话 1')
    expect(wrapper.text()).toContain('会话 2')
    expect(wrapper.get('.session-status-badge').text()).toBe('已删除')
    await wrapper.get('.session-more-button').trigger('click')
    const restoreButton = Array.from(document.body.querySelectorAll('.session-context-menu button')).find((button) => button.textContent?.includes('恢复会话')) as HTMLElement | undefined
    restoreButton?.click()
    expect(wrapper.emitted('restore')).toEqual([['session-2']])
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('shows archive groups and emits archive restore', async () => {
    const wrapper = mount(SessionSidebar, {
      props: {
        sessions: [], favoriteSessionIds: [], deletingSessionIds: [],
        archiveGroups: [{ projectKey: 'p1', projectLabel: '项目一', items: [{ id: 'archived-1', title: '历史会话', projectId: 'p1', archivedAt: '2026-09-21T00:00:00.000Z', createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' }] }]
      },
      global: { plugins: [createPinia()], stubs: { UiIcon: true } }
    })
    await wrapper.findAll('.session-tabs button')[4]!.trigger('click')
    expect(wrapper.text()).toContain('历史会话')
    await wrapper.get('.session-archive-restore').trigger('click')
    expect(wrapper.emitted('restoreArchive')).toEqual([['archived-1']])
  })
})
