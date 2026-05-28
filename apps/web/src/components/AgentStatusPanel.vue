<script setup lang="ts">
import type { AgentCardState, ConfirmationCardState, TaskViewState } from '@/types/contracts'
import ConfirmationCard from './ConfirmationCard.vue'

defineProps<{
  agents: AgentCardState[]
  tasks: TaskViewState[]
  activeConfirmation?: ConfirmationCardState
  connected: boolean
}>()

const emit = defineEmits<{
  resolveConfirmation: [optionKey: string]
}>()
</script>

<template>
  <aside class="agent-panel">
    <header class="panel-header">
      <span>Agents</span>
      <span class="connection-pill" :class="{ online: connected }">{{ connected ? 'SSE connected' : 'offline' }}</span>
    </header>

    <ConfirmationCard
      v-if="activeConfirmation"
      :confirmation="activeConfirmation"
      compact
      @resolve="emit('resolveConfirmation', $event)"
    />

    <section class="panel-section">
      <h2>Agent 状态</h2>
      <article v-for="agent in agents" :key="agent.agentId" class="agent-card">
        <div class="agent-card__top">
          <div>
            <h3>{{ agent.name }}</h3>
            <p>{{ agent.role }}</p>
          </div>
          <span class="agent-status" :class="agent.status">{{ agent.status }}</span>
        </div>
        <p v-if="agent.currentTaskTitle" class="agent-task">{{ agent.currentTaskTitle }}</p>
        <p v-if="agent.thoughtSummary" class="agent-summary">{{ agent.thoughtSummary }}</p>
        <p v-if="agent.actionSummary" class="agent-summary muted">{{ agent.actionSummary }}</p>
        <div v-if="agent.activeCapabilityNames.length" class="tag-row">
          <span v-for="capability in agent.activeCapabilityNames" :key="capability" class="tag">{{ capability }}</span>
        </div>
        <ul v-if="agent.usedRagSnippets.length" class="rag-list">
          <li v-for="snippet in agent.usedRagSnippets" :key="snippet.title">
            <strong>{{ snippet.title }}</strong>
            <span>{{ snippet.snippet }}</span>
          </li>
        </ul>
      </article>
    </section>

    <section class="panel-section">
      <h2>Tasks</h2>
      <article v-for="task in tasks" :key="task.taskId" class="task-chip">
        <span class="task-status" :class="task.status"></span>
        <div>
          <strong>{{ task.title }}</strong>
          <p>{{ task.resultSummary ?? task.status }}</p>
        </div>
      </article>
    </section>
  </aside>
</template>
