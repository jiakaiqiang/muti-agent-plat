<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentCardState, CollaborationEvent } from '@/types/contracts'
import { buildCollaborationTaskPanels } from './collaborationTaskModel'

const props = defineProps<{ events: CollaborationEvent[]; agents: AgentCardState[] }>()
const emit = defineEmits<{
  retryAgent: [agentId: string, taskId: string]
  resummarize: [taskId: string]
}>()
const expanded = ref<Record<string, boolean>>({})
const panels = computed(() => buildCollaborationTaskPanels(props.events, props.agents))

function statusLabel(status: string) {
  return ({ running: '执行中', completed: '已完成', failed: '有失败', cancelled: '已取消' }[status] ?? status)
}

function agentStatusLabel(status: string) {
  return ({ pending: '待处理', running: '执行中', waiting: '等待中', completed: '已完成', failed: '失败', cancelled: '已取消' }[status] ?? status)
}
</script>

<template>
  <section v-if="panels.length" class="collaboration-task-panels" aria-label="Agent 协同任务面板">
    <header class="collaboration-task-panels__header">
      <div><h3>Agent 协同任务</h3><span>{{ panels.length }} 个任务 · 状态来自事件流</span></div>
    </header>
    <article v-for="panel in panels" :key="panel.taskId" class="collaboration-task-panel" :class="`is-${panel.status}`">
      <header class="collaboration-task-panel__heading">
        <div><strong>{{ panel.title }}</strong><small>{{ panel.routingReason ?? '已解析路由' }}</small></div>
        <span class="collaboration-task-panel__status">{{ statusLabel(panel.status) }}</span>
      </header>
      <div class="collaboration-task-panel__meta">
        <span>路由：{{ panel.routingMode }}</span>
        <span v-if="panel.resolvedAgentId">执行者：{{ panel.resolvedAgentId }}</span>
        <span>附件：{{ panel.attachmentCount }}</span>
        <button type="button" @click="emit('resummarize', panel.taskId)">重新汇总</button>
      </div>
      <details v-if="panel.summaries.length" class="collaboration-task-panel__summaries">
        <summary>汇总版本（{{ panel.summaries.length }}）</summary>
        <article v-for="summary in panel.summaries" :key="summary.id">
          <strong>v{{ summary.version }} · {{ summary.kind === 'temporary_cancelled' ? '临时汇总' : '手动重新汇总' }}</strong>
          <p>{{ summary.content }}</p>
        </article>
      </details>
      <div class="collaboration-task-panel__agents">
        <details v-for="agent in panel.agents" :key="agent.agentId" :open="expanded[`${panel.taskId}:${agent.agentId}`] ?? false" @toggle="expanded[`${panel.taskId}:${agent.agentId}`] = ($event.target as HTMLDetailsElement).open">
          <summary>
            <span class="collaboration-task-panel__agent-name">{{ agent.name }}</span>
            <span class="collaboration-task-panel__agent-status" :class="`is-${agent.status}`">{{ agentStatusLabel(agent.status) }}</span>
            <span
              class="collaboration-task-panel__progress"
              role="progressbar"
              :aria-label="`${agent.name} 任务进度`"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="agent.progress"
            ><i :style="{ width: `${agent.progress}%` }"></i></span>
          </summary>
          <button
            v-if="agent.status === 'failed'"
            type="button"
            class="collaboration-task-panel__retry"
            @click="emit('retryAgent', agent.agentId, panel.taskId)"
          >重试此 Agent</button>
          <ul v-if="agent.outputs.length" class="collaboration-task-panel__outputs">
            <li v-for="output in agent.outputs" :key="output.id"><time>{{ new Date(output.createdAt).toLocaleTimeString() }}</time>{{ output.content }}</li>
          </ul>
          <p v-else class="collaboration-task-panel__empty">暂无阶段输出</p>
        </details>
      </div>
    </article>
  </section>
</template>
