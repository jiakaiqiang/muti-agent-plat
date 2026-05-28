<script setup lang="ts">
import type { SessionListItem } from '@/types/contracts'
import { sessionStatusLabel } from '@/types/contracts'

defineProps<{
  sessions: SessionListItem[]
  currentSessionId?: string
}>()

const emit = defineEmits<{
  select: [sessionId: string]
}>()
</script>

<template>
  <aside class="session-sidebar">
    <header class="panel-header">
      <span>Sessions</span>
      <button class="icon-button" type="button" title="Create session">+</button>
    </header>

    <button
      v-for="session in sessions"
      :key="session.id"
      class="session-list-item"
      :class="{ active: session.id === currentSessionId }"
      type="button"
      @click="emit('select', session.id)"
    >
      <span class="session-title">{{ session.title }}</span>
      <span class="session-status">{{ sessionStatusLabel[session.status] }}</span>
      <span v-if="session.latestEventSummary" class="session-summary">{{ session.latestEventSummary }}</span>
      <span class="session-budget">{{ session.tokenUsed }} / {{ session.tokenBudget ?? '∞' }} tokens</span>
    </button>
  </aside>
</template>
