import { describe, expect, it } from 'vitest'
import type { BriefEventPayload, CollaborationEvent, CollaborationEventType } from '@/types/contracts'
import { findLatestBriefPayload } from './briefEventPayload'

const brief: BriefEventPayload = {
  briefId: 'brief-1',
  version: 1,
  goal: 'Build the feature.',
  scope: ['UI'],
  outOfScope: [],
  constraints: [],
  acceptanceCriteria: ['The dialog opens.'],
  risks: [],
  openQuestions: [],
  suggestedTasks: [],
  requiresUserConfirmation: true
}

function event(type: CollaborationEventType, payload: Record<string, unknown>): CollaborationEvent {
  return {
    id: crypto.randomUUID(),
    sessionId: 'session-1',
    type,
    priority: 'normal',
    toAgentIds: [],
    content: type,
    metadata: { schemaVersion: 1, payloadType: 'test', payload },
    createdAt: '2026-07-14T00:00:00.000Z'
  }
}

describe('findLatestBriefPayload', () => {
  it('ignores later lightweight events that only reference the brief id', () => {
    const events = [
      event('brief_created', brief),
      event('brief_confirmed', { briefId: brief.briefId }),
      event('user_confirmation_requested', {
        confirmationId: 'confirmation-1',
        reason: 'select_workflow',
        relatedBriefId: brief.briefId
      })
    ]

    expect(findLatestBriefPayload(events, brief.briefId)).toEqual(brief)
  })

  it('returns the latest complete brief event', () => {
    const updated = { ...brief, version: 2, goal: 'Build and verify the feature.' }
    expect(findLatestBriefPayload([event('brief_created', brief), event('brief_updated', updated)])).toEqual(updated)
  })
})
