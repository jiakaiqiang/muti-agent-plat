<script setup lang="ts">
import type { AgentCardState, ConfirmationCardState, TaskViewState } from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import ConfirmationCard from './ConfirmationCard.vue'
import UiIcon from './UiIcon.vue'

defineProps<{
  agents: AgentCardState[]
  tasks: TaskViewState[]
  activeConfirmation?: ConfirmationCardState
  connected: boolean
}>()

const emit = defineEmits<{
  resolveConfirmation: [optionKey: string]
}>()

function statusLabel(status: string) {
  return (
    {
      idle: '空闲中',
      running: '运行中',
      thinking: '思考中',
      discussing: '讨论中',
      waiting: '等待中',
      reviewing: '复盘中',
      reworking: '返工中',
      completed: '已完成',
      failed: '失败',
      disabled: '停用'
    }[status] ?? status
  )
}
</script>

<template>
  <aside class="agent-panel">
    <header class="panel-header">
      <span>Agent 列表</span>
      <button class="panel-collapse-button" type="button" title="收起">
        <UiIcon name="chevronUp" :size="16" />
      </button>
      <span class="connection-pill" :class="{ online: connected }">{{ connected ? '实时连接' : '离线' }}</span>
    </header>

    <ConfirmationCard
      v-if="activeConfirmation"
      :confirmation="activeConfirmation"
      compact
      @resolve="emit('resolveConfirmation', $event)"
    />

    <section class="panel-section agent-list-section">
      <article v-for="(agent, index) in agents" :key="agent.agentId" class="agent-card">
        <AgentPortrait :tone="(index % 5) + 1" :label="agent.name" size="md" />
        <div class="agent-card__body">
          <div class="agent-card__top">
            <div>
              <h3>{{ agent.name }}</h3>
              <p>{{ agent.role }}</p>
            </div>
            <span class="agent-status" :class="agent.status">{{ statusLabel(agent.status) }}</span>
          </div>
          <p v-if="agent.currentTaskTitle" class="agent-task">{{ agent.currentTaskTitle }}</p>
          <p v-if="agent.thoughtSummary" class="agent-summary">{{ agent.thoughtSummary }}</p>
          <p v-if="agent.actionSummary" class="agent-summary muted">{{ agent.actionSummary }}</p>
          <div class="agent-meter">
            <span :style="{ width: agent.status === 'running' ? '66%' : agent.status === 'completed' ? '100%' : '18%' }"></span>
          </div>
          <div v-if="agent.activeCapabilityNames.length" class="tag-row">
            <span v-for="capability in agent.activeCapabilityNames" :key="capability" class="tag">{{ capability }}</span>
          </div>
          <ul v-if="agent.usedRagSnippets.length" class="rag-list">
            <li v-for="snippet in agent.usedRagSnippets" :key="snippet.title">
              <strong>{{ snippet.title }}</strong>
              <span>{{ snippet.snippet }}</span>
            </li>
          </ul>
        </div>
      </article>
    </section>

    <section class="panel-section task-steps-panel">
      <header>
        <h2>任务执行步骤</h2>
        <button type="button">展开全部</button>
      </header>
      <article v-for="(task, index) in tasks" :key="task.taskId" class="task-step">
        <span :class="['task-step__index', task.status]">{{ index + 1 }}</span>
        <div>
          <strong>{{ task.title }}</strong>
          <p>{{ task.resultSummary ?? statusLabel(task.status) }}</p>
        </div>
        <small>{{ statusLabel(task.status) }}</small>
      </article>
    </section>
  </aside>
</template>
