<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  AgentCardState,
  BriefEventPayload,
  CollaborationEvent,
  ConfirmationCardState,
  FinalDeliveryPayload,
  SuggestedAgentTask,
  TaskViewState
} from '@/types/contracts'
import ConfirmationCard from './ConfirmationCard.vue'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  brief?: BriefEventPayload
  tasks: TaskViewState[]
  agents: AgentCardState[]
  events: CollaborationEvent[]
  activeConfirmation?: ConfirmationCardState
}>()

const emit = defineEmits<{
  resolveConfirmation: [optionKey: string]
}>()

const isCollapsed = ref(true)
const isActivityDetailOpen = ref(false)
const completedTaskCount = computed(() => props.tasks.filter((task) => task.status === 'completed').length)
const waitingTaskCount = computed(() => props.tasks.filter((task) => task.status === 'waiting').length)
const runningTaskCount = computed(() => props.tasks.filter((task) => task.status === 'running' || task.status === 'claimed').length)
const progressPercent = computed(() => {
  if (!props.tasks.length) return props.brief ? 10 : 0
  return Math.round((completedTaskCount.value / props.tasks.length) * 100)
})

const latestDelivery = computed(() => {
  const event = [...props.events].reverse().find((item) => item.type === 'final_delivery_created')
  return event?.metadata.payload as (FinalDeliveryPayload & Record<string, unknown>) | undefined
})

