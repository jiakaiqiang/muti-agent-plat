<script setup lang="ts">
import { computed } from 'vue'
import { defaultAgents } from '@agent-cluster/shared'
import type {
  AgentCardState,
  BriefEventPayload,
  CollaborationEvent,
  TaskViewState
} from '@/types/contracts'
import { actorAgentId } from '@/composables/useActor'
import { eventNoticeText } from '@/utils/userFacingCopy'
import { useAgentStore } from '@/stores/agent'
import { formatDateTime } from '@/utils/dateTime'

const props = defineProps<{
  brief?: BriefEventPayload
  tasks: TaskViewState[]
  agents: AgentCardState[]
  events: CollaborationEvent[]
}>()

const agentStore = useAgentStore()

const hiddenEventTypes = new Set<CollaborationEvent['type']>([
  'user_confirmation_requested',
  'user_confirmation_resolved',
  'capability_approval_required',
  'capability_approved',
  'workflow_gate_requested',
  'workflow_gate_decided',
  'brief_confirmed',
  'brief_rejected'
])

const hiddenActionText = /(?:请确认|确认任务契约|请选择工作流|用户授权|等待用户授权|等待用户输入|用户确认|未确认问题|HUMAN_APPROVAL_REQUIRED|approved for this scope|已授权|执行权限，可以开始执行)/i

const activeStatuses = new Set(['running', 'thinking', 'discussing', 'reviewing', 'reworking', 'waiting'])

const completedCount = computed(() => props.tasks.filter((task) => task.status === 'completed').length)
const activeAgentCount = computed(() => props.agents.filter((agent) => activeStatuses.has(agent.status)).length)
const overallProgress = computed(() => {
  if (!props.tasks.length) return props.brief ? 10 : 0
  return Math.round(props.tasks.reduce((total, task) => total + taskProgress(task.status), 0) / props.tasks.length)
})

const planItems = computed(() => {
  if (props.tasks.length) {
    return props.tasks.map((task) => ({
      id: task.taskId,
      title: task.title,
      status: task.status,
      statusText: taskStatusLabel(task.status),
      tone: taskStatusTone(task.status),
      progress: taskProgress(task.status),
      agentName: agentName(actorAgentId(task.assignee)),
      summary: taskSummary(task),
      dependencyCount: task.dependsOnTaskIds.length
    }))
  }
  return (props.brief?.suggestedTasks ?? []).map((task, index) => ({
    id: `suggested-${index}`,
    title: task.title,
    status: 'pending',
    statusText: '待开始',
    tone: 'pending',
    progress: 0,
    agentName: task.suggestedAgentKey ? agentName(task.suggestedAgentKey) : '待分配',
    summary: task.description,
    dependencyCount: task.dependsOnTaskTitles.length
  }))
})

const processEvents = computed(() => props.events
  .filter((event) => !hiddenEventTypes.has(event.type) && event.type !== 'user_message')
  .filter((event) => event.content.trim() && !hiddenActionText.test(event.content))
  .slice(-40)
  .reverse()
  .map((event) => ({
    id: event.id,
    title: eventTitle(event),
    content: eventNoticeText(event),
    actor: eventActor(event),
    createdAt: formatTime(event.createdAt),
    tone: eventTone(event)
  })))

function agentName(agentId?: string) {
  if (!agentId) return '主 Agent'
  // System Agents have no session card; resolve them through the full directory.
  const definition = agentStore.agents.find((agent) => agent.id === agentId || agent.key === agentId)
  const card = props.agents.find((agent) => agent.agentId === agentId || agent.agentId === definition?.id)
  const builtIn = defaultAgents.find((agent) => agent.id === agentId || agent.key === agentId)
  const name = definition?.name || card?.name || builtIn?.name
  return name && name !== agentId ? name : '未知 Agent'
}

function taskSummary(task: TaskViewState) {
  return [task.resultSummary, task.assignmentReason, task.acceptanceCriteria[0]]
    .find((content) => content && !hiddenActionText.test(content)) ?? '等待任务进一步推进'
}

function taskStatusLabel(status: TaskViewState['status']) {
  return ({
    pending: '待处理', assigned: '已分配', accepted: '已接受', claimed: '已领取', running: '执行中',
    waiting: '等待中', blocked: '阻塞中', reviewing: '评审中', rejected: '未通过', cancelled: '已取消',
    completed: '已完成', failed: '失败', reworking: '返工中'
  }[status] ?? status)
}

function taskStatusTone(status: TaskViewState['status']) {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'rejected' || status === 'cancelled') return 'failed'
  if (status === 'waiting' || status === 'blocked') return 'waiting'
  if (['running', 'accepted', 'claimed', 'reviewing', 'reworking'].includes(status)) return 'running'
  return 'pending'
}

function taskProgress(status: TaskViewState['status']) {
  if (status === 'completed') return 100
  if (status === 'failed' || status === 'rejected' || status === 'cancelled') return 100
  if (status === 'reviewing') return 85
  if (status === 'reworking') return 70
  if (status === 'running') return 60
  if (status === 'waiting' || status === 'blocked') return 40
  if (status === 'accepted' || status === 'claimed') return 30
  if (status === 'assigned') return 15
  return 0
}

