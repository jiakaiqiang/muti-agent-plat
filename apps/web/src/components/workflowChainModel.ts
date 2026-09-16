import type { ActorRef, AgentCardState, CollaborationEvent, TaskViewState } from '@/types/contracts'

/** Execution state of one Agent in the workflow chain. Mutually exclusive by construction. */
export type WorkflowChainState = 'done' | 'active' | 'pending'

export type WorkflowChainNodeOutput = {
  currentTaskTitle?: string
  actionSummary?: string
  thoughtSummary?: string
  recentLogs: string[]
  capabilityNames: string[]
  artifactIds: string[]
}

export type WorkflowChainNode = {
  agentId: string
  name: string
  role: string
  kind: 'system' | 'agent'
  state: WorkflowChainState
  output: WorkflowChainNodeOutput
}

export type WorkflowChainEdgeInput = {
  id: string
  fromAgentId: string
  toAgentId: string
  phase?: string
  kind?: string
}

export type WorkflowChainEdge = WorkflowChainEdgeInput & {
  pulsing: boolean
}

export type WorkflowDiscussionMessage = {
  eventId: string
  agentId?: string
  agentName: string
  content: string
  createdAt: string
}

export type WorkflowDiscussionRound = {
  round: number
  messages: WorkflowDiscussionMessage[]
}

export type BuildWorkflowChainInput = {
  events: CollaborationEvent[]
  tasks: TaskViewState[]
  agents: AgentCardState[]
  /** Resolves an Agent id to a display name. Returns '' when unknown. */
  resolveName: (agentId: string) => string
  systemAgentIds: string[]
}

const ACTIVE_CARD_STATUSES = new Set<AgentCardState['status']>([
  'running',
  'thinking',
  'discussing',
  'reviewing',
  'reworking',
  'failed'
])

const COMPLETION_EVENT_TYPES = new Set<CollaborationEvent['type']>([
  'task_completed',
  'runtime_completed',
  'post_review_completed'
])

const REACTIVATION_EVENT_TYPES = new Set<CollaborationEvent['type']>([
  'task_assigned',
  'task_accepted',
  'task_claimed',
  'task_reassigned',
  'task_started',
  'task_reworked',
  'task_blocked',
  'task_waiting',
  'runtime_started',
  'post_review_started'
])

const UNFINISHED_TASK_STATUSES = new Set<TaskViewState['status']>([
  'pending',
  'assigned',
  'accepted',
  'claimed',
  'running',
  'waiting',
  'blocked'
])

const DISCUSSION_PHASES = new Set(['discussion', 'follow_up_discussion'])

const UNKNOWN_AGENT_NAME = '未知 Agent'

function agentIdOf(actor: ActorRef | undefined) {
  return actor?.type === 'agent' ? actor.id : undefined
}

function payloadOf(event: CollaborationEvent) {
  return (event.metadata.payload ?? {}) as {
    round?: number
    phase?: string
    agentId?: string
    assignee?: ActorRef
  }
}

function displayName(agentId: string, card: AgentCardState | undefined, resolveName: (agentId: string) => string) {
  // resolveName reads the Agent catalog, which also covers system Agents that have
  // no card. The card name is a per-session snapshot, so it only serves as backup.
  return resolveName(agentId) || card?.name || UNKNOWN_AGENT_NAME
}

/**
 * Derives the execution state from the Agent's own event history plus its card.
 *
 * Priority is fixed: a completion that nothing reopened wins, then any active
 * signal, then pending. Exactly one branch returns, so the three states cannot
 * overlap on a node.
 */
function deriveState(
  agentId: string,
  card: AgentCardState | undefined,
  ownEvents: CollaborationEvent[],
  tasks: TaskViewState[]
): WorkflowChainState {
  if (!ownEvents.length) return 'pending'

  const lastCompletionAt = ownEvents
    .filter((event) => COMPLETION_EVENT_TYPES.has(event.type))
    .map((event) => event.createdAt)
    .sort()
    .at(-1)

  if (lastCompletionAt) {
    const reopenedLater = ownEvents.some(
      (event) => REACTIVATION_EVENT_TYPES.has(event.type) && event.createdAt > lastCompletionAt
    )
    if (!reopenedLater) return 'done'
    return 'active'
  }

  if (card && ACTIVE_CARD_STATUSES.has(card.status)) return 'active'

  const holdsUnfinishedTask = tasks.some(
    (task) => agentIdOf(task.assignee) === agentId && UNFINISHED_TASK_STATUSES.has(task.status)
  )
  if (holdsUnfinishedTask) return 'active'

  // An Agent collected only from events has no card to read a status from. If it
  // started work and never completed any, it is still active.
  if (ownEvents.some((event) => REACTIVATION_EVENT_TYPES.has(event.type))) return 'active'

  return 'pending'
}