const reviewEvent = computed(() => [...props.events].reverse().find((item) => item.type === 'post_review_completed'))
const latestReview = computed(() => {
  const payload = reviewEvent.value?.metadata.payload as
    | {
        recommendation?: string
        matchedItems?: string[]
        mismatchedItems?: string[]
        missingItems?: string[]
        testResults?: string[]
      }
    | undefined
  return payload
})
const contextSupplementCount = computed(
  () =>
    props.events.filter(
      (event) => event.type === 'agent_message' && (event.metadata.payload as { phase?: string } | undefined)?.phase === 'context_supplement'
    ).length
)
const interruptionEvents = computed(() =>
  props.events
    .filter((event) => {
      const payload = event.metadata.payload as { reason?: string; phase?: string } | undefined
      return (
        payload?.reason === 'executing_user_interrupt_task_created' ||
        payload?.reason === 'executing_user_interrupt_rescheduled' ||
        payload?.phase === 'user_message_routing'
      )
    })
    .map((event) => {
      const payload = event.metadata.payload as
        | {
            reason?: string
            handlingPlan?: {
              affectedTaskIds?: string[]
              affectedAgentIds?: string[]
              requiresBriefRevision?: boolean
              shouldPause?: boolean
            }
            affectedTaskIds?: string[]
            affectedAgentIds?: string[]
            interruptTaskId?: string
            taskId?: string
          }
        | undefined
      const affectedTaskIds = [
        ...(payload?.affectedTaskIds ?? []),
        ...(payload?.handlingPlan?.affectedTaskIds ?? []),
        ...(payload?.interruptTaskId ? [payload.interruptTaskId] : []),
        ...(payload?.taskId ? [payload.taskId] : [])
      ]
      const affectedAgentIds = [...(payload?.affectedAgentIds ?? []), ...(payload?.handlingPlan?.affectedAgentIds ?? event.toAgentIds ?? [])]
      return {
        id: event.id,
        content: event.content,
        reason: payload?.reason ?? ((event.metadata.payload as { phase?: string } | undefined)?.phase === 'user_message_routing' ? 'user_message_routing' : 'user_interrupt'),
        affectedTaskIds: [...new Set(affectedTaskIds)],
        affectedAgentIds: [...new Set(affectedAgentIds)],
        shouldPause: payload?.handlingPlan?.shouldPause,
        requiresBriefRevision: payload?.handlingPlan?.requiresBriefRevision
      }
    })
    .slice(-3)
)
const interruptionCount = computed(() => interruptionEvents.value.length)
const suggestedTasks = computed(() => (props.tasks.length ? [] : props.brief?.suggestedTasks ?? []))
const activeAgentStatuses = new Set(['running', 'thinking', 'discussing', 'reviewing', 'reworking', 'waiting'])
const activeAgentActivities = computed(() =>
  props.agents
    .filter((agent) => activeAgentStatuses.has(agent.status))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map((agent) => ({
      agentId: agent.agentId,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      statusText: agentActivityLabel(agent.status),
      title: `${agent.name}${agentActivityLabel(agent.status)}`,
      detail: agent.actionSummary ?? agent.thoughtSummary ?? agent.currentTaskTitle ?? agent.recentLogs[0] ?? '正在推进当前任务',
      currentTaskTitle: agent.currentTaskTitle,
      thoughtSummary: agent.thoughtSummary,
      actionSummary: agent.actionSummary,
      recentLogs: agent.recentLogs,
      waitingFor: agent.waitingFor.map((id) => agentName(id)),
      activeCapabilityNames: agent.activeCapabilityNames,
      updatedAt: agent.updatedAt
    }))
)
const currentActivity = computed(() => {
  const activity = activeAgentActivities.value[0]
  if (!activity) return undefined
  return {
    ...activity,
    extraCount: Math.max(0, activeAgentActivities.value.length - 1)
  }
})
const discussionEvents = computed(() =>
  props.events.filter((event) => {
    const payload = event.metadata.payload as { round?: number; messageKind?: string; phase?: string } | undefined
    return event.type === 'agent_message' && (payload?.round || payload?.phase === 'discussion')
  })
)
const decisionEvents = computed(() =>
  props.events
    .filter((event) => {
      const payload = event.metadata.payload as { messageKind?: string } | undefined
      return event.type === 'agent_message' && ['decision', 'risk', 'handoff', 'summary'].includes(payload?.messageKind ?? '')
    })
    .slice(-4)
)
const discussionAgentCount = computed(() => new Set(discussionEvents.value.map((event) => event.fromAgentId).filter(Boolean)).size)
const discussionRoundCount = computed(() =>
  Math.max(
    0,
    ...discussionEvents.value.map((event) => {
      const round = (event.metadata.payload as { round?: number } | undefined)?.round
      return typeof round === 'number' ? round : 0
    })
  )
)
const acceptanceCoverage = computed(() => {
  const total = props.brief?.acceptanceCriteria.length ?? 0
  const matched = latestReview.value?.matchedItems?.length ?? 0
  const completed = latestDelivery.value?.completedItems?.length ?? 0
  return {
    total,
    proven: total ? Math.min(total, Math.max(matched, completed)) : 0
  }
})
const deliveryEvidence = computed(() => {
  const deliveryArtifactRefs = latestDelivery.value?.artifactRefs ?? latestDelivery.value?.artifactIds ?? []
  const taskArtifacts = props.tasks.flatMap((task) =>
    task.artifacts.map((artifact) => ({
      id: artifact.artifactId,
      label: `${task.title}: ${artifact.title}`,
      meta: `${artifact.type} / ${artifact.fileChangeCount} files`
    }))
  )
  const selectedTaskArtifacts = deliveryArtifactRefs.length ? taskArtifacts.filter((artifact) => deliveryArtifactRefs.includes(artifact.id)) : taskArtifacts
  return selectedTaskArtifacts.slice(0, 5)
})
const validationItems = computed(() => {
  const reviewTests = latestReview.value?.testResults ?? []
  const deliveryTests = latestDelivery.value?.testResults ?? []
  return [...reviewTests, ...deliveryTests].filter(Boolean).slice(0, 5)
})
const remainingRisks = computed(() => {
  const incomplete = latestDelivery.value?.incompleteItems ?? []
  const risks = latestDelivery.value?.risks ?? []
  const missing = latestReview.value?.missingItems ?? []
  const mismatched = latestReview.value?.mismatchedItems ?? []
  return [...incomplete, ...risks, ...missing, ...mismatched].filter(Boolean).slice(0, 5)
})