function eventActor(event: CollaborationEvent) {
  if (event.actor?.type === 'agent') return agentName(event.actor.id)
  if (event.fromAgentId) return agentName(event.fromAgentId)
  return event.actor?.type === 'system' ? '系统' : '协作流程'
}

function eventTitle(event: CollaborationEvent) {
  if (event.type.startsWith('task_')) return '任务进展'
  if (event.type.startsWith('runtime_')) return 'Agent 执行'
  if (event.type.startsWith('tool_')) return '能力调用'
  if (event.type.startsWith('workflow_')) return '工作流进展'
  if (event.type.startsWith('attachment_')) return '附件处理'
  return ({
    agent_message: '协作消息',
    agent_mention: 'Agent 协作',
    agent_status_changed: 'Agent 状态',
    brief_created: '计划已生成',
    brief_updated: '计划已更新',
    artifact_created: '产物已生成',
    post_review_started: '开始复盘',
    post_review_completed: '复盘完成',
    final_delivery_created: '交付完成',
    error_reported: '异常记录'
  } as Partial<Record<CollaborationEvent['type'], string>>)[event.type] ?? '协作进展'
}

function eventTone(event: CollaborationEvent) {
  if (event.type.endsWith('_failed') || event.type === 'error_reported' || event.type === 'task_rejected') return 'failed'
  if (event.type.endsWith('_completed') || event.type === 'final_delivery_created' || event.type === 'artifact_created') return 'completed'
  if (event.type === 'task_waiting' || event.type === 'task_blocked') return 'waiting'
  return 'running'
}

function formatTime(value: string) {
  return formatDateTime(value)
}
</script>

<template>
  <section class="collaboration-plan-view" aria-labelledby="collaboration-plan-title">
    <header class="collaboration-plan-hero">
      <div>
        <span>协作计划</span>
        <h2 id="collaboration-plan-title">{{ brief?.goal ?? '协作计划正在生成' }}</h2>
        <p>{{ brief ? `计划版本 v${brief.version} · ${planItems.length} 个任务` : '任务契约生成后将在这里展示完整协作过程。' }}</p>
      </div>
      <div class="collaboration-plan-progress">
        <strong>{{ overallProgress }}%</strong>
        <span
          role="progressbar"
          aria-label="协作计划整体进度"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="overallProgress"
        ><i :style="{ width: `${overallProgress}%` }"></i></span>
      </div>
    </header>

    <dl class="collaboration-plan-stats">
      <div><dt>计划任务</dt><dd>{{ planItems.length }}</dd></div>
      <div><dt>执行中 Agent</dt><dd>{{ activeAgentCount }}</dd></div>
      <div><dt>已完成</dt><dd>{{ completedCount }}</dd></div>
      <div><dt>过程记录</dt><dd>{{ processEvents.length }}</dd></div>
    </dl>

    <div class="collaboration-plan-layout">
      <section class="collaboration-plan-section" aria-labelledby="collaboration-plan-tasks-title">
        <header>
          <div><span>01</span><h3 id="collaboration-plan-tasks-title">任务计划</h3></div>
          <small>按执行顺序展示</small>
        </header>
        <ol v-if="planItems.length" class="collaboration-plan-task-list" tabindex="0" aria-labelledby="collaboration-plan-tasks-title">
          <li v-for="(item, index) in planItems" :key="item.id" :class="`is-${item.tone}`">
            <span class="collaboration-plan-task-index">{{ index + 1 }}</span>
            <div class="collaboration-plan-task-copy">
              <header><strong>{{ item.title }}</strong><em>{{ item.statusText }}</em></header>
              <p>{{ item.summary }}</p>
              <small>{{ item.agentName }}<template v-if="item.dependencyCount"> · 依赖 {{ item.dependencyCount }} 项</template></small>
              <span class="collaboration-plan-task-meter" aria-hidden="true"><i :style="{ width: `${item.progress}%` }"></i></span>
            </div>
          </li>
        </ol>
        <p v-else class="collaboration-plan-empty">暂无任务计划，协作启动后会自动显示。</p>
      </section>

      <section class="collaboration-plan-section" aria-labelledby="collaboration-process-title">
        <header>
          <div><span>02</span><h3 id="collaboration-process-title">协作过程</h3></div>
          <small>只读事件记录</small>
        </header>
        <ol v-if="processEvents.length" class="collaboration-process-list" tabindex="0" aria-labelledby="collaboration-process-title">
          <li v-for="event in processEvents" :key="event.id" :class="`is-${event.tone}`">
            <span class="collaboration-process-marker" aria-hidden="true"></span>
            <div>
              <header><strong>{{ event.title }}</strong><time>{{ event.createdAt }}</time></header>
              <p>{{ event.content }}</p>
              <small>{{ event.actor }}</small>
            </div>
          </li>
        </ol>
        <p v-else class="collaboration-plan-empty">暂无协作过程，Agent 开始工作后会在这里持续更新。</p>
      </section>
    </div>
  </section>
</template>
