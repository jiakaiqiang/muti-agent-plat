<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  ArtifactEventPayload,
  CollaborationEvent,
  ConfirmationCardState,
  SessionStatus,
  TaskViewState,
  ToolEventPayload
} from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'

const props = defineProps<{
  events: CollaborationEvent[]
  tasks: TaskViewState[]
  activeConfirmation?: ConfirmationCardState
  status?: SessionStatus
}>()

type WorkflowStageKey = 'brief' | 'confirm' | 'execute' | 'review' | 'delivery'
type WorkflowStage = {
  key: WorkflowStageKey
  title: string
  subtitle: string
  eventTypes: CollaborationEvent['type'][]
}

const selectedStageKey = ref<WorkflowStageKey>('execute')
const selectedTaskId = ref<string>()
const workflowScale = ref(1)
const workflowPan = ref({ x: 0, y: 0 })
const isPanning = ref(false)
const suppressStageClick = ref(false)
let panStart = { x: 0, y: 0, panX: 0, panY: 0 }

const stages: WorkflowStage[] = [
  {
    key: 'brief',
    title: '任务理解',
    subtitle: '目标、范围、风险',
    eventTypes: ['user_message', 'agent_message', 'brief_created', 'brief_updated']
  },
  {
    key: 'confirm',
    title: '用户确认',
    subtitle: '契约确认与决策',
    eventTypes: ['user_confirmation_requested', 'user_confirmation_resolved', 'brief_confirmed', 'brief_rejected']
  },
  {
    key: 'execute',
    title: '执行流转',
    subtitle: '任务、工具、产物',
    eventTypes: [
      'task_created',
      'task_claimed',
      'task_started',
      'task_waiting',
      'task_completed',
      'task_reworked',
      'runtime_started',
      'runtime_progress',
      'runtime_completed',
      'runtime_failed',
      'tool_called',
      'tool_completed',
      'tool_failed',
      'artifact_created'
    ]
  },
  {
    key: 'review',
    title: '复盘检查',
    subtitle: '一致性与风险',
    eventTypes: ['post_review_started', 'post_review_completed']
  },
  {
    key: 'delivery',
    title: '结果交付',
    subtitle: '总结与通知',
    eventTypes: ['final_delivery_created']
  }
]

const selectedStage = computed(() => stages.find((stage) => stage.key === selectedStageKey.value) ?? stages[0])
const selectedStageEvents = computed(() =>
  props.events.filter((event) => selectedStage.value.eventTypes.includes(event.type)).slice(-8).reverse()
)
const completedTaskCount = computed(() => props.tasks.filter((task) => task.status === 'completed').length)
const progressPercent = computed(() => {
  if (!props.tasks.length) return props.status === 'COMPLETED' ? 100 : 0
  return Math.round((completedTaskCount.value / props.tasks.length) * 100)
})
const selectedTask = computed(() => props.tasks.find((task) => task.taskId === selectedTaskId.value) ?? props.tasks[0])
const workflowTransform = computed(() => ({
  transform: `translate(${workflowPan.value.x}px, ${workflowPan.value.y}px) scale(${workflowScale.value})`
}))

function eventCount(stage: WorkflowStage) {
  return props.events.filter((event) => stage.eventTypes.includes(event.type)).length
}

function stageState(stage: WorkflowStage) {
  const count = eventCount(stage)
  if (stage.key === selectedStageKey.value) return 'selected'
  if (stage.key === 'confirm' && props.activeConfirmation) return 'active'
  if (stage.key === 'delivery' && props.status === 'COMPLETED') return 'completed'
  if (count > 0) return ['delivery', 'review'].includes(stage.key) ? 'completed' : 'active'
  return 'pending'
}

function stageTone(index: number) {
  return ((index % 5) + 1) as 1 | 2 | 3 | 4 | 5
}

function stageColor(index: number) {
  return ['#155eef', '#10b981', '#8b5cf6', '#f59e0b', '#0891b2'][index % 5]
}

