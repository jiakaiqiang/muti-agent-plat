import { defineStore } from 'pinia'
import { apiPage, eventStreamUrl, parseSseEvent } from '@/api/client'
import { useAgentStore } from '@/stores/agent'
import { useKnowledgeStore } from '@/stores/knowledge'
import { useLocalWorkspaceStore } from '@/stores/localWorkspace'
import type {
  AgentCardState,
  ArtifactEventPayload,
  AgentStatusChangedPayload,
  ChatMessage,
  CollaborationEvent,
  ConfirmationCardState,
  ConfirmationRequestedPayload,
  RagRetrievedPayload,
  RuntimeEventPayload,
  TaskEventPayload,
  TaskViewState
} from '@/types/contracts'

const eventTypeToMessageType: Partial<Record<CollaborationEvent['type'], ChatMessage['messageType']>> = {
  user_message: 'text',
  agent_message: 'text',
  brief_created: 'brief',
  brief_updated: 'brief',
  user_confirmation_requested: 'confirmation',
  artifact_created: 'artifact',
  final_delivery_created: 'delivery',
  error_reported: 'error'
}

function payloadOf<T>(event: CollaborationEvent): T {
  return (event.metadata.payload ?? {}) as T
}

function senderTypeOf(event: CollaborationEvent): ChatMessage['senderType'] {
  if (event.type === 'user_message') return 'user'
  if (event.fromAgentId) return 'agent'
  return 'system'
}

function shouldRenderInTimeline(event: CollaborationEvent) {
  if (event.type === 'agent_message') {
    const payload = payloadOf<{ internal?: boolean }>(event)
    return !payload.internal
  }
  return eventTypeToMessageType[event.type] !== undefined
}

function discussionProgress(events: CollaborationEvent[]) {
  const discussingAgents = new Set<string>()
  let messageCount = 0
  let maxRound = 0
  for (const event of events) {
    if (event.type === 'agent_message') {
      const payload = payloadOf<{ round?: number }>(event)
      if (payload.round) {
        if (event.fromAgentId) discussingAgents.add(event.fromAgentId)
        messageCount++
        if (payload.round > maxRound) maxRound = payload.round
      }
    }
  }
  return { agentCount: discussingAgents.size, messageCount, currentRound: maxRound }
}

function artifactPayload(event: CollaborationEvent): ArtifactEventPayload | undefined {
  if (event.type !== 'artifact_created') return undefined
  return event.metadata.payload as ArtifactEventPayload | undefined
}

function confirmationStatuses(events: CollaborationEvent[]) {
  const statuses = new Map<string, ConfirmationCardState['status']>()
  const confirmationIdByBriefId = new Map<string, string>()

  for (const event of events) {
    if (event.type === 'user_confirmation_requested') {
      const payload = payloadOf<ConfirmationRequestedPayload & Record<string, unknown>>(event)
      statuses.set(payload.confirmationId, 'pending')
      if (payload.relatedBriefId) {
        confirmationIdByBriefId.set(String(payload.relatedBriefId), payload.confirmationId)
      }
    }

    if (event.type === 'user_confirmation_resolved') {
      const payload = payloadOf<{ confirmationId?: string; status?: ConfirmationCardState['status'] }>(event)
      if (payload.confirmationId) {
        statuses.set(payload.confirmationId, payload.status ?? 'approved')
      }
    }

    if (event.type === 'brief_confirmed') {
      const payload = payloadOf<{ briefId?: string }>(event)
      const confirmationId = payload.briefId ? confirmationIdByBriefId.get(payload.briefId) : undefined
      if (confirmationId) {
        statuses.set(confirmationId, 'approved')
      }
    }
  }

  return statuses
}

const streams = new Map<string, EventSource>()

const agentStatusStrength: Partial<Record<AgentCardState['status'], number>> = {
  idle: 0,
  discussing: 1,
  thinking: 2,
  waiting: 3,
  reviewing: 4,
  reworking: 5,
  running: 6,
  completed: 7,
  failed: 8,
  disabled: 9
}

function derivedAgentId(event: CollaborationEvent) {
  const payload = payloadOf<{ assigneeAgentId?: string; agentId?: string }>(event)
  return payload.assigneeAgentId ?? payload.agentId ?? event.fromAgentId
}

