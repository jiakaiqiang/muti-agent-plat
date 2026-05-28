<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useEventStore } from '@/stores/event'
import { useKnowledgeStore } from '@/stores/knowledge'
import { useSessionStore } from '@/stores/session'
import { sessionStatusLabel, type SessionStatus, type SessionViewMode } from '@/types/contracts'
import AgentStatusPanel from './AgentStatusPanel.vue'
import ChatTimeline from './ChatTimeline.vue'
import SessionSidebar from './SessionSidebar.vue'

const sessionStore = useSessionStore()
const eventStore = useEventStore()
const agentStore = useAgentStore()
const knowledgeStore = useKnowledgeStore()

onMounted(() => {
  agentStore.loadAgents()
  knowledgeStore.loadKnowledgeBases()
  sessionStore.loadSessions()
  sessionStore.loadSession()
  if (sessionStore.currentSession) {
    eventStore.loadMockEvents(sessionStore.currentSession.id)
    eventStore.connectSse(sessionStore.currentSession.id)
  }
})

const currentSessionId = computed(() => sessionStore.currentSession?.id ?? '')
const messages = computed(() => eventStore.chatMessages(currentSessionId.value))
const agents = computed(() => eventStore.agentCards(currentSessionId.value))
const tasks = computed(() => eventStore.taskStates(currentSessionId.value))
const activeConfirmation = computed(() => eventStore.activeConfirmation(currentSessionId.value))
const viewModes: SessionViewMode[] = ['chat', 'collaboration_graph', 'workflow']

const derivedStatus = computed(() => {
  const statusEvent = [...eventStore.eventsForSession(currentSessionId.value)]
    .reverse()
    .find((event) => event.type === 'session_status_changed')
  return (statusEvent?.metadata.payload?.status as SessionStatus | undefined) ?? sessionStore.currentSession?.status
})

function selectSession(sessionId: string) {
  sessionStore.loadSession(sessionId)
  eventStore.loadMockEvents(sessionId)
  eventStore.connectSse(sessionId)
}

function resolveConfirmation(optionKey: string) {
  if (!sessionStore.currentSession || !activeConfirmation.value) return
  eventStore.appendEvent({
    id: `evt-local-${Date.now()}`,
    sessionId: sessionStore.currentSession.id,
    type: 'user_confirmation_resolved',
    toAgentIds: ['agent-coordinator'],
    content: `用户选择：${optionKey}`,
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'system_notice',
      payload: {
        confirmationId: activeConfirmation.value.confirmationId,
        status: optionKey === 'approve' ? 'approved' : 'rejected',
        selectedOptionKey: optionKey
      }
    },
    createdAt: new Date().toISOString()
  })
}
</script>

<template>
  <div class="workspace-shell">
    <SessionSidebar
      :sessions="sessionStore.sessions"
      :current-session-id="sessionStore.currentSession?.id"
      @select="selectSession"
    />

    <section class="workspace-main">
      <header class="workspace-header">
        <div>
          <h1>{{ sessionStore.currentSession?.title }}</h1>
          <p>{{ sessionStore.currentSession?.originalInput }}</p>
        </div>
        <div class="workspace-actions">
          <span v-if="derivedStatus" class="session-state">{{ sessionStatusLabel[derivedStatus] }}</span>
          <button
            v-for="mode in viewModes"
            :key="mode"
            type="button"
            :class="['mode-button', { active: sessionStore.currentViewMode === mode }]"
            @click="sessionStore.switchViewMode(mode)"
          >
            {{ mode }}
          </button>
        </div>
      </header>

      <ChatTimeline :messages="messages" @resolve-confirmation="resolveConfirmation" />
    </section>

    <AgentStatusPanel
      :agents="agents"
      :tasks="tasks"
      :active-confirmation="activeConfirmation"
      :connected="eventStore.sseConnected"
      @resolve-confirmation="resolveConfirmation"
    />
  </div>
</template>