function eventPayload<T extends Record<string, unknown>>(event: CollaborationEvent) {
  return (event.metadata.payload ?? {}) as T
}

function eventBadge(event: CollaborationEvent) {
  if (event.type.startsWith('tool_')) {
    return eventPayload<ToolEventPayload>(event).status ?? event.type
  }
  if (event.type === 'artifact_created') {
    return eventPayload<ArtifactEventPayload>(event).type ?? event.type
  }
  return event.type
}

function eventDetail(event: CollaborationEvent) {
  if (event.type.startsWith('tool_')) {
    const payload = eventPayload<ToolEventPayload>(event)
    return [payload.capabilityName, payload.riskLevel, payload.code].filter(Boolean).join(' / ')
  }
  if (event.type === 'artifact_created') {
    const payload = eventPayload<ArtifactEventPayload>(event)
    return [payload.title, payload.contentSummary].filter(Boolean).join(' / ')
  }
  return event.content
}

function clampScale(value: number) {
  return Math.min(1.8, Math.max(0.58, Number(value.toFixed(2))))
}

function zoomWorkflow(delta: number) {
  workflowScale.value = clampScale(workflowScale.value + delta)
}

function resetWorkflowView() {
  workflowScale.value = 1
  workflowPan.value = { x: 0, y: 0 }
}

function handleWorkflowWheel(event: WheelEvent) {
  const direction = event.deltaY > 0 ? -0.08 : 0.08
  zoomWorkflow(direction)
}