/**
 * Builds the ordered Agent chain for the workflow canvas.
 *
 * Agents are collected from both the card list and the event actors, so an Agent
 * that only ever appears as an event actor still gets a node. This is deliberate:
 * system Agents are management-surface only and never reach participatingAgentIds,
 * so they have no AgentCardState. Collecting here keeps agentCards() untouched and
 * leaves the group-chat panel that shares it unaffected.
 */
export function buildWorkflowChain(input: BuildWorkflowChainInput): WorkflowChainNode[] {
  const { events, tasks, agents, resolveName, systemAgentIds } = input
  const systemIds = new Set(systemAgentIds)
  const cardById = new Map(agents.map((card) => [card.agentId, card]))

  const eventsByAgentId = new Map<string, CollaborationEvent[]>()
  for (const event of events) {
    const payload = payloadOf(event)
    const agentId = agentIdOf(event.actor) ?? agentIdOf(payload.assignee) ?? payload.agentId
    if (!agentId) continue
    const existing = eventsByAgentId.get(agentId)
    if (existing) existing.push(event)
    else eventsByAgentId.set(agentId, [event])
  }

  const orderedIds: string[] = []
  const seen = new Set<string>()
  const push = (agentId: string) => {
    if (seen.has(agentId)) return
    seen.add(agentId)
    orderedIds.push(agentId)
  }

  // Chain head: system Agents that actually acted in this session.
  for (const systemId of systemAgentIds) {
    if (eventsByAgentId.has(systemId)) push(systemId)
  }
  for (const card of agents) {
    if (systemIds.has(card.agentId)) continue
    if (card.status === 'disabled') continue
    push(card.agentId)
  }
  for (const agentId of eventsByAgentId.keys()) {
    if (systemIds.has(agentId)) continue
    push(agentId)
  }

  return orderedIds.map((agentId) => {
    const card = cardById.get(agentId)
    const ownEvents = eventsByAgentId.get(agentId) ?? []
    return {
      agentId,
      name: displayName(agentId, card, resolveName),
      role: card?.role ?? '',
      kind: systemIds.has(agentId) ? 'system' : 'agent',
      state: deriveState(agentId, card, ownEvents, tasks),
      output: {
        currentTaskTitle: card?.currentTaskTitle,
        actionSummary: card?.actionSummary,
        thoughtSummary: card?.thoughtSummary,
        recentLogs: [...(card?.recentLogs ?? [])],
        capabilityNames: [...(card?.activeCapabilityNames ?? [])],
        artifactIds: [...(card?.artifactIds ?? [])]
      }
    }
  })
}

/**
 * Marks which edges carry a live handoff.
 *
 * Pulse requires a finished upstream feeding a working downstream. `fallback`
 * edges are excluded because they are layout-only links added to keep otherwise
 * unconnected nodes attached to the canvas; animating them would show flow where
 * no event ever passed.
 */
export function workflowChainEdges(
  chain: WorkflowChainNode[],
  edges: WorkflowChainEdgeInput[]
): WorkflowChainEdge[] {
  const stateById = new Map(chain.map((node) => [node.agentId, node.state]))
  return edges
    .filter((edge) => stateById.has(edge.fromAgentId) && stateById.has(edge.toAgentId))
    .map((edge) => ({
      ...edge,
      pulsing:
        edge.kind !== 'fallback' &&
        stateById.get(edge.fromAgentId) === 'done' &&
        stateById.get(edge.toAgentId) === 'active'
    }))
}

/**
 * Groups discussion messages into rounds.
 *
 * `round` is the primary key rather than `phase`: the orchestrator emits
 * discussion agent_message with round/messageKind/mentionedAgentIds but no phase,
 * so a phase-only filter drops every discussion message.
 */
export function discussionRounds(
  events: CollaborationEvent[],
  resolveName: (agentId: string) => string
): WorkflowDiscussionRound[] {
  const byRound = new Map<number, WorkflowDiscussionMessage[]>()

  for (const event of events) {
    if (event.type !== 'agent_message') continue
    const payload = payloadOf(event)
    const hasRound = typeof payload.round === 'number'
    const isDiscussionPhase = DISCUSSION_PHASES.has(payload.phase ?? '')
    if (!hasRound && !isDiscussionPhase) continue

    const agentId = agentIdOf(event.actor)
    const round = hasRound ? payload.round! : 1
    const message: WorkflowDiscussionMessage = {
      eventId: event.id,
      agentId,
      agentName: (agentId ? resolveName(agentId) : '') || UNKNOWN_AGENT_NAME,
      content: event.content,
      createdAt: event.createdAt
    }
    const existing = byRound.get(round)
    if (existing) existing.push(message)
    else byRound.set(round, [message])
  }

  return [...byRound.entries()]
    .sort(([left], [right]) => left - right)
    .map(([round, messages]) => ({
      round,
      messages: [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    }))
}
