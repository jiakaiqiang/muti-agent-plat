<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  Agent,
  AgentCardState,
  ConfirmationCardState,
  RuntimeCapabilityDefinition,
  TaskViewState
} from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import ConfirmationCard from './ConfirmationCard.vue'

const props = defineProps<{
  agents: AgentCardState[]
  availableAgents: Agent[]
  capabilities: RuntimeCapabilityDefinition[]
  tasks: TaskViewState[]
  activeConfirmation?: ConfirmationCardState
  connected: boolean
}>()

const emit = defineEmits<{
  resolveConfirmation: [optionKey: string]
}>()

const tasksExpanded = ref(false)

const agentById = computed(() => new Map(props.availableAgents.map((agent) => [agent.id, agent])))
const capabilityNameById = computed(() => new Map(props.capabilities.map((capability) => [capability.id, capability.name])))

function statusLabel(status: string) {
  return (
    {
      idle: '空闲',
      running: '运行中',
      thinking: '思考中',
      discussing: '讨论中',
      waiting: '等待中',
      reviewing: '复盘中',
      reworking: '返工中',
      completed: '已完成',
      failed: '失败',
      disabled: '停用',
      pending: '待处理',
      claimed: '已领取',
      rejected: '已拒绝',
      cancelled: '已取消'
    }[status] ?? status
  )
}

function configuredAgent(agent: AgentCardState) {
  return agentById.value.get(agent.agentId)
}

function capabilityNames(agent: AgentCardState) {
  const configured = configuredAgent(agent)
  const configuredNames = (configured?.capabilityIds ?? []).map((id) => capabilityNameById.value.get(id) ?? id)
  return agent.activeCapabilityNames.length ? agent.activeCapabilityNames : configuredNames
}

</script>

<template>
  <aside class="agent-panel">
    <header class="panel-header">
      <span>Agent 列表</span>
      <span class="connection-pill" :class="{ online: connected }">{{ connected ? '实时连接' : '离线' }}</span>
    </header>

    <ConfirmationCard
      v-if="activeConfirmation"
      :confirmation="activeConfirmation"
      compact
      @resolve="emit('resolveConfirmation', $event)"
    />

    <section class="panel-section agent-list-section">
      <p v-if="!agents.length" class="empty-state">暂无 Agent，请先到 Agent 管理添加 Agent。</p>
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
          <div v-if="configuredAgent(agent)?.tags?.length" class="tag-row">
            <span v-for="tag in configuredAgent(agent)?.tags" :key="tag" class="tag">{{ tag }}</span>
          </div>
          <div v-if="capabilityNames(agent).length" class="tag-row">
            <span v-for="capability in capabilityNames(agent)" :key="capability" class="tag">{{ capability }}</span>
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
        <button type="button" @click="tasksExpanded = !tasksExpanded">
          {{ tasksExpanded ? '收起全部' : '展开全部' }}
        </button>
      </header>
      <p v-if="!tasks.length" class="empty-state">暂无任务。</p>
      <article v-for="(task, index) in tasks" :key="task.taskId" class="task-step">
        <span :class="['task-step__index', task.status]">{{ index + 1 }}</span>
        <div>
          <strong>{{ task.title }}</strong>
          <p v-if="tasksExpanded">{{ task.resultSummary ?? statusLabel(task.status) }}</p>
          <ul v-if="tasksExpanded && task.acceptanceCriteria.length" class="task-criteria">
            <li v-for="item in task.acceptanceCriteria" :key="item">{{ item }}</li>
          </ul>
        </div>
        <small>{{ statusLabel(task.status) }}</small>
      </article>
    </section>
  </aside>
</template>
