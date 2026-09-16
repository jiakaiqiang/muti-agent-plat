import { defineStore } from 'pinia'
import { apiGet, apiPage, eventStreamUrl, parseSseEvent } from '@/api/client'
import { useAgentStore } from '@/stores/agent'
import { useKnowledgeStore } from '@/stores/knowledge'
import { actorAgentId, eventAgentId } from '@/composables/useActor'
import { applicableArtifactFileChanges } from '@/components/artifactFileChangeModel'
import { shouldPublishRuntimeEventToCollaboration } from '@agent-cluster/shared'
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
  task_created: 'task',
  task_assigned: 'task',
  task_accepted: 'task',
  task_claimed: 'task',
  task_blocked: 'task',
  task_reassigned: 'task',
  task_started: 'task',
  task_waiting: 'task',
  task_completed: 'task',
  task_failed: 'task',
  task_rejected: 'task',
  task_reworked: 'task',
  user_confirmation_requested: 'confirmation',
  intent_clarification_required: 'confirmation',
  capability_approval_required: 'confirmation',
  capability_approved: 'text',
  runtime_started: 'task',
  runtime_progress: 'task',
  runtime_completed: 'task',
  runtime_failed: 'error',
  tool_called: 'tool',
  tool_completed: 'tool',
  tool_failed: 'tool',
  rag_retrieved: 'rag',
  artifact_created: 'artifact',
  post_review_started: 'review',
  post_review_completed: 'review',
  final_delivery_created: 'delivery',
  follow_up_queued: 'text',
  work_item_created: 'text',
  work_item_activated: 'text',
  decision_superseded: 'text',
  error_reported: 'error'
}

function payloadOf<T>(event: CollaborationEvent): T {
  return (event.metadata.payload ?? {}) as T
}

const INTERNAL_RUNTIME_METHODS = new Set([
  'thread/started',
  'mcpServer/startupStatus/updated',
  'remoteControl/status/changed'
])

export function normalizeCollaborationEvent(event: CollaborationEvent): CollaborationEvent {
  const unsafeContent = (event as unknown as { content?: unknown }).content
  if (typeof unsafeContent === 'string' && unsafeContent.trim()) return event

  const payload = event.metadata?.payload ?? {}
  const fallback = [payload.message, payload.fullMessage, payload.resultSummary, payload.reason].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  )

  return {
    ...event,
    content: fallback?.trim() || '该事件缺少可展示内容'
  }
}

function messageTypeOf(event: CollaborationEvent): ChatMessage['messageType'] {
  const mapped = eventTypeToMessageType[event.type] ?? 'text'
  if (event.type === 'runtime_failed') {
    const kind = payloadOf<RuntimeEventPayload>(event).termination?.kind
    if (kind && !['phase_timeout', 'runtime_timeout'].includes(kind)) return 'text'
  }
  // runtime_* 进度事件可能携带 system_notice（上下文裁剪、心跳等系统通知），
  // 其 payload 没有任务卡片所需字段，按纯文本渲染。
  if (mapped === 'task' && event.metadata.renderAs === 'system_notice') return 'text'
  return mapped
}

function senderTypeOf(event: CollaborationEvent): ChatMessage['senderType'] {
  if (event.actor) return event.actor.type
  if (event.type === 'user_message') return 'user'
  if (event.fromAgentId) return 'agent'
  return 'system'
}

function senderAgentIdOf(event: CollaborationEvent): string | undefined {
  return eventAgentId(event)
}