function agentName(agentId?: string) {
  return props.agents.find((agent) => agent.agentId === agentId)?.name ?? '未分配'
}

function waitingForLabel(waitingFor: string[]) {
  if (!waitingFor.length) return ''
  return waitingFor
    .map((entry) => {
      const matched = props.agents.find((agent) => agent.agentId === entry)
      return matched ? `等待 ${matched.name} 汇总` : entry
    })
    .join(' / ')
}

function suggestedAgentName(task: SuggestedAgentTask) {
  if (!task.suggestedAgentKey) return '未分配'
  return props.agents.find((agent) => agent.name === task.suggestedAgentKey || agent.role === task.suggestedAgentKey)?.name ?? task.suggestedAgentKey
}

function eventAgentName(event: CollaborationEvent) {
  return agentName(event.fromAgentId)
}

function taskTitle(taskId: string) {
  return props.tasks.find((task) => task.taskId === taskId)?.title ?? taskId
}

function messageKind(event: CollaborationEvent) {
  const kind = (event.metadata.payload as { messageKind?: string } | undefined)?.messageKind
  return kind ?? 'discussion'
}

function taskStatusLabel(status: TaskViewState['status']) {
  return (
    {
      pending: '待处理',
      assigned: '已分配',
      accepted: '已接受',
      claimed: '已接受',
      running: '执行中',
      waiting: '等待中',
      blocked: '阻塞中',
      reviewing: '评审中',
      rejected: '已驳回',
      cancelled: '已取消',
      completed: '已完成',
      failed: '失败',
      reworking: '返工中'
    }[status] ?? status
  )
}

function taskStatusTone(status: TaskViewState['status']) {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'rejected' || status === 'cancelled') return 'failed'
  if (status === 'waiting' || status === 'blocked') return 'waiting'
  if (status === 'running' || status === 'accepted' || status === 'claimed' || status === 'reviewing' || status === 'reworking') return 'running'
  return 'pending'
}

function agentActivityLabel(status: string) {
  return (
    {
      running: '正在执行',
      thinking: '正在思考',
      discussing: '正在讨论',
      reviewing: '正在复盘',
      reworking: '正在返工',
      waiting: '正在等待'
    }[status] ?? '正在处理'
  )
}

function formatActivityTime(value: string) {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}
</script>

