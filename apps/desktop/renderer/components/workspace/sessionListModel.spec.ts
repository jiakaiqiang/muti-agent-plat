import { describe, expect, it } from 'vitest'
import type { SessionListItem } from '@/types/contracts'
import { groupVisibleSessions, visibleSessionOrder } from './sessionListModel'

function item(id: string, extra: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id, title: id, status: 'COMPLETED', agentCount: 1, requiresUserAction: false, tokenUsed: 0,
    createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', ...extra
  }
}

describe('desktop session list order', () => {
  it('never lists deleted or archived Sessions on any tab', () => {
    const sessions = [item('a'), item('gone', { lifecycleState: 'deleted' }), item('old', { archivedAt: '2026-10-12T00:00:00.000Z' })]
    for (const tab of ['all', 'mine', 'favorites'] as const) {
      expect(visibleSessionOrder(sessions, tab, ['a', 'gone', 'old'])).toEqual(['a'])
    }
  })

  it('orders Sessions exactly as the sidebar groups them', () => {
    const sessions = [item('w1-a', { workspaceId: 'w1' }), item('w2-a', { workspaceId: 'w2' }), item('w1-b', { workspaceId: 'w1' })]
    expect(groupVisibleSessions(sessions, 'all', []).map(group => group.sessions.map(session => session.id)))
      .toEqual([['w1-a', 'w1-b'], ['w2-a']])
    expect(visibleSessionOrder(sessions, 'all', [])).toEqual(['w1-a', 'w1-b', 'w2-a'])
  })
})
