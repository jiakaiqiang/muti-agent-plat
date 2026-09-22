import { describe, expect, it } from 'vitest'
import { buildCollaborationTaskPanels } from './collaborationTaskModel'
import type { AgentCardState, CollaborationEvent } from '@/types/contracts'

const agents: AgentCardState[] = [
  { agentId: 'front', name: 'Frontend', role: '前端', status: 'idle', recentLogs: [], waitingFor: [], activeCapabilityNames: [], usedRagSnippets: [], artifactIds: [], updatedAt: '2026-09-22T00:00:00.000Z' },
  { agentId: 'qa', name: 'QA', role: '测试', status: 'idle', recentLogs: [], waitingFor: [], activeCapabilityNames: [], usedRagSnippets: [], artifactIds: [], updatedAt: '2026-09-22T00:00:00.000Z' }
]

function event(id: string, type: CollaborationEvent['type'], createdAt: string, payload: Record<string, unknown>, extra: Partial<CollaborationEvent> = {}) {
  return {
    id,
    sessionId: 'session-1',
    type,
    content: `${id} output`,
    toAgentIds: [],
    metadata: { schemaVersion: '0.1', payload },
    createdAt,
    ...extra
  } as CollaborationEvent
}

const route = event('route-1', 'agent_message', '2026-09-22T00:00:00.000Z', {
  routing: { mode: 'distributed', reason: 'agent_candidates_without_skill', candidateAgentIds: ['front', 'qa'], distributionAgentIds: ['front', 'qa'] },
  agentRefs: [{ id: 'front', name: 'Frontend' }, { id: 'qa', name: 'QA' }],
  attachmentRefs: [{ id: 'image-1' }]
})

describe('buildCollaborationTaskPanels', () => {
  it('creates a routed panel with independent Agent states and attachment context', () => {
    const panels = buildCollaborationTaskPanels([route], agents)
    expect(panels[0]).toMatchObject({ routingMode: 'distributed', attachmentCount: 1, status: 'running' })
    expect(panels[0]?.agents.map((agent) => agent.agentId)).toEqual(['front', 'qa'])
  })

  it('deduplicates outputs and keeps terminal failure ahead of late progress', () => {
    const panels = buildCollaborationTaskPanels([
      route,
      event('progress', 'runtime_progress', '2026-09-22T00:00:03.000Z', { agentId: 'front', status: 'running' }),
      event('failed', 'task_failed', '2026-09-22T00:00:02.000Z', { agentId: 'qa', status: 'failed' }),
      event('failed', 'task_failed', '2026-09-22T00:00:02.000Z', { agentId: 'qa', status: 'failed' }),
      event('late', 'runtime_progress', '2026-09-22T00:00:04.000Z', { agentId: 'qa', status: 'running' })
    ], agents)
    const qa = panels[0]?.agents.find((agent) => agent.agentId === 'qa')
    expect(qa?.status).toBe('failed')
    expect(qa?.outputs.map((output) => output.id)).toEqual(['failed'])
    expect(panels[0]?.status).toBe('failed')
  })

  it('rebuilds the same panel from reverse event order for history refresh', () => {
    const ordered = buildCollaborationTaskPanels([route, event('done', 'task_completed', '2026-09-22T00:00:05.000Z', { agentId: 'front', status: 'completed' })], agents)
    const reversed = buildCollaborationTaskPanels([event('done', 'task_completed', '2026-09-22T00:00:05.000Z', { agentId: 'front', status: 'completed' }), route], agents)
    expect(reversed).toEqual(ordered)
  })

  it('keeps temporary and manual summary versions as immutable history', () => {
    const panels = buildCollaborationTaskPanels([
      route,
      event('summary-1', 'agent_message', '2026-09-22T00:00:06.000Z', {
        summaryKind: 'temporary_cancelled', summaryVersion: 1, collaborationTaskId: 'route-1', sourceEventIds: ['progress']
      }),
      event('summary-2', 'agent_message', '2026-09-22T00:00:07.000Z', {
        summaryKind: 'manual_resummary', summaryVersion: 2, collaborationTaskId: 'route-1', sourceEventIds: ['progress']
      })
    ], agents)
    expect(panels[0]?.summaries.map((summary) => summary.version)).toEqual([1, 2])
  })
})
