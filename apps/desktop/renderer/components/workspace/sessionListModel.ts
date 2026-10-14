import type { SessionListItem } from '@/types/contracts'
import { listableSessions, type ListableSessionTab } from '@/utils/sessionList'

export type SessionGroup = { key: string; label: string; sessions: SessionListItem[] }

/** Groups the listable Sessions in the order the desktop sidebar renders them. */
export function groupVisibleSessions(
  sessions: SessionListItem[],
  tab: ListableSessionTab,
  favoriteSessionIds: string[]
): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  for (const session of listableSessions(sessions, { tab, favoriteSessionIds })) {
    const key = session.projectId ? `project:${session.projectId}` : `workspace:${session.workspaceId ?? ''}`
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: session.projectId ? `项目 ${session.projectId}` : session.workspaceId ? `工作区 ${session.workspaceId}` : '未分组任务',
        sessions: []
      })
    }
    groups.get(key)!.sessions.push(session)
  }
  return [...groups.values()]
}

/** Session ids top to bottom, as the user sees them in the desktop sidebar. */
export function visibleSessionOrder(sessions: SessionListItem[], tab: ListableSessionTab, favoriteSessionIds: string[]) {
  return groupVisibleSessions(sessions, tab, favoriteSessionIds).flatMap(group => group.sessions.map(session => session.id))
}
