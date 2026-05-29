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
import UiIcon from './UiIcon.vue'

type CreateAgentInput = {
  name: string
  role: string
  tags: string[]
  capabilityIds: string[]
}

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
  createAgent: [input: CreateAgentInput, done: (error?: string) => void]
}>()

const showAgentForm = ref(false)
const isCreatingAgent = ref(false)
const agentFormError = ref('')
const agentName = ref('')
const agentRole = ref('')
const agentTags = ref('')
const selectedCapabilityIds = ref<string[]>([])
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

function normalizedTags() {
  return Array.from(
    new Set(
      agentTags.value
        .split(/[,\n\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  )
}

function toggleCapability(capabilityId: string) {
  selectedCapabilityIds.value = selectedCapabilityIds.value.includes(capabilityId)
    ? selectedCapabilityIds.value.filter((id) => id !== capabilityId)
    : [...selectedCapabilityIds.value, capabilityId]
}

function resetAgentForm() {
  agentName.value = ''
  agentRole.value = ''
  agentTags.value = ''
  selectedCapabilityIds.value = []
  agentFormError.value = ''
}

function submitAgentForm() {
  const name = agentName.value.trim()
  const role = agentRole.value.trim()
  if (!name || !role) {
    agentFormError.value = '请填写 Agent 名称和能力描述'
    return
  }

  isCreatingAgent.value = true
  agentFormError.value = ''
  emit(
    'createAgent',
    {
      name,
      role,
      tags: normalizedTags(),
      capabilityIds: selectedCapabilityIds.value
    },
    (error?: string) => {
      isCreatingAgent.value = false
      if (error) {
        agentFormError.value = error
        return
      }
      resetAgentForm()
      showAgentForm.value = false
    }
  )
}
</script>

<template>
  <aside class="agent-panel">
    <header class="panel-header">
      <span>Agent 列表</span>
      <button class="panel-action-button primary" type="button" @click="showAgentForm = !showAgentForm">
        <UiIcon name="plus" :size="15" />
        添加 Agent
      </button>
      <span class="connection-pill" :class="{ online: connected }">{{ connected ? '实时连接' : '离线' }}</span>
    </header>

    <ConfirmationCard
      v-if="activeConfirmation"
      :confirmation="activeConfirmation"
      compact
      @resolve="emit('resolveConfirmation', $event)"
    />

    <form v-if="showAgentForm" class="agent-create-form" @submit.prevent="submitAgentForm">
      <label>
        <span>名称</span>
        <input v-model="agentName" type="text" placeholder="Research Agent" />
      </label>
      <label>
        <span>标签</span>
        <input v-model="agentTags" type="text" placeholder="research, market" />
      </label>
      <label>
        <span>能力描述</span>
        <textarea v-model="agentRole" rows="3" placeholder="说明这个 Agent 负责什么，以及适合处理哪些任务" />
      </label>
      <div class="agent-capability-picker">
        <span>可用能力</span>
        <button
          v-for="capability in capabilities"
          :key="capability.id"
          type="button"
          :class="{ selected: selectedCapabilityIds.includes(capability.id) }"
          @click="toggleCapability(capability.id)"
        >
          {{ capability.name }}
        </button>
      </div>
      <p v-if="agentFormError" class="form-error">{{ agentFormError }}</p>
      <div class="form-actions">
        <button type="button" @click="showAgentForm = false">取消</button>
        <button type="submit" class="primary" :disabled="isCreatingAgent">
          {{ isCreatingAgent ? '创建中' : '创建 Agent' }}
        </button>
      </div>
    </form>

    <section class="panel-section agent-list-section">
      <p v-if="!agents.length" class="empty-state">暂无 Agent，请先添加真实 Agent。</p>
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