export function shouldRenderInTimeline(event: CollaborationEvent) {
  const payload = payloadOf<{
    visibility?: unknown
    code?: unknown
    method?: unknown
    subtype?: unknown
    phase?: unknown
    checkpointId?: unknown
    memoryId?: unknown
  }>(event)
  if (
    event.type === 'artifact_created' &&
    (payload.phase === 'summary_memory_checkpoint' ||
      typeof payload.checkpointId === 'string' && typeof payload.memoryId === 'string')
  ) return false
  const unsafeVisibility = (event as unknown as { visibility?: unknown }).visibility
  if (event.type === 'runtime_failed' && payload.code === 'HUMAN_APPROVAL_REQUIRED') return false
  if (
    (event.type === 'task_rejected' || event.type === 'task_failed') &&
    typeof (payload as { resultSummary?: unknown }).resultSummary === 'string' &&
    (payload as { resultSummary: string }).resultSummary.includes('HUMAN_APPROVAL_REQUIRED')
  ) return false
  if (payload.phase === 'user_message_routing' && event.type.startsWith('runtime_')) return false
  if (payload.code === 'RUNTIME_STOP_STATE_CHANGED') return false
  if (!shouldPublishRuntimeEventToCollaboration({
    type: event.type,
    visibility: unsafeVisibility ?? payload.visibility,
    code: payload.code
  })) return false
  const protocolMethod = typeof payload.method === 'string'
    ? payload.method
    : typeof payload.subtype === 'string'
      ? payload.subtype
      : event.content.trim()
  if (INTERNAL_RUNTIME_METHODS.has(protocolMethod)) return false
  if (event.type === 'agent_message') {
    return !(payload as { internal?: boolean }).internal
  }
  return eventTypeToMessageType[event.type] !== undefined
}

function collapseLegacyStopReceipts(messages: ChatMessage[]): ChatMessage[] {
  const collapsed: ChatMessage[] = []
  for (const message of messages) {
    const payload = message.payload as Record<string, unknown> | undefined
    const code = payload?.code
    const invocationId = payload?.runtimeInvocationId
    const stopState = payload?.stopState
    const previous = collapsed.at(-1)
    const previousPayload = previous?.payload as Record<string, unknown> | undefined
    const sameLegacyReceipt = code === 'RUNTIME_STOP_CONFIRMED' && typeof invocationId === 'string' &&
      previousPayload?.code === code && previousPayload.runtimeInvocationId === invocationId &&
      previousPayload.stopState === stopState
    if (!previous || !sameLegacyReceipt) {
      collapsed.push(message)
      continue
    }
    const priorTimes = Array.isArray(previousPayload.collapsedStopReceiptTimes)
      ? previousPayload.collapsedStopReceiptTimes.map(String)
      : [previous.createdAt]
    collapsed[collapsed.length - 1] = {
      ...previous,
      content: `${previous.content.replace(/（连续重复 \d+ 次）$/, '')}（连续重复 ${priorTimes.length + 1} 次）`,
      payload: {
        ...previousPayload,
        collapsedStopReceiptCount: priorTimes.length + 1,
        collapsedStopReceiptTimes: [...priorTimes, message.createdAt]
      }
    }
  }
  return collapsed
}