function startWorkflowPan(event: PointerEvent) {
  if (event.button !== 0) return
  isPanning.value = true
  suppressStageClick.value = false
  panStart = {
    x: event.clientX,
    y: event.clientY,
    panX: workflowPan.value.x,
    panY: workflowPan.value.y
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function moveWorkflowPan(event: PointerEvent) {
  if (!isPanning.value) return
  const dx = event.clientX - panStart.x
  const dy = event.clientY - panStart.y
  if (Math.abs(dx) + Math.abs(dy) > 4) suppressStageClick.value = true
  workflowPan.value = {
    x: panStart.panX + dx,
    y: panStart.panY + dy
  }
}

function endWorkflowPan(event: PointerEvent) {
  if (!isPanning.value) return
  isPanning.value = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  if (suppressStageClick.value) {
    window.setTimeout(() => {
      suppressStageClick.value = false
    }, 0)
  }
}

function selectStage(stageKey: WorkflowStageKey) {
  if (suppressStageClick.value) return
  selectedStageKey.value = stageKey
}
</script>

<template>
  <section class="flow-view workflow-cockpit">
    <header class="workflow-topbar">
      <div>
        <h2>工作流视图</h2>
        <p>阶段拓扑、任务节点和阶段事件保持同步，可拖拽缩放查看全局流程。</p>
      </div>
      <span class="status-pill">{{ progressPercent }}% 完成</span>
    </header>

    <div class="workflow-layout">
      <aside class="workflow-agent-rail" aria-label="任务队列">
        <h3>任务队列</h3>
        <button
          v-for="(task, index) in tasks"
          :key="task.taskId"
          type="button"
          :class="['workflow-agent-card', { selected: selectedTask?.taskId === task.taskId }]"
          :style="{ '--agent': stageColor(index) }"
          @click="selectedTaskId = task.taskId"
        >
          <AgentPortrait :tone="stageTone(index)" :label="task.title" size="md" />
          <strong>{{ task.title }}</strong>
          <small>{{ task.assigneeAgentId ?? '待分配' }}</small>
          <em>{{ task.status }}</em>
        </button>
        <p v-if="!tasks.length" class="empty-state">暂无任务节点</p>
      </aside>

      <main class="workflow-canvas" aria-label="工作流拓扑">
        <header>
          <h3>阶段拓扑</h3>
          <div class="canvas-toolbar" aria-label="工作流画布控制">
            <button type="button" @click="zoomWorkflow(0.1)">+</button>
            <span>{{ Math.round(workflowScale * 100) }}%</span>
            <button type="button" @click="zoomWorkflow(-0.1)">-</button>
            <button type="button" @click="resetWorkflowView">复位</button>
          </div>
        </header>

        <div
          :class="['workflow-map', 'pan-zoom-viewport', { dragging: isPanning }]"
          @pointerdown="startWorkflowPan"
          @pointermove="moveWorkflowPan"
          @pointerup="endWorkflowPan"
          @pointercancel="endWorkflowPan"
          @wheel.prevent="handleWorkflowWheel"
        >
          <div class="pan-zoom-content" :style="workflowTransform">
            <button
              v-for="(stage, index) in stages"
              :key="stage.key"
              type="button"
              :class="['workflow-node', `workflow-node-${index + 1}`, stageState(stage)]"
              :style="{ '--agent': stageColor(index) }"
              @click="selectStage(stage.key)"
            >
              <span class="agent-node-icon">{{ index + 1 }}</span>
              <h4>{{ stage.title }}</h4>
              <p>{{ stage.subtitle }}</p>
              <ul>
                <li>{{ eventCount(stage) }} 个关联事件</li>
                <li v-if="stage.key === 'confirm' && activeConfirmation">等待用户确认</li>
              </ul>
            </button>

            <article class="workflow-hub">
              <AgentPortrait tone="system" label="编排器" size="md" />
              <strong>Orchestrator</strong>
              <small>{{ status ?? 'DRAFT_INPUT' }}</small>
            </article>

            <article class="workflow-output">
              <span class="check-mark" aria-hidden="true"></span>
              <h4>{{ selectedTask?.title ?? '结果交付' }}</h4>
              <p>{{ selectedTask?.resultSummary ?? '任务完成后将在这里汇总产物、结论和待处理风险。' }}</p>
            </article>
          </div>
        </div>

        <section class="workflow-progress-strip" aria-label="阶段进度">
          <h3>阶段进度</h3>
          <button
            v-for="(stage, index) in stages"
            :key="stage.key"
            type="button"
            :class="['workflow-stage-chip', stageState(stage)]"
            @click="selectStage(stage.key)"
          >
            <span>{{ index + 1 }}</span>
            <strong>{{ stage.title }}</strong>
            <small>{{ eventCount(stage) }} 个事件</small>
          </button>
        </section>
      </main>

      <aside class="workflow-event-panel" aria-label="阶段事件">
        <header>
          <div>
            <h3>阶段事件</h3>
            <p>{{ selectedStage.title }} · {{ eventCount(selectedStage) }} 个事件</p>
          </div>
          <span class="status-pill">{{ selectedStage.subtitle }}</span>
        </header>

        <div class="workflow-event-tabs">
          <button
            v-for="(stage, index) in stages"
            :key="stage.key"
            :class="['workflow-event-tab', stageState(stage)]"
            type="button"
            @click="selectStage(stage.key)"
          >
            <span>{{ index + 1 }}</span>
            <strong>{{ stage.title }}</strong>
            <small>{{ eventCount(stage) }}</small>
          </button>
        </div>

        <div class="workflow-event-timeline">
          <article v-for="event in selectedStageEvents" :key="event.id" class="workflow-event-card">
            <div class="workflow-event-card__top">
              <strong>{{ event.metadata.title ?? event.type }}</strong>
              <time>{{ new Date(event.createdAt).toLocaleTimeString() }}</time>
            </div>
            <p>{{ event.content }}</p>
            <p class="workflow-event-card__detail">{{ eventBadge(event) }} · {{ eventDetail(event) }}</p>
          </article>
          <p v-if="!selectedStageEvents.length" class="empty-state">暂无阶段事件</p>
        </div>
      </aside>
    </div>
  </section>
</template>
