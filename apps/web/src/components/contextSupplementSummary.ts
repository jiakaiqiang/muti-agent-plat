import type { CollaborationEvent } from '@/types/contracts'

export type ContextSupplementSummary = {
  hydrated: number
  failed: number
  deferred: number
}

export function summarizeContextSupplement(events: CollaborationEvent[]): ContextSupplementSummary {
  return events.reduce<ContextSupplementSummary>(
    (summary, event) => {
      const payload = event.metadata.payload as
        | {
            phase?: string
            rejectionReason?: string
            resolution?: { hydratedPaths?: string[]; failedPaths?: unknown[]; deferredPaths?: string[] }
          }
        | undefined
      if (event.type !== 'agent_message' || payload?.phase !== 'context_supplement') return summary
      summary.hydrated += payload.resolution?.hydratedPaths?.length ?? 0
      summary.failed += (payload.resolution?.failedPaths?.length ?? 0) + (payload.rejectionReason ? 1 : 0)
      summary.deferred += payload.resolution?.deferredPaths?.length ?? 0
      return summary
    },
    { hydrated: 0, failed: 0, deferred: 0 }
  )
}