<template>
  <section :class="['collaboration-task-board', { collapsed: isCollapsed }]" aria-label="协作计划面板">
    <header class="task-board-header">
      <div>
        <span>协作计划</span>
        <h2>{{ brief?.goal ?? '等待任务契约生成' }}</h2>
      </div>
      <div v-if="currentActivity" class="task-board-live-status-wrap">
        <button
          class="task-board-live-status"
          type="button"
          aria-controls="task-board-live-status-detail"
          :aria-expanded="isActivityDetailOpen"
          title="查看当前状态详情"
          @click="isActivityDetailOpen = !isActivityDetailOpen"
        >
          <span class="live-status-dot"></span>
          <span class="live-status-copy">
            <strong>{{ currentActivity.title }}</strong>
            <span>{{ currentActivity.detail }}</span>
          </span>
          <small v-if="currentActivity.extraCount">+{{ currentActivity.extraCount }} 个状态</small>
          <UiIcon name="chevron" :size="15" />
        </button>
        <div
          v-if="isActivityDetailOpen"
          id="task-board-live-status-detail"
          class="task-board-live-status-detail"
          role="dialog"
          aria-label="当前状态详情"
        >
          <header>
            <div>
              <strong>当前状态详情</strong>
              <span>{{ activeAgentActivities.length }} 个 Agent 正在处理</span>
            </div>
            <button type="button" title="收起状态详情" @click="isActivityDetailOpen = false">
              <UiIcon name="x" :size="15" />
            </button>
          </header>
          <article v-for="activity in activeAgentActivities" :key="activity.agentId" class="live-status-detail-item">
            <div class="live-status-detail-item__heading">
              <span class="live-status-dot"></span>
              <div>
                <strong>{{ activity.name }}{{ activity.statusText }}</strong>
                <small>{{ activity.role }} · {{ formatActivityTime(activity.updatedAt) }}</small>
              </div>
            </div>
            <p>{{ activity.detail }}</p>
            <dl>
              <div v-if="activity.currentTaskTitle">
                <dt>当前任务</dt>
                <dd>{{ activity.currentTaskTitle }}</dd>
              </div>
              <div v-if="activity.thoughtSummary">
                <dt>思考内容</dt>
                <dd>{{ activity.thoughtSummary }}</dd>
              </div>
              <div v-if="activity.actionSummary">
                <dt>执行内容</dt>
                <dd>{{ activity.actionSummary }}</dd>
              </div>
              <div v-if="activity.waitingFor.length">
                <dt>等待事项</dt>
                <dd>{{ waitingForLabel(activity.waitingFor) }}</dd>
              </div>
              <div v-if="activity.activeCapabilityNames.length">
                <dt>使用能力</dt>
                <dd>{{ activity.activeCapabilityNames.join(' / ') }}</dd>
              </div>
            </dl>
            <ul v-if="activity.recentLogs.length">
              <li v-for="log in activity.recentLogs" :key="`${activity.agentId}-${log}`">{{ log }}</li>
            </ul>
          </article>
        </div>
      </div>
      <div class="task-board-header-actions">
        <div class="task-board-progress">
          <strong>{{ progressPercent }}%</strong>
          <span><i :style="{ width: `${progressPercent}%` }"></i></span>
        </div>
        <button
          class="task-board-collapse-button"
          type="button"
          :aria-expanded="!isCollapsed"
          aria-controls="task-board-content"
          :title="isCollapsed ? '展开协作计划' : '收起协作计划'"
          @click="isCollapsed = !isCollapsed"
        >
          <UiIcon name="chevron" :size="17" />
          <span>{{ isCollapsed ? '展开' : '收起' }}</span>
        </button>
      </div>
    </header>

    <div v-show="!isCollapsed" id="task-board-content" class="task-board-content">
      <div class="task-board-summary">
        <article :class="{ active: activeConfirmation?.relatedBriefId }">
          <UiIcon name="message" :size="17" />
          <div>
            <strong>契约关口</strong>
            <span>{{ activeConfirmation?.relatedBriefId ? '等待用户确认' : brief ? '任务契约就绪' : '正在收集上下文' }}</span>
          </div>
        </article>
        <article>
          <UiIcon name="workflow" :size="17" />
          <div>
            <strong>任务</strong>
            <span>{{ tasks.length ? `已完成 ${completedTaskCount}/${tasks.length}，执行中 ${runningTaskCount}` : `建议 ${suggestedTasks.length} 项` }}</span>
          </div>
        </article>
        <article :class="{ active: waitingTaskCount || contextSupplementCount }">
          <UiIcon name="debug" :size="17" />
          <div>
            <strong>上下文</strong>
            <span>补充 {{ contextSupplementCount }} 项，等待 {{ waitingTaskCount }} 项</span>
          </div>
        </article>
        <article :class="{ active: interruptionCount }">
          <UiIcon name="alert" :size="17" />
          <div>
            <strong>变更打断</strong>
            <span>{{ interruptionCount ? `${interruptionCount} 个影响事件` : '暂无变更' }}</span>
          </div>
        </article>
        <article :class="{ completed: latestDelivery }">
          <UiIcon name="check" :size="17" />
          <div>
            <strong>交付</strong>
            <span>{{ latestDelivery ? '已生成' : reviewEvent ? '已评审' : '未就绪' }}</span>
          </div>
        </article>
      </div>

      <section class="task-board-discussion" aria-label="Discussion Evidence">
        <header>
          <h3>讨论证据</h3>
          <span>{{ discussionAgentCount }} 个 Agent · {{ discussionRoundCount }} 轮讨论</span>
        </header>
        <div class="task-board-discussion-list">
          <article v-for="event in decisionEvents" :key="event.id">
            <strong>{{ eventAgentName(event) }} · {{ messageKind(event) }}</strong>
            <p>{{ event.content }}</p>
          </article>
          <p v-if="!decisionEvents.length">Agent 的决策、风险、交接和总结会随着讨论推进显示在这里。</p>
        </div>
      </section>

      <section v-if="interruptionEvents.length" class="task-board-interruptions">
        <header>
          <h3>执行打断</h3>
          <span>用户变更已路由到执行中的工作</span>
        </header>
        <div class="task-board-interruption-list">
          <article v-for="item in interruptionEvents" :key="item.id">
            <header>
              <strong>{{ item.reason }}</strong>
              <span v-if="item.requiresBriefRevision">需要修订契约</span>
              <span v-else-if="item.shouldPause">已重新调度</span>
              <span v-else>已路由</span>
            </header>
            <p>{{ item.content }}</p>
            <div v-if="item.affectedAgentIds.length" class="task-board-chip-list">
              <strong>受影响 Agent</strong>
              <span v-for="agentId in item.affectedAgentIds.slice(0, 6)" :key="`${item.id}-${agentId}`">
                {{ agentName(agentId) }}
              </span>
            </div>
            <div v-if="item.affectedTaskIds.length" class="task-board-chip-list">
              <strong>受影响任务</strong>
              <span v-for="taskId in item.affectedTaskIds.slice(0, 6)" :key="`${item.id}-${taskId}`">
                {{ taskTitle(taskId) }}
              </span>
            </div>
          </article>
        </div>
      </section>

      <div class="task-board-body">
        <section class="task-board-brief" aria-label="Task Brief">
          <h3>任务契约</h3>
          <ConfirmationCard
            v-if="activeConfirmation?.relatedBriefId"
            :confirmation="activeConfirmation"
            compact
            @resolve="emit('resolveConfirmation', $event)"
          />
          <dl v-if="brief">
            <div>
              <dt>范围</dt>
              <dd>{{ brief.scope.slice(0, 3).join(' / ') || '-' }}</dd>
            </div>
            <div>
              <dt>验收标准</dt>
              <dd>{{ brief.acceptanceCriteria.slice(0, 3).join(' / ') || '-' }}</dd>
            </div>
            <div>
              <dt>风险</dt>
              <dd>{{ brief.risks.slice(0, 2).join(' / ') || '-' }}</dd>
            </div>
          </dl>
          <p v-else>暂未生成已确认的任务契约。</p>
        </section>

        <section class="task-board-tasks" aria-label="Task Decomposition">
          <h3>任务拆解</h3>
          <div class="task-board-task-list">
            <article v-for="task in tasks" :key="task.taskId" class="task-board-task">
              <header>
                <strong>{{ task.title }}</strong>
                <span :class="['task-board-status', taskStatusTone(task.status)]">{{ taskStatusLabel(task.status) }}</span>
              </header>
              <p>
                <span v-if="task.assignedByAgentId">由 {{ agentName(task.assignedByAgentId) }} 分配给 </span>{{ agentName(task.assigneeAgentId) }}
              </p>
              <small v-if="task.assignmentReason">分配理由：{{ task.assignmentReason }}</small>
              <small>路由模式：{{ task.routingMode ?? 'coordinator_controlled' }}</small>
              <small v-if="task.handoffSuggestion">
                建议交接：{{ task.handoffSuggestion.targetAgentKey ?? task.handoffSuggestion.targetAgentId ?? 'Coordinator' }} / {{ task.handoffSuggestion.reason }}
              </small>
              <small v-if="task.acceptanceCriteria.length">{{ task.acceptanceCriteria.slice(0, 2).join(' / ') }}</small>
              <small v-if="task.contextRequirements.length">上下文：{{ task.contextRequirements.slice(0, 3).join(' / ') }}</small>
              <small v-if="task.verificationPlan.length">验证：{{ task.verificationPlan.slice(0, 2).join(' / ') }}</small>
              <small v-if="task.riskNotes.length">风险：{{ task.riskNotes.slice(0, 2).join(' / ') }}</small>
              <small v-if="task.requiresUserConfirmation">执行前需要用户确认</small>
              <small v-if="task.resultSummary">{{ task.resultSummary }}</small>
              <footer v-if="task.artifacts.length">
                <span v-for="artifact in task.artifacts.slice(0, 3)" :key="artifact.artifactId">
                  {{ artifact.type }} / {{ artifact.fileChangeCount }} files
                </span>
              </footer>
            </article>
            <article v-for="(task, index) in suggestedTasks" :key="`suggested-${task.title}-${index}`" class="task-board-task suggested">
              <header>
                <strong>{{ task.title }}</strong>
                <span class="task-board-status pending" aria-label="Proposed">建议</span>
              </header>
              <p>{{ suggestedAgentName(task) }}</p>
              <small>{{ task.description }}</small>
              <small v-if="task.assignmentReason">分配理由：{{ task.assignmentReason }}</small>
              <small>路由模式：{{ task.routingMode ?? 'coordinator_controlled' }}</small>
              <small v-if="task.acceptanceCriteria.length">{{ task.acceptanceCriteria.slice(0, 2).join(' / ') }}</small>
              <small v-if="task.contextRequirements?.length">上下文：{{ task.contextRequirements.slice(0, 3).join(' / ') }}</small>
              <small v-if="task.verificationPlan?.length">验证：{{ task.verificationPlan.slice(0, 2).join(' / ') }}</small>
              <small v-if="task.riskNotes?.length">风险：{{ task.riskNotes.slice(0, 2).join(' / ') }}</small>
              <small v-if="task.requiresUserConfirmation">执行前需要用户确认</small>
              <footer v-if="task.dependsOnTaskTitles?.length">
                <span v-for="dependency in task.dependsOnTaskTitles.slice(0, 3)" :key="dependency">依赖 {{ dependency }}</span>
              </footer>
            </article>
            <p v-if="!tasks.length && !suggestedTasks.length" class="task-board-empty">任务会在契约草拟后显示。</p>
          </div>
        </section>

        <section class="task-board-delivery" aria-label="Review & Delivery">
          <h3>评审与交付</h3>
          <p>{{ latestDelivery?.summary ?? reviewEvent?.content ?? '等待执行证据。' }}</p>
          <div class="task-board-delivery-metrics">
            <article>
              <strong>{{ acceptanceCoverage.proven }}/{{ acceptanceCoverage.total }}</strong>
              <span>验收覆盖</span>
            </article>
            <article>
              <strong>{{ validationItems.length }}</strong>
              <span>验证信号</span>
            </article>
            <article :class="{ warning: remainingRisks.length }">
              <strong>{{ remainingRisks.length }}</strong>
              <span>未关闭风险</span>
            </article>
          </div>
          <div v-if="deliveryEvidence.length" class="task-board-evidence-list" aria-label="Delivery Evidence">
            <strong>交付证据</strong>
            <span v-for="artifact in deliveryEvidence" :key="artifact.id">
              {{ artifact.label }} / {{ artifact.meta }}
            </span>
          </div>
          <ul v-if="validationItems.length">
            <li v-for="item in validationItems" :key="item">{{ item }}</li>
          </ul>
          <ul v-else-if="latestDelivery?.completedItems?.length">
            <li v-for="item in latestDelivery.completedItems.slice(0, 4)" :key="item">{{ item }}</li>
          </ul>
          <div v-if="remainingRisks.length" class="task-board-risk-list" aria-label="Needs Attention">
            <strong>需要关注</strong>
            <span v-for="item in remainingRisks" :key="item">{{ item }}</span>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
