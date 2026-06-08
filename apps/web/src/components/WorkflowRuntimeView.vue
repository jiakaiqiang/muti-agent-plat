<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentCardState, CollaborationEvent, ConfirmationCardState, SessionStatus, TaskViewState } from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  events: CollaborationEvent[]
  tasks: TaskViewState[]
  agents: AgentCardState[]
  activeConfirmation?: ConfirmationCardState
  status?: SessionStatus
  sessionTitle?: string
}>()

type WorkflowStageKey = 'requirements' | 'strategy' | 'creative' | 'data' | 'execution'
type WorkflowStage = {
  key: WorkflowStageKey
  title: string
  agent: string
  points: string[]
  eventTypes: CollaborationEvent['type'][]
  successEventTypes: CollaborationEvent['type'][]
}

const selectedStageKey = ref<WorkflowStageKey>('requirements')
const workflowScale = ref(1)
const workflowZoomStyle = computed(() => ({
  transform: `scale(${workflowScale.value})`
}))
const workflowZoomLabel = computed(() => `${Math.round(workflowScale.value * 100)}%`)

function clampZoom(value: number) {
  return Math.min(1.8, Math.max(0.6, Number(value.toFixed(2))))
}

function zoomWorkflow(delta: number) {
  workflowScale.value = clampZoom(workflowScale.value + delta)
}

function resetWorkflowZoom() {
  workflowScale.value = 1
}

function handleWorkflowWheel(event: WheelEvent) {
  zoomWorkflow(event.deltaY > 0 ? -0.08 : 0.08)
}

const stages: WorkflowStage[] = [
  {
    key: 'requirements',
    title: '需求分析',
    agent: 'Agent 01',
    points: ['收集需求', '目标拆解', '明确约束'],
    eventTypes: ['user_message', 'agent_message', 'brief_created', 'brief_updated'],
    successEventTypes: ['brief_created', 'brief_updated']
  },
  {
    key: 'strategy',
    title: '策略规划',
    agent: 'Agent 02',
    points: ['制定总体策略', '渠道规划', '资源分配'],
    eventTypes: ['user_confirmation_requested', 'user_confirmation_resolved', 'brief_confirmed', 'brief_rejected'],
    successEventTypes: ['brief_confirmed']
  },
  {
    key: 'creative',
    title: '内容创意',
    agent: 'Agent 03',
    points: ['创意构思', '文案撰写', '素材建议'],
    eventTypes: ['task_created', 'task_claimed', 'task_started', 'task_waiting'],
    successEventTypes: ['task_started']
  },
  {
    key: 'data',
    title: '数据分析',
    agent: 'Agent 04',
    points: ['数据建模', '效果预测', '风险评估'],
    eventTypes: ['runtime_started', 'runtime_progress', 'runtime_completed', 'runtime_failed', 'post_review_started', 'post_review_completed'],
    successEventTypes: ['runtime_completed', 'post_review_completed']
  },
  {
    key: 'execution',
    title: '执行跟进',
    agent: 'Agent 05',
    points: ['执行计划制定', '进度跟踪', '成果汇报'],
    eventTypes: ['tool_called', 'tool_completed', 'tool_failed', 'artifact_created', 'final_delivery_created'],
    successEventTypes: ['artifact_created', 'final_delivery_created']
  }
]

const visibleAgents = computed(() => props.agents.slice(0, 5))
const completedTaskCount = computed(() => props.tasks.filter((task) => task.status === 'completed').length)
const progressPercent = computed(() => {
  if (!props.tasks.length) return props.status === 'COMPLETED' ? 100 : 0
  return Math.round((completedTaskCount.value / props.tasks.length) * 100)
})
const selectedStage = computed(() => stages.find((stage) => stage.key === selectedStageKey.value) ?? stages[0])
const outputTitle = computed(() => {
  const delivery = [...props.events].reverse().find((event) => event.type === 'final_delivery_created')
  return delivery?.content ?? 'Awaiting final delivery'
})
const outputSummary = computed(() => {
  const delivery = [...props.events].reverse().find((event) => event.type === 'final_delivery_created')
  const payload = delivery?.metadata.payload as { summary?: string; completedItems?: string[] } | undefined
  return payload?.summary ?? payload?.completedItems?.join(' / ') ?? 'No delivery artifact has been created yet.'
})

function stageTone(index: number) {
  return ((index % 5) + 1) as 1 | 2 | 3 | 4 | 5
}

function stageEvents(stage: WorkflowStage) {
  return props.events.filter((event) => stage.eventTypes.includes(event.type))
}

function stageSuccessEvents(stage: WorkflowStage) {
  return props.events.filter((event) => stage.successEventTypes.includes(event.type))
}

function stageState(stage: WorkflowStage) {
  if (stage.key === selectedStageKey.value) return 'selected'
  if (stage.key === 'execution' && props.status === 'COMPLETED') return 'completed'
  if (stageSuccessEvents(stage).length > 0) return 'completed'
  if (stageEvents(stage).length > 0) return 'active'
  return 'pending'
}

function stageStatusText(stage: WorkflowStage) {
  const state = stageState(stage)
  if (state === 'completed') return '已成功'
  if (state === 'selected' || state === 'active') return '进行中'
  return '等待中'
}

