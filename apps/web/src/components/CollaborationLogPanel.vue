<script setup lang="ts">
import { computed } from 'vue'
import type { AgentCardState, CollaborationEvent } from '@/types/contracts'
import { eventAgentId, resolveActor } from '@/composables/useActor'
import AgentPortrait from './AgentPortrait.vue'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  events: CollaborationEvent[]
  agents: AgentCardState[]
  title?: string
}>()

type LogEntry = {
  key: string
  event: CollaborationEvent
  agentId?: string
  content: string
}

function heartbeatOf(event: CollaborationEvent) {
  if (event.type !== 'runtime_progress') return undefined
  const payload = (event.metadata.payload ?? {}) as { code?: string; runtimeInvocationId?: string; elapsedMs?: number }
  if (payload.code !== 'RUNTIME_HEARTBEAT') return undefined
  return {
    invocationId: payload.runtimeInvocationId ?? event.id,
    elapsedMs: payload.elapsedMs ?? 0
  }
}

/**
 * A 5 minute model call emits ten 30s heartbeats, which would push every real
 * execution event out of the 8-entry window. Fold consecutive heartbeats of the
 * same invocation into one entry that reports the longest wait observed.
 */
const visibleEvents = computed<LogEntry[]>(() => {
  const entries: LogEntry[] = []
  for (const event of props.events) {
    if (!event.content) continue
    const agentId = eventAgentId(event)
    if (!agentId && event.type !== 'user_message' && event.metadata.renderAs !== 'system_notice') continue

    const heartbeat = heartbeatOf(event)
    const previous = entries[entries.length - 1]
    const previousHeartbeat = previous ? heartbeatOf(previous.event) : undefined
    if (heartbeat && previousHeartbeat && previousHeartbeat.invocationId === heartbeat.invocationId) {
      if (heartbeat.elapsedMs >= previousHeartbeat.elapsedMs) {
        entries[entries.length - 1] = { key: previous!.key, event, agentId, content: event.content }
      }
      continue
    }

    entries.push({ key: event.id, event, agentId, content: event.content })
  }
  return entries.slice(-8)
})

function agentIndex(agentId?: string) {
  const index = props.agents.findIndex((agent) => agent.agentId === agentId)
  return index < 0 ? 0 : index
}

function agentTone(agentId?: string): number | 'system' {
  return agentId ? (agentIndex(agentId) % 5) + 1 : 'system'
}

function agentName(entry: LogEntry) {
  if (!entry.agentId) return '系统通知'
  const card = props.agents.find((agent) => agent.agentId === entry.agentId)
  if (card) return card.name
  // System Agents are management-surface only, so they never become session
  // participants and never get a card. resolveActor() reads the Agent store,
  // which merges the system Agents in, so the name still resolves.
  const resolved = resolveActor(entry.event)
  return resolved.displayName === entry.agentId ? '系统 Agent' : resolved.displayName
}

function agentRole(agentId?: string) {
  if (!agentId) return ''
  return props.agents.find((agent) => agent.agentId === agentId)?.role ?? ''
}

function eventTime(event: CollaborationEvent) {
  return new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
</script>

<template>
  <aside class="collaboration-log-panel">
    <header class="collaboration-log-header">
      <h2>
        <UiIcon name="message" :size="18" />
        {{ title ?? '对话 / 消息日志' }}
      </h2>
      <button type="button">全部</button>
    </header>

    <section class="collaboration-log-list">
      <article
        v-for="entry in visibleEvents"
        :key="entry.key"
        :class="['collaboration-log-card', `agent-tone-${(agentIndex(entry.agentId) % 5) + 1}`]"
      >
        <AgentPortrait :tone="agentTone(entry.agentId)" :label="agentName(entry)" size="md" />
        <div class="collaboration-log-body">
          <header>
            <strong>{{ agentName(entry) }}</strong>
            <time>{{ eventTime(entry.event) }}</time>
          </header>
          <p v-if="agentRole(entry.agentId)" class="collaboration-log-role">{{ agentRole(entry.agentId) }}</p>
          <p>{{ entry.content }}</p>
          <div v-if="entry.event.type === 'artifact_created'" class="collaboration-log-file">
            <UiIcon name="paperclip" :size="17" />
            <span>{{ entry.event.metadata.title ?? '协作产物' }}</span>
          </div>
        </div>
      </article>
    </section>
  </aside>
</template>
