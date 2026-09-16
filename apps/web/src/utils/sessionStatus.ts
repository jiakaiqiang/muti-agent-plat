import type { CollaborationEvent, SessionStatus } from '@/types/contracts'

// INTERRUPTED 不是终态：中断只表示服务端丢了执行所有权，会话仍可续接。
// 该集合只决定 error_reported 事件是否被当作状态来源，而中断写的是
// session_status_changed，所以移除它在功能上等价，语义上才正确。
const terminal = new Set<SessionStatus>(['COMPLETED', 'FAILED', 'CANCELLED'])

export function latestSessionStatusEvent(sessionId: string, events: CollaborationEvent[]) {
  return [...events].reverse().find(item => item.sessionId === sessionId && (
    item.type === 'session_status_changed' ||
    (item.type === 'error_reported' && terminal.has(item.metadata.payload?.status as SessionStatus))
  ))
}

export function resolveSessionStatus(
  session: { id: string; status: SessionStatus; updatedAt: string } | undefined,
  events: CollaborationEvent[]
): SessionStatus | undefined {
  if (!session) return undefined
  const event = latestSessionStatusEvent(session.id, events)
  // A completed event from an earlier run must not override a freshly resumed snapshot.
  if (!event || Date.parse(event.createdAt) < Date.parse(session.updatedAt)) return session.status
  return (event.metadata.payload?.status as SessionStatus | undefined) ?? session.status
}