const finalOutputCompleted = computed(() =>
  props.status === 'COMPLETED' || props.events.some((event) => event.type === 'final_delivery_created')
)

function statusLabel(status?: string) {
  return (
    {
      idle: '等待中',
      running: '正在执行',
      thinking: '正在执行',
      discussing: '正在执行',
      waiting: '等待中',
      reviewing: '正在执行',
      reworking: '正在执行',
      completed: '已完成',
      failed: '阻塞中',
      disabled: '等待中'
    }[status ?? ''] ?? '等待中'
  )
}
</script>

<template>
  <section class="flow-view workflow-cockpit">
    <header class="workflow-topbar">
      <h2>多 Agent 协同工作流</h2>
      <span class="project-chip">会话：{{ sessionTitle ?? 'No active session' }}</span>
      <span class="progress-chip">
        整体进度
        <strong>{{ progressPercent }}%</strong>
        <span><i :style="{ width: `${progressPercent}%` }"></i></span>
      </span>
      <span class="session-state online">运行中</span>
      <span class="graph-clock">运行时长 00:18:42</span>
    </header>

    <div class="workflow-layout">
      <aside class="workflow-agent-rail" aria-label="Agents">
        <h3>Agents</h3>
        <button
          v-for="(agent, index) in visibleAgents"
          :key="agent.agentId"
          type="button"
          :class="['workflow-agent-card', `agent-tone-${stageTone(index)}`, { selected: index === 0 }]"
        >
          <AgentPortrait :tone="stageTone(index)" :label="agent.name" size="md" />
          <strong><span>{{ String(index + 1).padStart(2, '0') }}</span>{{ stages[index]?.title ?? agent.name }}</strong>
          <small>{{ statusLabel(agent.status) }}</small>
        </button>

        <section class="workflow-status-legend">
          <h3>状态说明</h3>
          <span><i class="dot-blue"></i>正在执行</span>
          <span><i class="dot-wait"></i>等待中</span>
          <span><i class="dot-green"></i>已完成</span>
          <span><i class="dot-red"></i>阻塞中</span>
        </section>
      </aside>

      <main class="workflow-canvas">
        <header>
          <h3>工作流可视化</h3>
          <div class="workflow-view-control">
            <span>视图：工作流</span>
            <button type="button" data-zoom="out" aria-label="缩小工作流图" @click="zoomWorkflow(-0.1)">-</button>
            <strong>{{ workflowZoomLabel }}</strong>
            <button type="button" data-zoom="in" aria-label="放大工作流图" @click="zoomWorkflow(0.1)">+</button>
            <button type="button" data-zoom="reset" aria-label="重置工作流图缩放" @click="resetWorkflowZoom">复位</button>
          </div>
        </header>

        <div class="workflow-map zoom-viewport" @wheel.prevent="handleWorkflowWheel">
          <div class="zoom-content" :style="workflowZoomStyle">
            <article
            v-for="(stage, index) in stages"
            :key="stage.key"
            :class="['workflow-node', `workflow-node-${index + 1}`, `agent-tone-${stageTone(index)}`, stageState(stage)]"
            @click="selectedStageKey = stage.key"
            >
            <header>
              <AgentPortrait :tone="stageTone(index)" :label="stage.title" size="sm" />
              <span>{{ index + 1 }}</span>
              <div>
                <h4>{{ stage.title }}</h4>
                <p>{{ stage.agent }}</p>
              </div>
            </header>
            <ul>
              <li v-for="point in stage.points" :key="point">{{ point }}</li>
            </ul>
            </article>

            <article class="workflow-hub">
            <span class="brand-mark mini" aria-hidden="true"><i v-for="index in 6" :key="index"></i></span>
            <strong>协同中</strong>
            <small>实时通信</small>
            </article>

            <article class="workflow-output">
            <span class="check-mark"></span>
            <h4>{{ outputTitle }}</h4>
            <p>{{ outputSummary }}</p>
            </article>

            <span class="workflow-arrow arrow-1"></span>
            <span class="workflow-arrow arrow-2"></span>
            <span class="workflow-arrow arrow-3"></span>
            <span class="workflow-arrow arrow-4"></span>
            <span class="workflow-arrow arrow-5"></span>
          </div>
        </div>

        <section class="workflow-progress-strip" aria-label="工作流进度">
          <h3>工作流进度</h3>
          <button
            v-for="(stage, index) in stages"
            :key="stage.key"
            type="button"
            :class="['workflow-stage-chip', stageState(stage)]"
            @click="selectedStageKey = stage.key"
          >
            <span>{{ index + 1 }}</span>
            <strong>{{ stage.title }}</strong>
            <small>{{ stageStatusText(stage) }}</small>
          </button>
          <button class="workflow-stage-chip final-output" :class="{ completed: finalOutputCompleted }" type="button">
            <UiIcon name="check" :size="18" />
            <strong>最终输出</strong>
            <small>{{ finalOutputCompleted ? '已成功' : '待完成' }}</small>
          </button>
        </section>
      </main>
    </div>
  </section>
</template>
