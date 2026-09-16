import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CollaborationEvent } from '@/types/contracts'
import { normalizeCollaborationEvent, shouldRenderInTimeline, useEventStore } from './event'

function eventWithoutContent(payload: Record<string, unknown> = {}) {
  return {
    id: 'event-without-content',
    sessionId: 'session-1',
    type: 'agent_message',
    toAgentIds: [],
    metadata: { schemaVersion: '0.1', renderAs: 'chat_message', payload },
    createdAt: '2026-07-15T00:00:00.000Z'
  } as unknown as CollaborationEvent
}

describe('normalizeCollaborationEvent', () => {
  it('recovers display content from a legacy payload', () => {
    expect(normalizeCollaborationEvent(eventWithoutContent({ message: '恢复后的消息' })).content).toBe('恢复后的消息')
  })

  it('uses a stable placeholder when legacy content cannot be recovered', () => {
    expect(normalizeCollaborationEvent(eventWithoutContent()).content).toBe('该事件缺少可展示内容')
  })
})

describe('timeline runtime diagnostics boundary', () => {
  it('does not render debug visibility or raw provider diagnostics', () => {
    const base = eventWithoutContent({ message: 'internal' })
    expect(shouldRenderInTimeline({
      ...base,
      type: 'runtime_progress',
      metadata: { ...base.metadata, payload: { visibility: 'debug' } }
    })).toBe(false)
    expect(shouldRenderInTimeline({
      ...base,
      type: 'runtime_progress',
      metadata: { ...base.metadata, payload: { code: 'STREAM_SYSTEM' } }
    })).toBe(false)
    expect(shouldRenderInTimeline({
      ...base,
      type: 'runtime_progress',
      content: 'remoteControl/status/changed',
      metadata: { ...base.metadata, payload: {} }
    })).toBe(false)
    expect(shouldRenderInTimeline({
      ...base,
      type: 'runtime_progress',
      content: 'internal',
      metadata: { ...base.metadata, payload: { method: 'mcpServer/startupStatus/updated' } }
    })).toBe(false)
    expect(shouldRenderInTimeline({
      ...base,
      type: 'runtime_progress',
      content: 'Prepared an isolated Git worktree for this task.',
      metadata: { ...base.metadata, payload: { code: 'WORKTREE_PREPARED' } }
    })).toBe(false)
    expect(shouldRenderInTimeline({
      ...base,
      type: 'runtime_progress',
      content: '"mentionedAgentIds":[]',
      metadata: { ...base.metadata, payload: { code: 'STREAM_TEXT' } }
    })).toBe(false)
  })

  it('does not render internal summary memory checkpoint artifacts', () => {
    const base = eventWithoutContent()
    expect(shouldRenderInTimeline({
      ...base,
      type: 'artifact_created',
      content: 'Summary memory checkpoint: brief_generation',
      metadata: {
        ...base.metadata,
        renderAs: 'artifact_card',
        payload: {
          phase: 'summary_memory_checkpoint',
          visibility: 'internal',
          checkpointId: 'checkpoint-1',
          memoryId: 'memory-1'
        }
      }
    })).toBe(false)
  })

  it('does not render historical capability approval waits as runtime failures', () => {
    const base = eventWithoutContent()
    expect(shouldRenderInTimeline({
      ...base,
      type: 'runtime_failed',
      content: '运行时执行任务失败',
      metadata: {
        ...base.metadata,
        renderAs: 'error_card',
        payload: { code: 'HUMAN_APPROVAL_REQUIRED' }
      }
    })).toBe(false)
    expect(shouldRenderInTimeline({
      ...base,
      type: 'task_rejected',
      content: '任务执行失败',
      metadata: {
        ...base.metadata,
        renderAs: 'task_card',
        payload: { resultSummary: 'HUMAN_APPROVAL_REQUIRED' }
      }
    })).toBe(false)
  })

  it('keeps live stop-state updates out of the chat timeline', () => {
    const base = eventWithoutContent()
    expect(shouldRenderInTimeline({
      ...base,
      type: 'runtime_progress',
      content: '执行已停止。',
      metadata: { ...base.metadata, payload: { code: 'RUNTIME_STOP_STATE_CHANGED' } }
    })).toBe(false)
  })

  it('folds only adjacent legacy receipts for the same invocation and state', () => {
    setActivePinia(createPinia())
    const store = useEventStore()
    const receipt = (id: string, invocationId: string, createdAt: string): CollaborationEvent => ({
      ...eventWithoutContent(),
      id,
      type: 'runtime_progress',
      content: '已确认上一次执行停止，可以继续会话。',
      metadata: {
        schemaVersion: '0.1',
        renderAs: 'system_notice',
        payload: { code: 'RUNTIME_STOP_CONFIRMED', runtimeInvocationId: invocationId, stopState: 'confirmed' }
      },
      createdAt
    } as CollaborationEvent)
    store.appendEvent(receipt('stop-1', 'invocation-1', '2026-09-14T10:52:08.000Z'))
    store.appendEvent(receipt('stop-2', 'invocation-1', '2026-09-14T10:52:11.000Z'))
    store.appendEvent({ ...eventWithoutContent({ message: '业务失败原因' }), id: 'business', content: '业务失败原因' })
    store.appendEvent(receipt('stop-3', 'invocation-1', '2026-09-14T10:52:14.000Z'))
    store.appendEvent(receipt('stop-4', 'invocation-2', '2026-09-14T10:52:17.000Z'))

    const messages = store.chatMessages('session-1')
    expect(messages).toHaveLength(4)
    expect(messages[0]?.payload?.collapsedStopReceiptCount).toBe(2)
    expect(messages[0]?.payload?.collapsedStopReceiptTimes).toHaveLength(2)
    expect(messages[1]?.content).toBe('业务失败原因')
  })

  it('folds the 43 historical receipts while preserving every original event and timestamp', () => {
    setActivePinia(createPinia())
    const store = useEventStore()
    const startedAt = Date.parse('2026-09-14T10:52:08.000Z')
    for (let index = 0; index < 43; index += 1) {
      store.appendEvent({
        ...eventWithoutContent(),
        id: `historical-stop-${index + 1}`,
        type: 'runtime_progress',
        content: '已确认上一次执行停止，可以继续会话。',
        metadata: {
          schemaVersion: '0.1',
          renderAs: 'system_notice',
          payload: {
            code: 'RUNTIME_STOP_CONFIRMED',
            runtimeInvocationId: 'historical-invocation',
            stopState: 'confirmed'
          }
        },
        createdAt: new Date(startedAt + index * 3_000).toISOString()
      } as CollaborationEvent)
    }

    const messages = store.chatMessages('session-1')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.payload?.collapsedStopReceiptCount).toBe(43)
    expect(messages[0]?.payload?.collapsedStopReceiptTimes).toHaveLength(43)
    expect(store.eventsForSession('session-1')).toHaveLength(43)
  })
})

