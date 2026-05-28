<script setup lang="ts">
import { computed } from 'vue'
import { useAgentStore } from '@/stores/agent'
import type { ChatMessage, ConfirmationCardState, ConfirmationRequestedPayload } from '@/types/contracts'
import ConfirmationCard from './ConfirmationCard.vue'

const props = defineProps<{
  messages: ChatMessage[]
}>()

const emit = defineEmits<{
  resolveConfirmation: [optionKey: string]
}>()

const agentStore = useAgentStore()

const timeline = computed(() => props.messages)

function senderLabel(message: ChatMessage) {
  if (message.senderType === 'user') return 'You'
  if (message.senderType === 'agent') return agentStore.agentName(message.senderAgentId)
  return 'System'
}

function confirmationFromMessage(message: ChatMessage): ConfirmationCardState | undefined {
  if (message.messageType !== 'confirmation') return undefined
  const payload = message.payload as (ConfirmationRequestedPayload & Record<string, unknown>) | undefined
  if (!payload) return undefined
  return {
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

function listFromPayload(message: ChatMessage, key: string) {
  const value = message.payload?.[key]
  return Array.isArray(value) ? value : []
}
</script>

<template>
  <main class="chat-timeline">
    <article
      v-for="message in timeline"
      :key="message.id"
      class="timeline-item"
      :class="[message.senderType, message.messageType]"
    >
      <header class="message-header">
        <strong>{{ senderLabel(message) }}</strong>
        <span>{{ new Date(message.createdAt).toLocaleTimeString() }}</span>
      </header>

      <ConfirmationCard
        v-if="confirmationFromMessage(message)"
        :confirmation="confirmationFromMessage(message)!"
        compact
        @resolve="emit('resolveConfirmation', $event)"
      />

      <template v-else>
        <p class="message-content">{{ message.content }}</p>

        <div v-if="message.messageType === 'brief'" class="structured-block">
          <h3>{{ message.payload?.goal }}</h3>
          <dl>
            <div>
              <dt>Scope</dt>
              <dd>{{ listFromPayload(message, 'scope').join(', ') }}</dd>
            </div>
            <div>
              <dt>Acceptance</dt>
              <dd>{{ listFromPayload(message, 'acceptanceCriteria').join(', ') }}</dd>
            </div>
            <div>
              <dt>Risks</dt>
              <dd>{{ listFromPayload(message, 'risks').join(', ') }}</dd>
            </div>
          </dl>
        </div>

        <div v-if="message.messageType === 'delivery'" class="structured-block">
          <h3>{{ message.payload?.summary }}</h3>
          <ul>
            <li v-for="item in listFromPayload(message, 'completedItems')" :key="String(item)">{{ item }}</li>
          </ul>
        </div>

        <div v-if="message.messageType === 'rag'" class="structured-block">
          <h3>{{ message.payload?.query }}</h3>
          <p
            v-for="chunk in (message.payload?.matchedChunks as Array<Record<string, unknown>> | undefined) ?? []"
            :key="String(chunk.chunkId)"
          >
            {{ chunk.title }}: {{ chunk.snippet }}
          </p>
        </div>
      </template>
    </article>
  </main>
</template>