function statusFromEvent(event: CollaborationEvent): AgentCardState['status'] | undefined {
  const payload = payloadOf<TaskEventPayload | RuntimeEventPayload>(event)
  if (event.type === 'task_started' || event.type === 'runtime_started') return 'running'
  if (event.type === 'task_waiting') return 'waiting'
  if (event.type === 'task_reworked') return 'reworking'
  if (event.type === 'post_review_started') return 'reviewing'
  if (event.type === 'task_completed' || event.type === 'runtime_completed' || event.type === 'post_review_completed') {
    return 'completed'
  }
  if (event.type === 'task_rejected' || event.type === 'runtime_failed') return 'failed'
  if (event.type === 'agent_message') return 'discussing'
  if (payload.status === 'failed') return 'failed'
  if (payload.status === 'completed') return 'completed'
  if (payload.status === 'running') return 'running'
  if (payload.status === 'waiting') return 'waiting'
  return undefined
}

function shouldApplyDerivedStatus(current: AgentCardState, nextStatus: AgentCardState['status']) {
  if (current.status === nextStatus) return true
  if (nextStatus === 'discussing') {
    return (agentStatusStrength[current.status] ?? 0) <= (agentStatusStrength.discussing ?? 1)
  }
  if (current.status === 'disabled') return false
  if (nextStatus === 'failed' || nextStatus === 'completed') return true
  return current.status !== 'failed'
}