describe('intent clarification projection', () => {
  it('projects intent clarification as a resolvable confirmation card', () => {
    setActivePinia(createPinia())
    const store = useEventStore()
    store.appendEvent({
      id: 'intent-clarification-1', sessionId: 'session-1', type: 'intent_clarification_required',
      content: '请选择任务关系。', priority: 'high',
      metadata: {
        schemaVersion: '0.1', renderAs: 'confirmation_card', payload: {
          confirmationId: 'confirmation-1', reason: 'intent_relation_clarification',
          routingId: 'routing-1', followUpMessageId: 'follow-up-1', reasonCodes: ['INTENT_AMBIGUOUS'],
          title: '选择任务关系', description: '把那个也改一下',
          options: [{ key: 'continue_current', label: '继续当前任务', style: 'primary' }]
        }
      },
      createdAt: '2026-08-07T00:00:00.000Z'
    })

    expect(store.activeConfirmation('session-1')).toMatchObject({
      confirmationId: 'confirmation-1', reason: 'intent_relation_clarification', routingId: 'routing-1'
    })
    expect(store.chatMessages('session-1')[0]?.messageType).toBe('confirmation')

    store.appendEvent({
      id: 'intent-clarification-resolved', sessionId: 'session-1', type: 'user_confirmation_resolved',
      content: '任务关系已确认。', priority: 'normal',
      metadata: {
        schemaVersion: '0.1', renderAs: 'system_notice',
        payload: { confirmationId: 'confirmation-1', status: 'approved' }
      },
      createdAt: '2026-08-07T00:00:01.000Z'
    })
    expect(store.activeConfirmation('session-1')).toBeUndefined()
  })
})
