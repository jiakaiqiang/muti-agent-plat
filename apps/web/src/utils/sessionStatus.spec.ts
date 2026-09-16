import { describe, expect, it } from 'vitest'
import type { CollaborationEvent, SessionStatus } from '@/types/contracts'
import { resolveSessionStatus } from './sessionStatus'

const snapshot = { id: 'current', status: 'EXECUTING' as SessionStatus, updatedAt: '2026-09-11T10:00:00Z' }
function event(status: SessionStatus, createdAt: string, sessionId = 'current') {
  return { sessionId, type: 'session_status_changed', metadata: { payload: { status } }, createdAt } as CollaborationEvent
}
describe('session snapshot and event ordering', () => {
  it('uses a resumed snapshot over an earlier terminal event', () => {
    expect(resolveSessionStatus(snapshot, [event('COMPLETED', '2026-09-11T09:00:00Z')])).toBe('EXECUTING')
  })
  it('uses a newer status event without waiting for a snapshot refresh', () => {
    expect(resolveSessionStatus(snapshot, [event('COMPLETED', '2026-09-11T10:01:00Z')])).toBe('COMPLETED')
  })
  it('treats an interrupted snapshot as a live status rather than a terminal one', () => {
    // 中断只表示服务端丢了执行所有权，会话仍可续接；这里锁住它不被当作终态。
    const interrupted = { id: 'current', status: 'INTERRUPTED' as SessionStatus, updatedAt: '2026-09-11T10:00:00Z' }
    expect(resolveSessionStatus(interrupted, [])).toBe('INTERRUPTED')
    // 用户续接后的新事件必须能盖掉中断快照。
    expect(resolveSessionStatus(interrupted, [event('AGENT_DISCUSSING', '2026-09-11T10:01:00Z')]))
      .toBe('AGENT_DISCUSSING')
  })
  it('ignores another session and has no status without a selected session', () => {
    expect(resolveSessionStatus(snapshot, [event('FAILED', '2026-09-11T10:01:00Z', 'other')])).toBe('EXECUTING')
    expect(resolveSessionStatus(undefined, [])).toBeUndefined()
  })
})
