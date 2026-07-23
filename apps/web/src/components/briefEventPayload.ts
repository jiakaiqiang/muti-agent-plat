import type { BriefEventPayload, CollaborationEvent } from '@/types/contracts'

const briefEventTypes = new Set<CollaborationEvent['type']>(['brief_created', 'brief_updated'])

function isBriefEventPayload(payload: unknown): payload is BriefEventPayload {
  if (!payload || typeof payload !== 'object') return false
  const candidate = payload as Partial<BriefEventPayload>
  return (
    typeof candidate.briefId === 'string' &&
    typeof candidate.version === 'number' &&
    typeof candidate.goal === 'string' &&
    Array.isArray(candidate.scope) &&
    Array.isArray(candidate.outOfScope) &&
    Array.isArray(candidate.constraints) &&
    Array.isArray(candidate.acceptanceCriteria) &&
    Array.isArray(candidate.risks) &&
    Array.isArray(candidate.openQuestions) &&
    typeof candidate.requiresUserConfirmation === 'boolean'
  )
}

export function findLatestBriefPayload(events: CollaborationEvent[], briefId?: string): BriefEventPayload | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!briefEventTypes.has(event.type)) continue
    const payload = event.metadata.payload
    if (isBriefEventPayload(payload) && (!briefId || payload.briefId === briefId)) return payload
  }
  return undefined
}
