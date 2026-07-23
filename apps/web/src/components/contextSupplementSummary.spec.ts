import { describe, expect, it } from 'vitest'
import type { CollaborationEvent } from '@/types/contracts'
import { summarizeContextSupplement } from './contextSupplementSummary'

function event(payload: Record<string, unknown>): CollaborationEvent {
  return {
    id: crypto.randomUUID(),
    sessionId: 'session-1',
    type: 'agent_message',
    priority: 'normal',
    toAgentIds: [],
    content: 'supplement',
    metadata: { schemaVersion: 1, payloadType: 'chat_message', payload },
    createdAt: '2026-07-13T00:00:00.000Z'
  }
}

describe('context supplement summary', () => {
  it('does not count failed or rejected reads as hydrated evidence', () => {
    expect(
      summarizeContextSupplement([
        event({
          phase: 'context_supplement',
          resolution: {
            hydratedPaths: ['src/main.ts'],
            failedPaths: [{ path: 'src/missing.ts', code: 'NOT_FOUND' }],
            deferredPaths: ['src/later.ts']
          }
        }),
        event({ phase: 'context_supplement', rejectionReason: 'duplicate_request' })
      ])
    ).toEqual({ hydrated: 1, failed: 2, deferred: 1 })
  })
})
