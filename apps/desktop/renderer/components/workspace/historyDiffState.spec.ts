import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useHistoryDiffStore } from '@/stores/historyDiff'
import { useEventStore } from '@/stores/event'
import { apiGet } from '@/api/client'
import type { CollaborationEvent } from '@/types/contracts'
vi.mock('@/api/client', () => ({ apiGet: vi.fn() }))

describe('historical Diff context', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks() })
  it('does not reopen a dismissed dialog when an artifact response arrives late', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(apiGet).mockReturnValue(new Promise(done => { resolve = done }))
    const diff = useHistoryDiffStore()
    const pending = diff.openArtifact('artifact', 'a'); diff.close()
    resolve({ id: 'artifact', sessionId: 'a', title: 'Old response' }); await pending
    expect(diff.visible).toBe(false)
  })
  it('retains saved file contents while new and duplicate confirmation events arrive', () => {
    const diff = useHistoryDiffStore()
    const file = { path: 'a.ts', operation: 'update' as const, before: 'before', after: 'after' }
    diff.open({ files: [file], title: 'History', source: 'attempt-1', sessionId: 'a' })
    file.after = 'later local edit'
    const events = useEventStore()
    const event = { id: 'notice', sessionId: 'a', type: 'user_confirmation_requested', content: 'Verify', createdAt: '2026-09-11T00:00:00Z', toAgentIds: [], metadata: { payload: { confirmationId: 'confirmation', reason: 'confirm_workflow_human_gate', title: 'Verify', options: [] } } } as CollaborationEvent
    events.appendEvent(event); events.appendEvent(event)
    expect(diff.visible).toBe(true)
    expect(diff.files[0].after).toBe('after')
    expect(events.chatMessages('a').filter(message => message.messageType === 'confirmation')).toHaveLength(1)
  })
  it('resolves a delivery artifact through its task instead of the latest session run', async () => {
    vi.mocked(apiGet).mockImplementation(async path => {
      if (path === '/artifacts/evidence') return { id: 'evidence', sessionId: 'a', taskId: 'old-task' } as never
      if (path === '/sessions/a/tasks') return [{ id: 'old-task', sessionId: 'a', workflowRunId: 'old-run' }, { id: 'new-task', sessionId: 'a', workflowRunId: 'new-run' }] as never
      return { status: 'complete', source: 'old-run', files: [] } as never
    })
    const diff = useHistoryDiffStore(); await diff.openDeliveryArtifact('evidence', 'a')
    expect(apiGet).toHaveBeenCalledWith('/workflow-runs/old-run/file-diff')
    expect(apiGet).not.toHaveBeenCalledWith('/workflow-runs/new-run/file-diff')
    expect(diff.source).toBe('old-run')
  })
})
