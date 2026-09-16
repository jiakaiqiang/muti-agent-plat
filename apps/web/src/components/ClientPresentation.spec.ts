import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import WebSidebar from './SessionSidebar.vue'
import DesktopSidebar from '../../../desktop/renderer/components/SessionSidebar.vue'
import type { SessionListItem } from '@/types/contracts'

const session: SessionListItem = {
  id: 'presentation-session', title: '需求开发验证', status: 'EXECUTING',
  agentCount: 1, requiresUserAction: false, tokenUsed: 0,
  createdAt: '2026-09-11T00:00:00Z', updatedAt: '2026-09-11T00:00:00Z'
}

describe('independent client presentations', () => {
  it('keeps Web conversation avatars while desktop task records have no icon slot', async () => {
    const props = { sessions: [session], favoriteSessionIds: [], deletingSessionIds: [] }
    const web = mount(WebSidebar, { props, global: { plugins: [createPinia()] } })
    const desktop = mount(DesktopSidebar, { props, global: { plugins: [createPinia()] } })
    expect(web.find('.session-avatar .agent-portrait').exists()).toBe(true)
    expect(web.text()).toContain('新建会话')
    expect(web.find('.sidebar-catalog-button').exists()).toBe(false)
    expect(desktop.find('.session-list-item .agent-portrait').exists()).toBe(false)
    expect(desktop.find('.session-avatar').exists()).toBe(false)
    expect(desktop.text()).toContain('新建任务')
    expect(desktop.find('a[href="/workflows"]').exists()).toBe(false)
    expect(desktop.find('.sidebar-catalog-button, .sidebar-management, .session-search').exists()).toBe(false)
    for (const wrapper of [web, desktop]) {
      await wrapper.get('.session-list-item').trigger('click')
      expect(wrapper.emitted('select')).toEqual([[session.id]])
      await wrapper.setProps({ sessions: [{ ...session, status: 'COMPLETED' }] })
      expect(wrapper.get('.session-status-badge').text()).toBe('已完成')
      wrapper.unmount()
    }
    vi.restoreAllMocks()
  })
})
