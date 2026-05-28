import { defineStore } from 'pinia'
import { useAgentStore } from '@/stores/agent'
import { useKnowledgeStore } from '@/stores/knowledge'
import { mockEvents } from '@/mock/mockEvents'
import type {
  AgentCardState,
  AgentStatusChangedPayload,
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

export const useEventStore = defineStore('event', {
  state: () => ({
    eventsBySessionId: {} as Record<string, CollaborationEvent[]>,
    connectedSessionId: undefined as string | undefined,
    sseConnected: false,
    lastEventIdBySessionId: {} as Record<string, string>
  }),
  getters: {
    eventsForSession: (state) => (sessionId: string) => state.eventsBySessionId[sessionId] ?? [],
    chatMessages: (state) => (sessionId: string): ChatMessage[] =>
      (state.eventsBySessionId[sessionId] ?? []).filter(shouldRenderInTimeline).map((event) => ({
        id: `msg-${event.id}`,
        sessionId: event.sessionId,
        senderType: senderTypeOf(event),
        senderAgentId: event.fromAgentId,
        toAgentIds: event.toAgentIds,
        messageType: eventTypeToMessageType[event.type] ?? 'text',
        content: event.content,
        createdAt: event.createdAt,
        rawEventId: event.id,
        payload: event.metadata.payload
      })),
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
            relatedTaskId: payload.relatedTaskId as string | undefined,
            relatedCapabilityId: payload.relatedCapabilityId as string | undefined
          }
        }
        if (event.type === 'user_confirmation_resolved' && card) {
          const payload = payloadOf<{ confirmationId?: string; status?: ConfirmationCardState['status'] }>(event)
          if (payload.confirmationId === card.confirmationId) {
            card = { ...card, status: payload.status ?? 'approved' }
          }
        }
      }
      return card?.status === 'pending' ? card : undefined
    }
  },
  actions: {
    loadMockEvents(sessionId: string) {
      this.eventsBySessionId[sessionId] = mockEvents.filter((event) => event.sessionId === sessionId)
      this.lastEventIdBySessionId[sessionId] = this.eventsBySessionId[sessionId].at(-1)?.id ?? ''
    },
    appendEvent(event: CollaborationEvent) {
      const events = this.eventsBySessionId[event.sessionId] ?? []
      if (events.some((item) => item.id === event.id)) return
      this.eventsBySessionId[event.sessionId] = [...events, event]
      this.lastEventIdBySessionId[event.sessionId] = event.id
    },
    connectSse(sessionId: string) {
      this.connectedSessionId = sessionId
      this.sseConnected = true
    },
    disconnectSse() {
      this.connectedSessionId = undefined
      this.sseConnected = false
    }
  }
})
