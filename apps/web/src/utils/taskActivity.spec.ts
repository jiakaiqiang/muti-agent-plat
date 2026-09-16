import { describe, expect, it } from 'vitest'
import type { CollaborationEvent, SessionStatus } from '@/types/contracts'
import { taskActivity } from './taskActivity'

const now = Date.parse('2026-09-11T10:30:00Z')
function event(type: CollaborationEvent['type'], age = 0, sessionId = 'current'): CollaborationEvent {
  return { id: `${type}-${age}`, sessionId, type, content: '', toAgentIds: [], metadata: { schemaVersion: '0.1', payload: {} }, createdAt: new Date(now - age).toISOString() }
}
const input = { session: { id: 'current', status: 'EXECUTING' as SessionStatus }, events: [event('runtime_progress')], connectedSessionId: 'current', connectionState: 'connected', unavailable: false, now }

describe('shared task activity feedback', () => {
  it('shows pending termination after interruption, then clears it on a confirmed receipt', () => {
    const stopped = event('runtime_failed');
    stopped.metadata.payload = { stopState: 'unconfirmed' };
    const paused = { ...input, session: { id: 'current', status: 'INTERRUPTED' as SessionStatus } };
    expect(taskActivity({ ...paused, events: [stopped] })?.text).toContain('暂不能重新执行');
    const confirmed = event('runtime_progress');
    confirmed.metadata.payload = { stopState: 'confirmed' };
    expect(taskActivity({ ...paused, events: [stopped, confirmed] })).toBeUndefined();
    const retry = event('runtime_progress');
    retry.metadata.payload = { code: 'RUNTIME_PROVIDER_RETRY_SCHEDULED' };
    expect(taskActivity({ ...input, events: [retry] })?.text).toContain('有限重试');
    retry.metadata.payload = { code: 'SUBMISSION_REPAIR_STARTED' };
    expect(taskActivity({ ...input, events: [retry] })?.text).toContain('已保存修改');
  });
  it('does not treat keepalives as progress or overwrite a schema error from another agent', () => {
    const failed = event('tool_completed', 100_000)
    failed.fromAgentId = 'agent-a'
    failed.metadata.payload = { runtimeInvocationId: 'call-a', name: 'StructuredOutput', isError: true }
    const heartbeat = event('runtime_progress')
    heartbeat.metadata.payload = { code: 'RUNTIME_HEARTBEAT', runtimeInvocationId: 'call-a' }
    expect(taskActivity({ ...input, events: [heartbeat] })?.tone).toBe('waiting')
    const other = event('tool_called')
    other.fromAgentId = 'agent-b'
    other.metadata.payload = { runtimeInvocationId: 'call-b', name: 'Read' }
    expect(taskActivity({ ...input, events: [failed, heartbeat, other] })?.text).toContain('暂未收到新的纠正进度')
    const repaired = event('tool_completed')
    repaired.metadata.payload = { runtimeInvocationId: 'call-a', name: 'StructuredOutput', isError: false }
    expect(taskActivity({ ...input, events: [failed, heartbeat, repaired] })?.tone).toBe('running')
  })
  it('shows running only with an active task, its live connection and recent activity', () => {
    expect(taskActivity(input)).toEqual({ tone: 'running', text: '正在运行你的任务，请稍等' })
    expect(taskActivity({ ...input, connectionState: 'reconnecting' })?.tone).toBe('waiting')
    expect(taskActivity({ ...input, unavailable: true })?.tone).toBe('warning')
    expect(taskActivity({ ...input, connectedSessionId: 'previous' })?.tone).toBe('waiting')
    expect(taskActivity({ ...input, events: [event('runtime_progress', 0, 'previous')] })?.tone).toBe('waiting')
  })
  it('does not mistake server health or an old event for current execution', () => {
    expect(taskActivity({ ...input, events: [] })?.tone).toBe('waiting')
    expect(taskActivity({ ...input, now: now + 95_000 })?.tone).toBe('waiting')
    expect(taskActivity({ ...input, events: [event('runtime_completed')] })?.tone).toBe('waiting')
  })
  it('replaces failure feedback when an actual retry starts', () => {
    const events = [event('runtime_started', 60_000), event('runtime_failed', 1000)]
    expect(taskActivity({ ...input, events })?.tone).toBe('warning')
    expect(taskActivity({ ...input, events: [...events, event('runtime_started')] })?.tone).toBe('running')
  })
  it('hides feedback when there is no task, or it finishes, pauses or awaits a decision', () => {
    expect(taskActivity({ ...input, session: undefined })).toBeUndefined()
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'PAUSED', 'WAIT_USER_CONFIRM', 'WAIT_USER_DECISION', 'WAIT_WORKFLOW_SELECT', 'WAIT_WORKFLOW_STEP_CONFIRM'] as SessionStatus[]) {
      expect(taskActivity({ ...input, session: { id: 'current', status } })).toBeUndefined()
    }
  })
})
