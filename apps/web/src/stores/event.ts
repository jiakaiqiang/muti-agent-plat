import { defineStore } from 'pinia'
import { apiPage, eventStreamUrl, parseSseEvent } from '@/api/client'
import { useAgentStore } from '@/stores/agent'
import { useKnowledgeStore } from '@/stores/knowledge'
import type {
  AgentCardState,
  AgentStatusChangedPayload,
  BriefEventPayload,
  ChatMessage,
  CollaborationEvent,
  ConfirmationCardState,
  ConfirmationRequestedPayload,
  RagRetrievedPayload,
  TaskEventPayload,
  TaskViewState
} from '@/types/contracts'

const eventTypeToMessageType: Partial<Record<CollaborationEvent['type'], ChatMessage['messageType']>> = {
  user_message: 'text',
  agent_message: 'text',
  brief_created: 'brief',
  brief_updated: 'brief',
  user_confirmation_requested: 'confirmation',
  task_created: 'task',
  task_claimed: 'task',
  task_started: 'task',
  task_waiting: 'task',
  task_completed: 'task',
  task_rejected: 'task',
  task_reworked: 'task',
  runtime_started: 'tool',
  runtime_progress: 'tool',
  runtime_completed: 'tool',
  runtime_failed: 'tool',
  tool_called: 'tool',
  tool_completed: 'tool',
  tool_failed: 'tool',
  rag_retrieved: 'rag',
  artifact_created: 'artifact',
  post_review_completed: 'review',
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
  return eventTypeToMessageType[event.type] !== undefined || event.metadata.renderAs === 'system_notice'
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

export const useEventStore = defineStore('event', {
  state: () => ({
    eventsBySessionId: {} as Record<string, CollaborationEvent[]>,
    connectedSessionId: undefined as string | undefined,
    sseConnected: false,
    lastEventIdBySessionId: {} as Record<string, string>
  }),
  getters: {
    eventsForSession: (state) => (sessionId: string) => state.eventsBySessionId[sessionId] ?? [],
    // 最新一版任务简报内容(brief_created / brief_updated),供「修改简报」时展示当前简报作为参考。
    currentBrief: (state) => (sessionId: string): BriefEventPayload | undefined => {
      const events = state.eventsBySessionId[sessionId] ?? []
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (event.type === 'brief_created' || event.type === 'brief_updated') {
          return event.metadata.payload as BriefEventPayload
        }
      }
      return undefined
    },
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
    agentCards: (state) => (sessionId: string): AgentCardState[] => {
      const agentStore = useAgentStore()
      const knowledgeStore = useKnowledgeStore()
      const cards = new Map<string, AgentCardState>()

      agentStore.agents.forEach((agent) => {
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
      for (const event of state.eventsBySessionId[sessionId] ?? []) {
        if (!event.type.startsWith('task_')) continue
        const payload = payloadOf<TaskEventPayload>(event)
        const taskId = payload.taskId ?? event.taskId
        if (!taskId) continue
        tasks.set(taskId, {
          taskId,
          title: payload.title,
          status: payload.status,
          assigneeAgentId: payload.assigneeAgentId,
          dependsOnTaskIds: payload.dependsOnTaskIds ?? [],
          acceptanceCriteria: payload.acceptanceCriteria ?? [],
          resultSummary: payload.resultSummary
        })
      }
      return [...tasks.values()]
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
            relatedBriefId: payload.relatedBriefId as string | undefined,
            relatedTaskId: (payload.relatedTaskId ?? payload.taskId) as string | undefined,
            relatedCapabilityId: payload.relatedCapabilityId as string | undefined,
            relatedArtifactId: payload.relatedArtifactId as string | undefined,
            taskTitle: payload.taskTitle as string | undefined,
            writes: payload.writes
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
      }
    },
    appendEvent(event: CollaborationEvent) {
      const events = this.eventsBySessionId[event.sessionId] ?? []
      if (events.some((item) => item.id === event.id)) return
      this.eventsBySessionId[event.sessionId] = [...events, event]
      this.lastEventIdBySessionId[event.sessionId] = event.id
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
