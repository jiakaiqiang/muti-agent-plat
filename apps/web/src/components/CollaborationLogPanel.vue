<script setup lang="ts">
import { computed } from 'vue'
import type { AgentCardState, CollaborationEvent } from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  events: CollaborationEvent[]
  agents: AgentCardState[]
}>()

const visibleEvents = computed(() =>
  props.events
    .filter((event) => event.content && (event.fromAgentId || event.type === 'user_message' || event.metadata.renderAs === 'system_notice'))
    .slice(-8)
)

function agentIndex(agentId?: string) {
  const index = props.agents.findIndex((agent) => agent.agentId === agentId)
  return index < 0 ? 0 : index
}

function agentName(agentId?: string) {
  if (!agentId) return '系统通知'
  return props.agents.find((agent) => agent.agentId === agentId)?.name ?? agentId
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
        对话 / 消息日志
      </h2>
      <button type="button">全部</button>
    </header>

    <section class="collaboration-log-list">
      <article
        v-for="event in visibleEvents"
        :key="event.id"
        :class="['collaboration-log-card', `agent-tone-${(agentIndex(event.fromAgentId) % 5) + 1}`]"
      >
        <AgentPortrait
          :tone="event.fromAgentId ? ((agentIndex(event.fromAgentId) % 5) + 1) : 'system'"
          :label="agentName(event.fromAgentId)"
          size="md"
        />
        <div class="collaboration-log-body">
          <header>
            <strong>{{ agentName(event.fromAgentId) }}</strong>
            <time>{{ eventTime(event) }}</time>
          </header>
          <p v-if="agentRole(event.fromAgentId)" class="collaboration-log-role">{{ agentRole(event.fromAgentId) }}</p>
          <p>{{ event.content }}</p>
          <div v-if="event.type === 'artifact_created'" class="collaboration-log-file">
            <UiIcon name="paperclip" :size="17" />
            <span>{{ event.metadata.title ?? '协作产物' }}</span>
          </div>
        </div>
      </article>
    </section>

    <footer class="collaboration-log-input">
      <input type="text" placeholder="输入消息..." />
      <button type="button" title="发送">
        <UiIcon name="send" :size="20" />
      </button>
    </footer>
  </aside>
</template>