function discussionProgress(events: CollaborationEvent[]) {
  const discussingAgents = new Set<string>()
  let messageCount = 0
  let maxRound = 0
  for (const event of events) {
    if (event.type === 'agent_message') {
      const payload = payloadOf<{ round?: number }>(event)
      if (payload.round) {
        const agentId = eventAgentId(event)
        if (agentId) discussingAgents.add(agentId)
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
    if (event.type === 'user_confirmation_requested' || event.type === 'intent_clarification_required') {
      const payload = payloadOf<ConfirmationRequestedPayload & Record<string, unknown>>(event)
      if (!statuses.has(payload.confirmationId)) statuses.set(payload.confirmationId, 'pending')
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
export type SseConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'degraded'

const FAST_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const
const DEGRADED_AFTER_MS = 30_000
const DEGRADED_RETRY_DELAY_MS = 30_000
const SSE_FRAME_TIMEOUT_MS = 45_000

type ConnectionCoordinator = {
  generation: number
  attempt: number
  retryIndex: number
  firstFailureAt?: number
  retryTimer?: ReturnType<typeof setTimeout>
  degradedTimer?: ReturnType<typeof setTimeout>
  frameTimer?: ReturnType<typeof setTimeout>
  backfillAbort?: AbortController
  backfillPromise?: Promise<void>
  recovering: boolean
  bufferedEvents: CollaborationEvent[]
  onlineHandler?: () => void
  visibilityHandler?: () => void
}

const coordinator: ConnectionCoordinator = {
  generation: 0,
  attempt: 0,
  retryIndex: 0,
  recovering: false,
  bufferedEvents: []
}

export function sseRetryDelayMs(retryIndex: number, degraded: boolean, random = Math.random) {
  const base = degraded
    ? DEGRADED_RETRY_DELAY_MS
    : FAST_RETRY_DELAYS_MS[Math.min(retryIndex, FAST_RETRY_DELAYS_MS.length - 1)]
  const jitter = 0.85 + Math.min(1, Math.max(0, random())) * 0.3
  return Math.round(base * jitter)
}

function isOptimisticEvent(event: CollaborationEvent) {
  return event.id.startsWith('evt-local-')
}

function eventPayload(event: CollaborationEvent) {
  return event.metadata?.payload as Record<string, unknown> | undefined
}

function optimisticEventMatches(optimistic: CollaborationEvent, committed: CollaborationEvent) {
  if (optimistic.type !== committed.type) return false
  const optimisticPayload = eventPayload(optimistic)
  const committedPayload = eventPayload(committed)
  const optimisticConfirmationId = optimisticPayload?.confirmationId
  return typeof optimisticConfirmationId === 'string' && optimisticConfirmationId === committedPayload?.confirmationId
}

function mergeUniqueEvents(...groups: CollaborationEvent[][]) {
  const seen = new Set<string>()
  const merged: CollaborationEvent[] = []
  for (const group of groups) {
    for (const rawEvent of group) {
      const event = normalizeCollaborationEvent(rawEvent)
      if (seen.has(event.id)) continue
      seen.add(event.id)
      merged.push(event)
    }
  }
  return merged
}

function visibleEvents(
  serverEvents: Record<string, CollaborationEvent[]>,
  optimisticEvents: Record<string, CollaborationEvent[]>,
  sessionId: string
) {
  return [...(serverEvents[sessionId] ?? []), ...(optimisticEvents[sessionId] ?? [])]
}

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
  const payload = payloadOf<TaskEventPayload & { agentId?: string }>(event)
  return actorAgentId(payload.assignee) ?? payload.agentId ?? eventAgentId(event)
}

function statusFromEvent(event: CollaborationEvent): AgentCardState['status'] | undefined {
  const payload = payloadOf<TaskEventPayload | RuntimeEventPayload>(event)
  if (event.type === 'task_assigned') return 'thinking'
  if (event.type === 'task_accepted' || event.type === 'task_claimed' || event.type === 'task_reassigned') return 'thinking'
  if (event.type === 'task_started' || event.type === 'runtime_started') return 'running'
  if (event.type === 'task_waiting' || event.type === 'task_blocked') return 'waiting'
  if (event.type === 'task_reworked') return 'reworking'
  if (event.type === 'post_review_started') return 'reviewing'
  if (event.type === 'task_completed' || event.type === 'runtime_completed' || event.type === 'post_review_completed') {
    return 'completed'
  }
  if (
    event.type === 'task_rejected' &&
    'resultSummary' in payload &&
    typeof payload.resultSummary === 'string' &&
    payload.resultSummary.includes('HUMAN_APPROVAL_REQUIRED')
  ) return 'waiting'
  if (event.type === 'task_rejected' || event.type === 'task_failed') return 'failed'
  if (event.type === 'runtime_failed') {
    if ('code' in payload && payload.code === 'HUMAN_APPROVAL_REQUIRED') return 'waiting'
    const kind = (payload as RuntimeEventPayload).termination?.kind
    if (kind === 'service_shutdown' || kind === 'maintenance') return 'waiting'
    if (kind === 'superseded') return 'thinking'
    if (kind === 'user_cancelled') return 'idle'
    return 'failed'
  }
  if (event.type === 'agent_message') return 'discussing'
  if (payload.status === 'failed') return 'failed'
  if (payload.status === 'completed') return 'completed'
  if (payload.status === 'running') return 'running'
  if (payload.status === 'waiting' || payload.status === 'blocked') return 'waiting'
  if (payload.status === 'assigned' || payload.status === 'accepted' || payload.status === 'claimed') return 'thinking'
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
    serverEventsBySessionId: {} as Record<string, CollaborationEvent[]>,
    optimisticEventsBySessionId: {} as Record<string, CollaborationEvent[]>,
    connectedSessionId: undefined as string | undefined,
    sseConnected: false,
    sseConnectionState: 'idle' as SseConnectionState,
    lastSseErrorAt: undefined as string | undefined,
    lastCommittedServerEventIdBySessionId: {} as Record<string, string>
  }),
  getters: {
    eventsForSession: (state) => (sessionId: string) => state.eventsBySessionId[sessionId] ?? [],
    discussionProgress: (state) => (sessionId: string) => discussionProgress(state.eventsBySessionId[sessionId] ?? []),
    chatMessages: (state) => (sessionId: string): ChatMessage[] => {
      const events = state.eventsBySessionId[sessionId] ?? []
      const confirmationStatusById = confirmationStatuses(events)
      return collapseLegacyStopReceipts(events.filter(shouldRenderInTimeline).map((event) => {
        const payload = event.metadata.payload ?? {}
        const confirmationId =
          event.type === 'user_confirmation_requested' || event.type === 'intent_clarification_required'
            ? (payload as ConfirmationRequestedPayload).confirmationId
            : undefined
        return {
          id: `msg-${event.id}`,
          sessionId: event.sessionId,
          senderType: senderTypeOf(event),
          senderAgentId: senderAgentIdOf(event),
          toAgentIds: event.toAgentIds,
          messageType: messageTypeOf(event),
          content: event.content,
          createdAt: event.createdAt,
          rawEventId: event.id,
          payload: confirmationId
            ? { ...payload, status: confirmationStatusById.get(confirmationId) ?? 'pending' }
            : payload
        }
      }))
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
          const agentId = eventAgentId(event)
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

        const sourceAgentId = eventAgentId(event)
        if (sourceAgentId && event.type !== 'agent_status_changed') {
          const current = cards.get(sourceAgentId)
          if (current) {
            cards.set(sourceAgentId, {
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
                fileChangeCount: applicableArtifactFileChanges(payload).length
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
          assignedBy: payload.assignedBy ?? current?.assignedBy,
          assignee: payload.assignee ?? current?.assignee,
          routingMode: payload.routingMode ?? current?.routingMode,
          autoResolutionAttempted: payload.autoResolutionAttempted ?? current?.autoResolutionAttempted,
          assignmentReason: payload.assignmentReason ?? current?.assignmentReason,
          contextRequirements: payload.contextRequirements ?? current?.contextRequirements ?? [],
          verificationPlan: payload.verificationPlan ?? current?.verificationPlan ?? [],
          riskNotes: payload.riskNotes ?? current?.riskNotes ?? [],
          requiresUserConfirmation: payload.requiresUserConfirmation ?? current?.requiresUserConfirmation,
          handoffSuggestion: payload.handoffSuggestion ?? current?.handoffSuggestion,
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
      const finalStatuses = confirmationStatuses(state.eventsBySessionId[sessionId] ?? [])
      for (const event of state.eventsBySessionId[sessionId] ?? []) {
        if (event.type === 'user_confirmation_requested' || event.type === 'intent_clarification_required') {
          const payload = payloadOf<ConfirmationRequestedPayload & Record<string, unknown>>(event)
          if (finalStatuses.get(payload.confirmationId) !== 'pending') continue
          card = {
            confirmationId: payload.confirmationId,
            reason: payload.reason,
            title: payload.title,
            description: payload.description,
            status: 'pending',
            options: payload.options,
            actions: payload.actions,
            candidate: payload.candidate,
            relatedBriefId: payload.relatedBriefId as string | undefined,
            relatedTaskId: payload.relatedTaskId as string | undefined,
            relatedCapabilityId: payload.relatedCapabilityId as string | undefined,
            relatedArtifactId: payload.relatedArtifactId as string | undefined,
            targetPath: payload.targetPath as string | undefined,
            revisionId: payload.revisionId as string | undefined,
            filePath: payload.filePath as string | undefined,
            candidateChangeSetId: payload.candidateChangeSetId as string | undefined,
            candidateHash: payload.candidateHash as ConfirmationCardState['candidateHash'],
            chainId: payload.chainId as string | undefined,
            iteration: payload.iteration as number | undefined,
            stateVersion: payload.stateVersion as number | undefined,
            workflowId: payload.workflowId as string | undefined,
            workflowName: payload.workflowName as string | undefined,
            workflowRunId: payload.workflowRunId as string | undefined,
            workflowNodeId: payload.workflowNodeId as string | undefined,
            workflowNodeRunId: payload.workflowNodeRunId as string | undefined,
            candidateAgentIds: payload.candidateAgentIds as string[] | undefined,
            expectedRunRevision: payload.expectedRunRevision as number | undefined,
            workflowStepIndex: payload.workflowStepIndex as number | undefined,
            workflowStepCount: payload.workflowStepCount as number | undefined,
            outputSummary: payload.outputSummary as string | undefined,
            workflowOptions: payload.workflowOptions,
            routingId: payload.routingId as string | undefined,
            followUpMessageId: payload.followUpMessageId as string | undefined,
            reasonCodes: payload.reasonCodes as string[] | undefined
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
    refreshVisibleEvents(sessionId: string) {
      this.eventsBySessionId[sessionId] = visibleEvents(
        this.serverEventsBySessionId,
        this.optimisticEventsBySessionId,
        sessionId
      )
    },
    commitServerEvents(sessionId: string, events: CollaborationEvent[], replace = false) {
      const normalized = events.map(normalizeCollaborationEvent).filter((event) => !isOptimisticEvent(event))
      const nextServerEvents = replace
        ? mergeUniqueEvents(normalized)
        : mergeUniqueEvents(this.serverEventsBySessionId[sessionId] ?? [], normalized)
      this.serverEventsBySessionId[sessionId] = nextServerEvents
      this.lastCommittedServerEventIdBySessionId[sessionId] = nextServerEvents.at(-1)?.id ?? ''

      const optimistic = this.optimisticEventsBySessionId[sessionId] ?? []
      this.optimisticEventsBySessionId[sessionId] = optimistic.filter(
        (candidate) => !normalized.some((committed) => optimisticEventMatches(candidate, committed))
      )
      this.refreshVisibleEvents(sessionId)
    },
    removeEvent(sessionId: string, eventId: string) {
      if (eventId.startsWith('evt-local-')) {
        this.optimisticEventsBySessionId[sessionId] = (this.optimisticEventsBySessionId[sessionId] ?? []).filter(
          (event) => event.id !== eventId
        )
      } else {
        this.serverEventsBySessionId[sessionId] = (this.serverEventsBySessionId[sessionId] ?? []).filter(
          (event) => event.id !== eventId
        )
        this.lastCommittedServerEventIdBySessionId[sessionId] =
          this.serverEventsBySessionId[sessionId].at(-1)?.id ?? ''
      }
      this.refreshVisibleEvents(sessionId)
    },
    async loadEvents(sessionId: string, options: { append?: boolean; afterEventId?: string } = {}) {
      const afterEventId = options.afterEventId ?? (
        options.append ? this.lastCommittedServerEventIdBySessionId[sessionId] : undefined
      )
      const suffix = afterEventId ? `?afterEventId=${encodeURIComponent(afterEventId)}` : ''
      const page = await apiPage<CollaborationEvent>(`/sessions/${sessionId}/events${suffix}`)
      this.commitServerEvents(sessionId, page.items, !options.append)
    },
    appendEvent(event: CollaborationEvent) {
      const normalizedEvent = normalizeCollaborationEvent(event)
      if (isOptimisticEvent(normalizedEvent)) {
        const optimistic = this.optimisticEventsBySessionId[normalizedEvent.sessionId] ?? []
        if (optimistic.some((item) => item.id === normalizedEvent.id)) return
        this.optimisticEventsBySessionId[normalizedEvent.sessionId] = [...optimistic, normalizedEvent]
        this.refreshVisibleEvents(normalizedEvent.sessionId)
        return
      }
      this.commitServerEvents(normalizedEvent.sessionId, [normalizedEvent])
    },
    async reconcileServerEvents(sessionId: string, generation: number, attempt: number) {
      if (coordinator.backfillPromise) {
        const sharedBackfill = coordinator.backfillPromise
        const sharedAbort = coordinator.backfillAbort
        try {
          await sharedBackfill
        } catch (error) {
          // A reconnect can supersede a backfill while another caller is
          // waiting on the same promise. Keep the cancellation local to the
          // stale attempt instead of exposing it to the user action caller.
          if (!sharedAbort?.signal.aborted) throw error
        }
        return
      }
      coordinator.recovering = true
      coordinator.bufferedEvents = []
      const abort = new AbortController()
      coordinator.backfillAbort = abort
      const baseCursor = this.lastCommittedServerEventIdBySessionId[sessionId]
      const suffix = baseCursor ? `?afterEventId=${encodeURIComponent(baseCursor)}` : ''
      const recovery = (async () => {
        const page = await apiPage<CollaborationEvent>(`/sessions/${sessionId}/events${suffix}`, {
          signal: abort.signal
        })
        if (generation !== coordinator.generation || attempt !== coordinator.attempt || abort.signal.aborted) return
        const buffered = coordinator.bufferedEvents
        coordinator.bufferedEvents = []
        this.commitServerEvents(sessionId, [...page.items, ...buffered])
        coordinator.recovering = false
        coordinator.backfillAbort = undefined
      })()
      coordinator.backfillPromise = recovery
      try {
        await recovery
      } catch (error) {
        if (!abort.signal.aborted && generation === coordinator.generation && attempt === coordinator.attempt) {
          throw error
        }
      } finally {
        if (coordinator.backfillPromise === recovery) {
          coordinator.backfillPromise = undefined
          coordinator.recovering = false
          coordinator.backfillAbort = undefined
        }
      }
    },
    scheduleReconnect(sessionId: string, generation: number) {
      if (generation !== coordinator.generation || this.connectedSessionId !== sessionId) return
      const now = Date.now()
      coordinator.firstFailureAt ??= now
      const degraded = now - coordinator.firstFailureAt >= DEGRADED_AFTER_MS
      this.sseConnectionState = degraded ? 'degraded' : 'reconnecting'

      if (!degraded && !coordinator.degradedTimer) {
        const remaining = Math.max(0, DEGRADED_AFTER_MS - (now - coordinator.firstFailureAt))
        coordinator.degradedTimer = setTimeout(() => {
          coordinator.degradedTimer = undefined
          if (
            generation === coordinator.generation &&
            this.connectedSessionId === sessionId &&
            !this.sseConnected
          ) {
            this.sseConnectionState = 'degraded'
          }
        }, remaining)
      }

      if (coordinator.retryTimer) clearTimeout(coordinator.retryTimer)
      const delay = sseRetryDelayMs(coordinator.retryIndex, degraded)
      if (!degraded) coordinator.retryIndex += 1
      coordinator.retryTimer = setTimeout(() => {
        coordinator.retryTimer = undefined
        if (generation === coordinator.generation && this.connectedSessionId === sessionId) {
          this.openSseAttempt(sessionId, generation)
        }
      }, delay)
    },
    openSseAttempt(sessionId: string, generation: number) {
      if (generation !== coordinator.generation || this.connectedSessionId !== sessionId) return
      streams.get(sessionId)?.close()
      coordinator.backfillAbort?.abort()
      coordinator.backfillAbort = undefined
      coordinator.recovering = true
      coordinator.bufferedEvents = []
      const attempt = ++coordinator.attempt
      const stream = new EventSource(eventStreamUrl(sessionId))
      streams.set(sessionId, stream)

      const isCurrent = () => (
        generation === coordinator.generation &&
        attempt === coordinator.attempt &&
        this.connectedSessionId === sessionId &&
        streams.get(sessionId) === stream
      )
      const failAttempt = () => {
        if (!isCurrent()) return
        stream.close()
        streams.delete(sessionId)
        if (coordinator.frameTimer) clearTimeout(coordinator.frameTimer)
        coordinator.frameTimer = undefined
        coordinator.backfillAbort?.abort()
        coordinator.backfillAbort = undefined
        coordinator.backfillPromise = undefined
        coordinator.recovering = false
        coordinator.bufferedEvents = []
        this.sseConnected = false
        this.lastSseErrorAt = new Date().toISOString()
        this.scheduleReconnect(sessionId, generation)
      }

      const markFrameReceived = () => {
        if (!isCurrent()) return
        if (coordinator.frameTimer) clearTimeout(coordinator.frameTimer)
        coordinator.frameTimer = setTimeout(failAttempt, SSE_FRAME_TIMEOUT_MS)
      }

      stream.addEventListener('collaboration-event', (message) => {
        if (!isCurrent()) return
        markFrameReceived()
        const event = parseSseEvent(message as MessageEvent)
        if (coordinator.recovering) coordinator.bufferedEvents.push(event)
        else this.commitServerEvents(sessionId, [event])
      })
      stream.addEventListener('heartbeat', markFrameReceived)
      stream.onopen = () => {
        if (!isCurrent()) return
        markFrameReceived()
        void this.reconcileServerEvents(sessionId, generation, attempt)
          .then(() => {
            if (!isCurrent()) return
            this.sseConnected = true
            this.sseConnectionState = 'connected'
            this.lastSseErrorAt = undefined
            coordinator.firstFailureAt = undefined
            coordinator.retryIndex = 0
            if (coordinator.degradedTimer) clearTimeout(coordinator.degradedTimer)
            coordinator.degradedTimer = undefined
          })
          .catch(failAttempt)
      }
      stream.onerror = failAttempt
      markFrameReceived()
    },
    ensureConnected(sessionId: string) {
      if (
        this.connectedSessionId === sessionId &&
        (streams.has(sessionId) || coordinator.retryTimer) &&
        this.sseConnectionState !== 'idle'
      ) return
      this.disconnectSse()
      this.connectedSessionId = sessionId
      this.sseConnectionState = 'connecting'
      const generation = coordinator.generation

      if (typeof window !== 'undefined') {
        coordinator.onlineHandler = () => this.retrySseNow()
        coordinator.visibilityHandler = () => {
          if (document.visibilityState === 'visible') this.retrySseNow()
        }
        window.addEventListener('online', coordinator.onlineHandler)
        document.addEventListener('visibilitychange', coordinator.visibilityHandler)
      }
      this.openSseAttempt(sessionId, generation)
    },
    connectSse(sessionId: string) {
      this.ensureConnected(sessionId)
    },
    async ensureConnectedAndReconcile(sessionId: string) {
      this.ensureConnected(sessionId)
      await this.reconcileServerEvents(sessionId, coordinator.generation, coordinator.attempt)
    },
    retrySseNow() {
      const sessionId = this.connectedSessionId
      if (!sessionId || this.sseConnectionState === 'connected' || this.sseConnectionState === 'connecting') return
      if (coordinator.retryTimer) clearTimeout(coordinator.retryTimer)
      coordinator.retryTimer = undefined
      this.openSseAttempt(sessionId, coordinator.generation)
    },
    async finalizeSessionEvents(sessionId: string) {
      try {
        const stream = streams.get(sessionId)
        if (
          this.connectedSessionId === sessionId &&
          this.sseConnectionState === 'connected' &&
          stream
        ) {
          await this.reconcileServerEvents(sessionId, coordinator.generation, coordinator.attempt)
        } else {
          await this.loadEvents(sessionId, { append: true })
        }
      } finally {
        if (this.connectedSessionId === sessionId) this.disconnectSse()
      }
    },
    async probeBackendReachability() {
      await apiGet('/health', { timeoutMs: 5_000, timeoutMessage: 'Backend reachability probe timed out' })
      return true
    },
    disconnectSse() {
      coordinator.generation += 1
      coordinator.attempt += 1
      for (const stream of streams.values()) stream.close()
      streams.clear()
      if (coordinator.retryTimer) clearTimeout(coordinator.retryTimer)
      if (coordinator.degradedTimer) clearTimeout(coordinator.degradedTimer)
      if (coordinator.frameTimer) clearTimeout(coordinator.frameTimer)
      coordinator.retryTimer = undefined
      coordinator.degradedTimer = undefined
      coordinator.frameTimer = undefined
      coordinator.backfillAbort?.abort()
      coordinator.backfillAbort = undefined
      coordinator.backfillPromise = undefined
      coordinator.recovering = false
      coordinator.bufferedEvents = []
      coordinator.firstFailureAt = undefined
      coordinator.retryIndex = 0
      if (typeof window !== 'undefined') {
        if (coordinator.onlineHandler) window.removeEventListener('online', coordinator.onlineHandler)
        if (coordinator.visibilityHandler) document.removeEventListener('visibilitychange', coordinator.visibilityHandler)
      }
      coordinator.onlineHandler = undefined
      coordinator.visibilityHandler = undefined
      this.connectedSessionId = undefined
      this.sseConnected = false
      this.sseConnectionState = 'idle'
    }
  }
})
