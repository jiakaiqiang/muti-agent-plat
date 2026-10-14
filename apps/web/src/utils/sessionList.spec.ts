import { describe, expect, it } from 'vitest'
import type { SessionListItem } from '@/types/contracts'
import { listableSessions, sessionAfterRemoval } from './sessionList'

function item(id: string, extra: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id, title: id, status: 'COMPLETED', agentCount: 1, requiresUserAction: false, tokenUsed: 0,
    createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', ...extra
  }
}

describe('listable Sessions', () => {
  it('never lists deleted or archived Sessions on any tab', () => {
    const sessions = [item('a'), item('gone', { lifecycleState: 'deleted' }), item('old', { archivedAt: '2026-10-12T00:00:00.000Z' })]
    for (const tab of ['all', 'mine', 'favorites'] as const) {
      expect(listableSessions(sessions, { tab, favoriteSessionIds: ['a', 'gone', 'old'] }).map(s => s.id)).toEqual(['a'])
    }
  })

  it('applies the favourites tab and the search text', () => {
    const sessions = [item('a', { title: 'Alpha' }), item('b', { title: 'Beta', latestEventSummary: 'needs alpha review' }), item('c')]
    expect(listableSessions(sessions, { tab: 'favorites', favoriteSessionIds: ['c'] }).map(s => s.id)).toEqual(['c'])
    expect(listableSessions(sessions, { tab: 'all', favoriteSessionIds: [], search: ' ALPHA ' }).map(s => s.id)).toEqual(['a', 'b'])
  })
})

describe('selection after removing the current Session', () => {
  it('selects the Session below the removed one', () => {
    expect(sessionAfterRemoval(['a', 'b', 'c'], 'b', ['a', 'c'])).toBe('c')
  })

  it('falls back to the Session above when the removed one was last', () => {
    expect(sessionAfterRemoval(['a', 'b', 'c'], 'c', ['a', 'b'])).toBe('b')
  })

  it('skips neighbours that disappeared meanwhile and prefers the nearest one below', () => {
    expect(sessionAfterRemoval(['a', 'b', 'c', 'd'], 'b', ['a', 'd'])).toBe('d')
    expect(sessionAfterRemoval(['a', 'b', 'c', 'd'], 'c', ['a'])).toBe('a')
  })

  it('returns nothing when no Session is left, so the workspace shows an empty state', () => {
    expect(sessionAfterRemoval(['a'], 'a', [])).toBeUndefined()
  })

  it('uses the first remaining Session when the removed one was not listed', () => {
    expect(sessionAfterRemoval(['a', 'b'], 'hidden', ['a', 'b'])).toBe('a')
  })
})