export const useEventStore = defineStore('event', {
  state: () => ({
    eventsBySessionId: {} as Record<string, CollaborationEvent[]>,
    connectedSessionId: undefined as string | undefined,
    sseConnected: false,
    lastEventIdBySessionId: {} as Record<string, string>
  }),
  getters: {
    eventsForSession: (state) => (sessionId: string) => state.eventsBySessionId[sessionId] ?? [],
    discussionProgress: (state) => (sessionId: string) => discussionProgress(state.eventsBySessionId[sessionId] ?? []),
    chatMessages: (state) => (sessionId: string): ChatMessage[] => {
      const events = state.eventsBySessionId[sessionId] ?? []
      const confirmationStatusById = confirmationStatuses(events)
      return events.filter(shouldRenderInTimeline).map((event) => {
        const payload = event.metadata.payload ?? {}
        const confirmationId =
          event.type === 'user_confirmation_requested'
            ? (payload as ConfirmationRequestedPayload).confirmationId
            : undefined
        return {
          id: `msg-${event.id}`,
          sessionId: event.sessionId,
          senderType: senderTypeOf(event),
          senderAgentId: event.fromAgentId,
          toAgentIds: event.toAgentIds,
          messageType: eventTypeToMessageType[event.type] ?? 'text',
          content: event.content,
          createdAt: event.createdAt,
          rawEventId: event.id,
          payload: confirmationId
            ? { ...payload, status: confirmationStatusById.get(confirmationId) ?? 'pending' }
            : payload
        }
      })
    },
    agentCards: (state) => (sessionId: string, participantAgentIds?: string[]): AgentCardState[] => {
      const agentStore = useAgentStore()
      const knowledgeStore = useKnowledgeStore()
      const cards = new Map<string, AgentCardState>()
      const participantIds = participantAgentIds?.length ? new Set(participantAgentIds) : undefined

      agentStore.agents.filter((agent) => !participantIds || participantIds.has(agent.id)).forEach((agent) => {
        cards.set(agent.id, {
          agentId: agent.id,
          name: agent.name,
          role: agent.role,
          status: agent.status === 'active' ? 'idle' : 'disabled',
          recentLogs: [],
          waitingFor: [],
          activeCapabilityNames: [],
          usedRagSnippets: [],
          artifactIds: [],
          updatedAt: agent.updatedAt
        })
      })

      for (const event of state.eventsBySessionId[sessionId] ?? []) {
        if (event.type === 'agent_status_changed') {
          const payload = payloadOf<AgentStatusChangedPayload>(event)
          const current = cards.get(payload.agentId)
          if (current) {
            cards.set(payload.agentId, {
              ...current,
              status: payload.status,
              currentTaskId: payload.currentTaskId,
              currentTaskTitle: payload.currentTaskTitle,
              thoughtSummary: payload.thoughtSummary,
              actionSummary: payload.actionSummary,
              waitingFor: payload.waitingFor ?? [],
              activeCapabilityNames: (payload.activeCapabilityIds ?? []).map(agentStore.capabilityName),
              recentLogs: [event.content, ...current.recentLogs].slice(0, 4),
              updatedAt: event.createdAt
            })
          }
        }

        if (event.type === 'rag_retrieved') {
          const payload = payloadOf<RagRetrievedPayload>(event)
          const current = cards.get(payload.agentId)
          if (current) {
            const snippets = payload.matchedChunks.map((chunk) => ({
              title: `${chunk.title} / ${knowledgeStore.knowledgeBaseName(chunk.knowledgeBaseId)}`,
              snippet: chunk.snippet,
              score: chunk.score
            }))
            cards.set(payload.agentId, {
              ...current,
              usedRagSnippets: [...snippets, ...current.usedRagSnippets].slice(0, 3),
              recentLogs: [event.content, ...current.recentLogs].slice(0, 4),
              updatedAt: event.createdAt
            })
          }
        }

        const nextStatus = statusFromEvent(event)
        const agentId = derivedAgentId(event)
        if (agentId && nextStatus) {
          const current = cards.get(agentId)
          if (current && shouldApplyDerivedStatus(current, nextStatus)) {
            const payload = payloadOf<TaskEventPayload | RuntimeEventPayload>(event)
            cards.set(agentId, {
              ...current,
              status: nextStatus,
              currentTaskId: payload.taskId ?? event.taskId ?? current.currentTaskId,
              currentTaskTitle: 'title' in payload && payload.title ? payload.title : current.currentTaskTitle,
              actionSummary: 'progressMessage' in payload ? payload.progressMessage ?? current.actionSummary : current.actionSummary,
              recentLogs: [event.content, ...current.recentLogs].slice(0, 4),
              updatedAt: event.createdAt
            })
          }
        }

        if (event.type === 'artifact_created') {
          const payload = artifactPayload(event)
          const agentId = event.fromAgentId
          if (payload && agentId) {
            const current = cards.get(agentId)
            if (!current) continue
            cards.set(agentId, {
              ...current,
              artifactIds: [payload.artifactId, ...current.artifactIds].slice(0, 6),
              recentLogs: [event.content, ...current.recentLogs].slice(0, 4),
              updatedAt: event.createdAt
            })
          }
        }

        if (event.fromAgentId && event.type !== 'agent_status_changed') {
          const current = cards.get(event.fromAgentId)
          if (current) {
            cards.set(event.fromAgentId, {
              ...current,
              recentLogs: [event.content, ...current.recentLogs].slice(0, 4),
              updatedAt: event.createdAt
            })
          }
        }
      }

      return [...cards.values()]
    },
    taskStates: (state) => (sessionId: string): TaskViewState[] => {
      const tasks = new Map<string, TaskViewState>()
      const artifactsByTaskId = new Map<string, TaskViewState['artifacts']>()
      for (const event of state.eventsBySessionId[sessionId] ?? []) {
        if (event.type === 'artifact_created') {
          const taskId = event.taskId
          const payload = artifactPayload(event)
          if (taskId && payload) {
            const artifacts = artifactsByTaskId.get(taskId) ?? []
            artifactsByTaskId.set(taskId, [
              ...artifacts,
              {
                artifactId: payload.artifactId,
                type: payload.type,
                title: payload.title,
                contentSummary: payload.contentSummary,
                fileChangeCount: payload.fileChanges?.length ?? 0
              }
            ])
          }
        }

        if (!event.type.startsWith('task_')) continue
        const payload = payloadOf<TaskEventPayload>(event)
        const taskId = payload.taskId ?? event.taskId
        if (!taskId) continue
        const current = tasks.get(taskId)
        tasks.set(taskId, {
          taskId,
          title: payload.title ?? current?.title ?? taskId,
          status: payload.status,
          assigneeAgentId: payload.assigneeAgentId ?? current?.assigneeAgentId,
          dependsOnTaskIds: payload.dependsOnTaskIds ?? current?.dependsOnTaskIds ?? [],
          acceptanceCriteria: payload.acceptanceCriteria ?? current?.acceptanceCriteria ?? [],
          resultSummary: payload.resultSummary ?? current?.resultSummary,
          artifacts: artifactsByTaskId.get(taskId) ?? current?.artifacts ?? []
        })
      }
      return [...tasks.values()].map((task) => ({
        ...task,
        artifacts: artifactsByTaskId.get(task.taskId) ?? task.artifacts
      }))
    },
    activeConfirmation: (state) => (sessionId: string): ConfirmationCardState | undefined => {
      let card: ConfirmationCardState | undefined
      for (const event of state.eventsBySessionId[sessionId] ?? []) {
        if (event.type === 'user_confirmation_requested') {
          const payload = payloadOf<ConfirmationRequestedPayload & Record<string, unknown>>(event)
          card = {
            confirmationId: payload.confirmationId,
            reason: payload.reason,
            title: payload.title,
            description: payload.description,
            status: 'pending',
            options: payload.options,
            candidate: payload.candidate,
            relatedBriefId: payload.relatedBriefId as string | undefined,
            relatedTaskId: payload.relatedTaskId as string | undefined,
            relatedCapabilityId: payload.relatedCapabilityId as string | undefined,
            relatedArtifactId: payload.relatedArtifactId as string | undefined
          }
        }
        if (event.type === 'user_confirmation_resolved' && card) {
          const payload = payloadOf<{ confirmationId?: string; status?: ConfirmationCardState['status'] }>(event)
          if (payload.confirmationId === card.confirmationId) {
            card = { ...card, status: payload.status ?? 'approved' }
          }
        }
        if (event.type === 'brief_confirmed' && card?.relatedBriefId) {
          const payload = payloadOf<{ briefId?: string }>(event)
          if (payload.briefId === card.relatedBriefId) {
            card = { ...card, status: 'approved' }
          }
        }
      }
      return card?.status === 'pending' ? card : undefined
    }
  },
  actions: {
    async loadEvents(sessionId: string, options: { append?: boolean; afterEventId?: string } = {}) {
      const afterEventId = options.afterEventId ?? (options.append ? this.lastEventIdBySessionId[sessionId] : undefined)
      const suffix = afterEventId ? `?afterEventId=${encodeURIComponent(afterEventId)}` : ''
      const page = await apiPage<CollaborationEvent>(`/sessions/${sessionId}/events${suffix}`)
      if (options.append) {
        page.items.forEach((event) => this.appendEvent(event))
      } else {
        this.eventsBySessionId[sessionId] = page.items
        this.lastEventIdBySessionId[sessionId] = page.items.at(-1)?.id ?? ''
        page.items.forEach((event) => {
          void this.applyLocalFileChanges(event)
        })
      }
    },
    appendEvent(event: CollaborationEvent) {
      const events = this.eventsBySessionId[event.sessionId] ?? []
      if (events.some((item) => item.id === event.id)) return
      this.eventsBySessionId[event.sessionId] = [...events, event]
      this.lastEventIdBySessionId[event.sessionId] = event.id
      void this.applyLocalFileChanges(event)
    },
    async applyLocalFileChanges(event: CollaborationEvent) {
      const payload = artifactPayload(event)
      if (!payload?.fileChanges?.length) return
      const localWorkspaceStore = useLocalWorkspaceStore()
      localWorkspaceStore.enqueueArtifactFileChanges(
        event.sessionId,
        payload.artifactId,
        payload.fileChanges,
        payload.title
      )
    },
    async replayLocalFileChanges(sessionId: string) {
      for (const event of this.eventsBySessionId[sessionId] ?? []) {
        await this.applyLocalFileChanges(event)
      }
    },
    connectSse(sessionId: string) {
      this.disconnectSse()
      this.connectedSessionId = sessionId
      const stream = new EventSource(eventStreamUrl(sessionId))
      streams.set(sessionId, stream)
      stream.onopen = () => {
        this.sseConnected = true
        void this.loadEvents(sessionId, { append: true })
      }
      stream.onerror = () => {
        this.sseConnected = false
      }
      stream.addEventListener('collaboration-event', (message) => {
        this.appendEvent(parseSseEvent(message as MessageEvent))
      })
    },
    disconnectSse() {
      if (this.connectedSessionId) {
        streams.get(this.connectedSessionId)?.close()
        streams.delete(this.connectedSessionId)
      }
      this.connectedSessionId = undefined
      this.sseConnected = false
    }
  }
})
