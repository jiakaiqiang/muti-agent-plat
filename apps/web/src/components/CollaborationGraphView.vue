<script setup lang="ts">
import { computed } from 'vue'
import type { AgentCardState, CollaborationEvent } from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  events: CollaborationEvent[]
  agents: AgentCardState[]
}>()

const displayAgents = computed(() => props.agents.slice(0, 5))
const activeAgent = computed(
  () => displayAgents.value.find((agent) => ['running', 'thinking', 'discussing', 'reviewing', 'reworking'].includes(agent.status))
    ?? displayAgents.value[1]
)

function agentTone(index: number) {
  return ((index % 5) + 1) as 1 | 2 | 3 | 4 | 5
}

function shortAgentName(name: string) {
  return name.replace(' Agent', '')
}

function statusLabel(status: string) {
  return (
    {
      idle: '空闲中',
      running: '执行中',
      thinking: '思考中',
      discussing: '讨论中',
      waiting: '等待中',
      reviewing: '复盘中',
      reworking: '返工中',
      completed: '已完成',
      failed: '失败',
      disabled: '离线'
    }[status] ?? status
  )
}

function progressFor(agent: AgentCardState) {
  if (agent.status === 'completed') return 100
  if (['running', 'thinking', 'discussing', 'reviewing', 'reworking'].includes(agent.status)) return 65
  return 0
}
</script>

<template>
  <section class="flow-view graph-cockpit">
    <header class="graph-hero">
      <div>
        <h2>多 Agent 协同工作平台</h2>
        <p>
          <strong>当前任务：</strong>
          {{ activeAgent?.currentTaskTitle ?? '电商促销活动方案制定与落地执行' }}
          <span class="session-state online">运行中</span>
          <span class="graph-clock">00:12:45</span>
        </p>
      </div>
      <button class="cockpit-action" type="button">
        <UiIcon name="list" :size="17" />
        任务概览
      </button>
    </header>

    <section class="agent-array-heading">
      <h3>Agent 阵列（{{ displayAgents.length }}/{{ displayAgents.length }} 在线）</h3>
    </section>

    <div class="agent-graph-canvas">
      <article class="graph-callout">
        <span class="agent-node-icon agent-tone-2">
          <UiIcon name="list" :size="18" />
        </span>
        <strong>{{ activeAgent?.currentTaskTitle ?? '正在制定促销策略和活动规则' }}</strong>
      </article>

      <button
        v-for="(agent, index) in displayAgents"
        :key="agent.agentId"
        type="button"
        :class="['agent-graph-node', `node-${index + 1}`, `agent-tone-${agentTone(index)}`, { active: agent.agentId === activeAgent?.agentId }]"
      >
        <span class="agent-node-icon">
          <UiIcon :name="index === 0 ? 'search' : index === 1 ? 'workflow' : index === 2 ? 'sparkles' : index === 3 ? 'graph' : 'list'" :size="18" />
        </span>
        <h3>Agent {{ String(index + 1).padStart(2, '0') }}</h3>
        <p>{{ shortAgentName(agent.name) }}</p>
        <AgentPortrait :tone="agentTone(index)" :label="agent.name" size="lg" />
        <strong class="agent-node-status">{{ statusLabel(agent.status) }}</strong>
      </button>

      <span class="graph-line line-1"></span>
      <span class="graph-line line-2"></span>
      <span class="graph-line line-3"></span>
      <span class="graph-line line-4"></span>
      <span class="graph-line line-5"></span>
    </div>

    <section class="realtime-status-table">
      <h3>实时任务状态</h3>
      <article v-for="(agent, index) in displayAgents" :key="agent.agentId">
        <span :class="['agent-node-icon', `agent-tone-${agentTone(index)}`]">
          <UiIcon :name="index === 0 ? 'search' : index === 1 ? 'workflow' : index === 2 ? 'sparkles' : index === 3 ? 'graph' : 'list'" :size="16" />
        </span>
        <strong>Agent {{ String(index + 1).padStart(2, '0') }} {{ shortAgentName(agent.name) }}</strong>
        <span>{{ statusLabel(agent.status) }}</span>
        <p>{{ agent.currentTaskTitle ?? '等待分配新任务' }}</p>
        <div class="agent-meter">
          <span :style="{ width: `${progressFor(agent)}%` }"></span>
        </div>
        <b>{{ progressFor(agent) }}%</b>
      </article>
    </section>
  </section>
</template>
