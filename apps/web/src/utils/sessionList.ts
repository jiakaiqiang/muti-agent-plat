import type { SessionListItem } from '@/types/contracts'

/** Session tabs that list live Sessions. Deleted Sessions are never listed. */
export type ListableSessionTab = 'all' | 'mine' | 'favorites'

/** Normalises the shared tab store value; any other tab lists everything live. */
export function listableTab(tab: string): ListableSessionTab {
  return tab === 'mine' || tab === 'favorites' ? tab : 'all'
}

/** Live Sessions the sidebar lists, in store order. Shared by web and desktop. */
export function listableSessions(
  sessions: SessionListItem[],
  options: { tab: ListableSessionTab; favoriteSessionIds: string[]; search?: string }
): SessionListItem[] {
  const favorites = new Set(options.favoriteSessionIds)
  const query = options.search?.trim().toLowerCase() ?? ''
  return sessions.filter((session) => {
    if (session.lifecycleState === 'deleted' || session.archivedAt) return false
    if (options.tab === 'favorites' && !favorites.has(session.id)) return false
    if (query && !`${session.title} ${session.latestEventSummary ?? ''}`.toLowerCase().includes(query)) return false
    return true
  })
}

/**
 * Picks the Session to open after `removedId` is deleted or archived: the nearest
 * one below it in the order captured beforehand, otherwise the nearest one above.
 * Only ids still listed afterwards qualify; undefined means the list is empty.
 */
export function sessionAfterRemoval(orderBefore: string[], removedId: string, remainingIds: string[]) {
  const remaining = new Set(remainingIds)
  const index = orderBefore.indexOf(removedId)
  if (index < 0) return remainingIds[0]
  for (let next = index + 1; next < orderBefore.length; next += 1) {
    if (remaining.has(orderBefore[next]!)) return orderBefore[next]
  }
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (remaining.has(orderBefore[previous]!)) return orderBefore[previous]
  }
  return remainingIds[0]
}
