import type { AgentCardState, CollaborationEvent } from '@/types/contracts'

export type CollaborationAgentProgress = {
  agentId: string
  name: string
  role: string
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  progress: number
  outputs: Array<{ id: string; content: string; createdAt: string }>
}

export type CollaborationTaskPanelState = {
  taskId: string
  title: string
  skillName?: string
  routingMode: 'main' | 'single' | 'distributed'
  routingReason?: string
  resolvedAgentId?: string
  attachmentCount: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  agents: CollaborationAgentProgress[]
  summaries: Array<{ id: string; version: number; kind: 'temporary_cancelled' | 'manual_resummary'; content: string; sourceEventIds: string[] }>
}

type Payload = Record<string, unknown>

const statusRank: Record<CollaborationAgentProgress['status'], number> = {
  pending: 0,
  waiting: 1,
  running: 2,
  completed: 3,
  failed: 4,
  cancelled: 5
}

function payloadOf(event: CollaborationEvent): Payload {
  return (event.metadata.payload ?? {}) as Payload
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function agentIdOf(event: CollaborationEvent, payload: Payload) {
  const actorId = event.actor?.type === 'agent' ? event.actor.id : undefined
  return stringValue(payload.agentId) ?? actorId ?? event.fromAgentId
}

function statusOf(event: CollaborationEvent, payload: Payload): CollaborationAgentProgress['status'] | undefined {
  const raw = stringValue(payload.status)
  if (raw === 'cancelled') return 'cancelled'
  if (raw === 'failed' || event.type === 'task_failed' || event.type === 'runtime_failed' || event.type === 'task_rejected') return 'failed'
  if (raw === 'completed' || event.type === 'task_completed' || event.type === 'runtime_completed' || event.type === 'post_review_completed') return 'completed'
  if (raw === 'waiting' || raw === 'blocked' || event.type === 'task_waiting' || event.type === 'task_blocked') return 'waiting'
  if (raw === 'running' || event.type === 'task_started' || event.type === 'runtime_started') return 'running'
  if (event.type === 'agent_message' || event.type === 'agent_status_changed') return 'running'
  return undefined
}

function progressOf(status: CollaborationAgentProgress['status']) {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
    ? 100
    : status === 'running' ? 50 : status === 'waiting' ? 25 : 0
}

function addOutput(agent: CollaborationAgentProgress, event: CollaborationEvent) {
  if (!event.content.trim() || agent.outputs.some((output) => output.id === event.id)) return
  agent.outputs.push({ id: event.id, content: event.content, createdAt: event.createdAt })
}

function routePayload(event: CollaborationEvent) {
  if (event.type !== 'agent_message') return undefined
  const payload = payloadOf(event)
  const routing = payload.routing
  if (!routing || typeof routing !== 'object') return undefined
  return { payload, routing: routing as Payload }
}

function panelFromRoute(event: CollaborationEvent, agents: AgentCardState[]): CollaborationTaskPanelState | undefined {
  const route = routePayload(event)
  if (!route) return undefined
  const routing = route.routing
  const refs = Array.isArray(route.payload.agentRefs) ? route.payload.agentRefs as Array<Payload> : []
  const candidateIds = Array.isArray(routing.candidateAgentIds)
    ? routing.candidateAgentIds.filter((id): id is string => typeof id === 'string')
    : []
  const resolvedAgentId = stringValue(routing.resolvedAgentId)
  const ids = [...new Set([...candidateIds, ...(resolvedAgentId ? [resolvedAgentId] : [])])]
  const skill = route.payload.skillRef && typeof route.payload.skillRef === 'object' ? route.payload.skillRef as Payload : undefined
  const attachmentRefs = Array.isArray(route.payload.attachmentRefs) ? route.payload.attachmentRefs : []
  const byId = new Map(agents.map((agent) => [agent.agentId, agent]))
  const refById = new Map(refs.map((ref) => [stringValue(ref.id), ref]))
  return {
    taskId: stringValue(route.payload.collaborationTaskId) ?? event.id,
    title: `协同任务 · ${stringValue(skill?.name) ?? '主 Agent 分发'}`,
    skillName: stringValue(skill?.name),
    routingMode: (stringValue(routing.mode) as CollaborationTaskPanelState['routingMode'] | undefined) ?? 'main',
    routingReason: stringValue(routing.reason),
    resolvedAgentId,
    attachmentCount: attachmentRefs.length,
    status: 'running',
    agents: ids.map((agentId) => {
      const card = byId.get(agentId)
      const ref = refById.get(agentId)
      return {
        agentId,
        name: stringValue(ref?.name) ?? card?.name ?? agentId,
        role: card?.role ?? '',
        status: 'pending',
        progress: 0,
        outputs: []
      }
    }),
    summaries: []
  }
}

function panelStatus(panel: CollaborationTaskPanelState) {
  if (panel.agents.some((agent) => agent.status === 'failed')) return 'failed'
  if (panel.agents.length && panel.agents.every((agent) => agent.status === 'cancelled')) return 'cancelled'
  if (panel.agents.length && panel.agents.every((agent) => ['completed', 'failed', 'cancelled'].includes(agent.status))) return 'completed'
  return 'running'
}

/**
 * Folds the durable event stream into stable panels. Event IDs make stage output
 * idempotent; status strength prevents a late/duplicate event from regressing a
 * terminal Agent state. The function is pure so refresh and SSE replay converge.
 */
export function buildCollaborationTaskPanels(events: CollaborationEvent[], agents: AgentCardState[] = []) {
  const ordered = [...events]
    .filter((event, index, all) => all.findIndex((candidate) => candidate.id === event.id) === index)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id))
  const panels: CollaborationTaskPanelState[] = []
  const taskPanels = new Map<string, CollaborationTaskPanelState>()

  for (const event of ordered) {
    const routePanel = panelFromRoute(event, agents)
    if (routePanel) {
      panels.push(routePanel)
      taskPanels.set(routePanel.taskId, routePanel)
      continue
    }
    const payload = payloadOf(event)
    const explicitTaskId = stringValue(payload.taskId) ?? event.taskId
    const target = (explicitTaskId ? taskPanels.get(explicitTaskId) : undefined) ?? panels.at(-1)
    if (!target) continue
    const summaryKind = stringValue(payload.summaryKind)
    if (event.type === 'agent_message' && (summaryKind === 'temporary_cancelled' || summaryKind === 'manual_resummary')) {
      const version = typeof payload.summaryVersion === 'number' ? payload.summaryVersion : target.summaries.length + 1
      if (!target.summaries.some((summary) => summary.id === event.id)) {
        target.summaries.push({
          id: event.id,
          version,
          kind: summaryKind,
          content: event.content,
          sourceEventIds: Array.isArray(payload.sourceEventIds)
            ? payload.sourceEventIds.filter((id): id is string => typeof id === 'string')
            : []
        })
      }
      target.status = panelStatus(target)
      continue
    }
    const eventAgentId = agentIdOf(event, payload)
    const affectedIds = eventAgentId ? [eventAgentId] : event.toAgentIds
    for (const agentId of affectedIds) {
      let agent = target.agents.find((candidate) => candidate.agentId === agentId)
      if (!agent) {
        const card = agents.find((candidate) => candidate.agentId === agentId)
        agent = { agentId, name: card?.name ?? agentId, role: card?.role ?? '', status: 'pending', progress: 0, outputs: [] }
        target.agents.push(agent)
      }
      const nextStatus = statusOf(event, payload)
      const previousStatus = agent.status
      if (nextStatus && statusRank[nextStatus] >= statusRank[previousStatus]) {
        agent.status = nextStatus
        agent.progress = progressOf(nextStatus)
      }
      if (
        (event.type !== 'agent_message' || !routePayload(event)) &&
        (!nextStatus || statusRank[nextStatus] >= statusRank[previousStatus])
      ) addOutput(agent, event)
    }
    target.status = panelStatus(target)
  }
  return panels.map((panel) => ({ ...panel, status: panelStatus(panel) }))
}
