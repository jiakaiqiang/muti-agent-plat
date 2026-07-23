import { describe, expect, it } from 'vitest'
import type { CollaborationEvent } from '@/types/contracts'
import { normalizeCollaborationEvent, shouldRenderInTimeline } from './event'

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
      content: 'Prepared an isolated browser workspace mirror for this Runtime.',
      metadata: { ...base.metadata, payload: { code: 'BROWSER_MIRROR_PREPARED' } }
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
})
