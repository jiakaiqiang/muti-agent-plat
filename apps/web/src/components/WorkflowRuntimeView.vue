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
  currentMode?: 'chat' | 'collaboration_graph' | 'workflow' | 'debug'
}>()

const emit = defineEmits<{
  switchView: [mode: 'chat' | 'collaboration_graph' | 'workflow' | 'debug']
}>()

type WorkflowStageKey = 'intake' | 'brief' | 'dispatch' | 'execution' | 'review'
type WorkflowStage = {
  key: WorkflowStageKey
  title: string
  agent: string
  points: string[]
  eventTypes: CollaborationEvent['type'][]
  eventPhases?: string[]
  successEventTypes: CollaborationEvent['type'][]
}

type WorkflowAgentEdge = {
  id: string
  fromAgentId: string
  toAgentId: string
  phase?: string
  kind?: string
}
type GraphPoint = { x: number; y: number }
type DragTarget =
  | { kind: 'node'; agentId: string }
  | { kind: 'edge'; edgeId: string; endpoint: 'from' | 'to' }
  | { kind: 'edge-line'; edgeId: string; origin: { from: GraphPoint; to: GraphPoint; pointer: GraphPoint } }

const selectedStageKey = ref<WorkflowStageKey>('intake')
const workflowScale = ref(1)
const workflowNodePositions = ref<Record<string, GraphPoint>>({})
const workflowEdgePositions = ref<Record<string, { from?: GraphPoint; to?: GraphPoint }>>({})
const workflowDragTarget = ref<DragTarget | undefined>()
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
    key: 'intake',
    title: '需求摄入',
    agent: 'Coordinator',
    points: ['用户下发需求', '识别影响范围', '召集 Agent 讨论'],
    eventTypes: ['user_message', 'agent_message', 'agent_status_changed'],
    eventPhases: ['requirement_intake', 'workspace_analysis', 'discussion'],
    successEventTypes: ['agent_message']
  },
  {
    key: 'brief',
    title: '任务契约',
    agent: 'Coordinator',
    points: ['形成讨论结论', '生成任务契约', '等待用户确认'],
    eventTypes: ['brief_created', 'brief_updated', 'user_confirmation_requested', 'user_confirmation_resolved', 'brief_confirmed', 'brief_rejected'],
    successEventTypes: ['brief_confirmed']
  },
  {
    key: 'dispatch',
    title: '分发接单',
    agent: 'Assigned Agents',
    points: ['创建任务池', 'Agent 接受任务', '依赖就绪后启动'],
    eventTypes: ['task_created', 'task_claimed', 'task_started', 'task_waiting', 'agent_message'],
    eventPhases: ['task_acceptance', 'task_claim_decision', 'task_claim_declined', 'task_handoff'],
    successEventTypes: ['task_claimed', 'task_started']
  },
  {
    key: 'execution',
    title: '执行产出',
    agent: 'Coding Agents',
    points: ['运行 Runtime', '生成产物', '记录文件变更'],
    eventTypes: [
      'runtime_started',
      'runtime_progress',
      'runtime_completed',
      'runtime_failed',
      'artifact_created',
      'tool_called',
      'tool_completed',
      'tool_failed',
      'memory_used',
      'session_status_changed',
      'agent_message'
    ],
    eventPhases: ['user_message_routing', 'agent_runtime_communication'],
    successEventTypes: ['runtime_completed', 'artifact_created']
  },
  {
    key: 'review',
    title: '复盘交付',
    agent: 'Review / Coordinator',
    points: ['对照任务契约', '决定交付或返工', '输出成果文档'],
    eventTypes: ['post_review_started', 'post_review_completed', 'task_reworked', 'final_delivery_created'],
    successEventTypes: ['post_review_completed', 'final_delivery_created']
  }
]

const visibleAgents = computed(() => props.agents.filter((agent) => agent.status !== 'disabled'))
const completedTaskCount = computed(() => props.tasks.filter((task) => task.status === 'completed').length)
const progressPercent = computed(() => {
  if (!props.tasks.length) return props.status === 'COMPLETED' ? 100 : 0
  return Math.round((completedTaskCount.value / props.tasks.length) * 100)
})
const selectedStage = computed(() => stages.find((stage) => stage.key === selectedStageKey.value) ?? stages[0])
const agentTasksById = computed(() => {
  const tasks = new Map<string, TaskViewState[]>()
  for (const task of props.tasks) {
    if (!task.assigneeAgentId) continue
    tasks.set(task.assigneeAgentId, [...(tasks.get(task.assigneeAgentId) ?? []), task])
  }
  return tasks
})
const workflowAgentNodes = computed(() =>
  visibleAgents.value.map((agent, index, agents) => {
    const assignedTasks = agentTasksById.value.get(agent.agentId) ?? []
    return {
      agent,
      index,
      tone: stageTone(index),
      position: workflowNodePositions.value[agent.agentId] ?? workflowNodePosition(index, agents.length),
      assignedTasks,
      completedTasks: assignedTasks.filter((task) => task.status === 'completed').length,
      latestTask: assignedTasks.at(-1)
    }
  })
)
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

function eventPhase(event: CollaborationEvent) {
  const payload = event.metadata.payload as { phase?: string } | undefined
  return payload?.phase
}

const workflowAgentEdges = computed<WorkflowAgentEdge[]>(() => {
  const agentIds = new Set(workflowAgentNodes.value.map((node) => node.agent.agentId))
  const messageEdges = props.events
    .filter((event) => event.type === 'agent_message' && event.fromAgentId)
    .flatMap((event) => {
      const payload = event.metadata.payload as { mentionedAgentIds?: string[]; phase?: string } | undefined
      const targets = Array.from(new Set([...(event.toAgentIds ?? []), ...(payload?.mentionedAgentIds ?? [])]))
      return targets
        .filter((targetId) => targetId && targetId !== event.fromAgentId && agentIds.has(targetId) && agentIds.has(event.fromAgentId!))
        .map((targetId) => ({
          id: `${event.id}:${targetId}`,
          fromAgentId: event.fromAgentId!,
          toAgentId: targetId,
          phase: payload?.phase,
          kind: 'message'
        }))
    })
    .slice(-24)

  const taskOwnerById = new Map<string, string>()
  const taskEdges: WorkflowAgentEdge[] = []
  const coordinatorId = workflowAgentNodes.value[0]?.agent.agentId
  for (const event of props.events) {
    const payload = event.metadata.payload as { taskId?: string; assigneeAgentId?: string; dependsOnTaskIds?: string[] } | undefined
    const taskId = payload?.taskId ?? event.taskId
    const assigneeAgentId = payload?.assigneeAgentId
    if (!taskId || !assigneeAgentId || !agentIds.has(assigneeAgentId)) continue
    taskOwnerById.set(taskId, assigneeAgentId)
    if (coordinatorId && coordinatorId !== assigneeAgentId && ['task_created', 'task_claimed', 'task_started', 'task_waiting'].includes(event.type)) {
      taskEdges.push({
        id: `${event.id}:${coordinatorId}:${assigneeAgentId}`,
        fromAgentId: coordinatorId,
        toAgentId: assigneeAgentId,
        phase: event.type === 'task_created' ? 'task_acceptance' : 'task_handoff',
        kind: 'task'
      })
    }
    for (const dependsOnTaskId of payload.dependsOnTaskIds ?? []) {
      const upstreamAgentId = taskOwnerById.get(dependsOnTaskId)
      if (!upstreamAgentId || upstreamAgentId === assigneeAgentId || !agentIds.has(upstreamAgentId)) continue
      taskEdges.push({
        id: `${event.id}:${upstreamAgentId}:${assigneeAgentId}:${dependsOnTaskId}`,
        fromAgentId: upstreamAgentId,
        toAgentId: assigneeAgentId,
        phase: 'task_handoff',
        kind: 'task'
      })
    }
  }

  const edges = [...messageEdges, ...taskEdges]
  const deduped = new Map<string, WorkflowAgentEdge>()
  for (const edge of edges) deduped.set(edge.id, edge)
  const selected = [...deduped.values()]
  const connected = new Set(selected.flatMap((edge) => [edge.fromAgentId, edge.toAgentId]))
  if (!selected.length && workflowAgentNodes.value.length < 2) return selected
  const fallback = workflowAgentNodes.value
    .slice(1)
    .filter((node) => !connected.has(node.agent.agentId))
    .map((node) => ({
    id: `fallback:${workflowAgentNodes.value[0].agent.agentId}:${node.agent.agentId}`,
    fromAgentId: workflowAgentNodes.value[0].agent.agentId,
    toAgentId: node.agent.agentId,
    kind: 'fallback'
  }))
  return [...selected, ...fallback]
})

function workflowNodePosition(index: number, total: number) {
  if (total <= 1) return { x: 50, y: 42 }
  const radiusX = total <= 4 ? 30 : 36
  const radiusY = total <= 4 ? 24 : 29
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total
  return {
    x: Math.round((50 + Math.cos(angle) * radiusX) * 10) / 10,
    y: Math.round((44 + Math.sin(angle) * radiusY) * 10) / 10
  }
}

function workflowNodeStyle(index: number, total: number) {
  const agent = workflowAgentNodes.value.find((node) => node.index === index)?.agent
  const position = agent ? (workflowNodePositions.value[agent.agentId] ?? workflowNodePosition(index, total)) : workflowNodePosition(index, total)
  return {
    left: `${position.x}%`,
    top: `${position.y}%`
  }
}

function workflowEdgePath(edge: WorkflowAgentEdge) {
  const from =
    workflowEdgePositions.value[edge.id]?.from ?? workflowAgentNodes.value.find((node) => node.agent.agentId === edge.fromAgentId)?.position
  const to =
    workflowEdgePositions.value[edge.id]?.to ?? workflowAgentNodes.value.find((node) => node.agent.agentId === edge.toAgentId)?.position
  if (!from || !to) return undefined
  return { ...from, x2: to.x, y2: to.y }
}

function workflowPointFromPointer(event: PointerEvent): GraphPoint | undefined {
  const target = event.currentTarget as HTMLElement | SVGElement
  const canvas = target.closest('.workflow-map')
  if (!canvas) return undefined
  const rect = canvas.getBoundingClientRect()
  return {
    x: Math.min(96, Math.max(4, ((event.clientX - rect.left) / rect.width) * 100)),
    y: Math.min(94, Math.max(6, ((event.clientY - rect.top) / rect.height) * 100))
  }
}

function moveWorkflowDragTarget(event: PointerEvent) {
  if (!workflowDragTarget.value) return
  const point = workflowPointFromPointer(event)
  if (!point) return
  if (workflowDragTarget.value.kind === 'node') {
    workflowNodePositions.value = { ...workflowNodePositions.value, [workflowDragTarget.value.agentId]: point }
    return
  }
  if (workflowDragTarget.value.kind === 'edge') {
    workflowEdgePositions.value = {
      ...workflowEdgePositions.value,
      [workflowDragTarget.value.edgeId]: {
        ...workflowEdgePositions.value[workflowDragTarget.value.edgeId],
        [workflowDragTarget.value.endpoint]: point
      }
    }
    return
  }
  if (workflowDragTarget.value.kind === 'edge-line') {
    const { edgeId, origin } = workflowDragTarget.value
    const deltaX = point.x - origin.pointer.x
    const deltaY = point.y - origin.pointer.y
    workflowEdgePositions.value = {
      ...workflowEdgePositions.value,
      [edgeId]: {
        from: {
          x: Math.min(96, Math.max(4, origin.from.x + deltaX)),
          y: Math.min(94, Math.max(6, origin.from.y + deltaY))
        },
        to: {
          x: Math.min(96, Math.max(4, origin.to.x + deltaX)),
          y: Math.min(94, Math.max(6, origin.to.y + deltaY))
        }
      }
    }
  }
}

function startWorkflowNodeDrag(event: PointerEvent, agentId: string) {
  workflowDragTarget.value = { kind: 'node', agentId }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  moveWorkflowDragTarget(event)
}

function startWorkflowEdgeDrag(event: PointerEvent, edgeId: string, endpoint: 'from' | 'to') {
  workflowDragTarget.value = { kind: 'edge', edgeId, endpoint }
  ;(event.currentTarget as SVGCircleElement).setPointerCapture(event.pointerId)
  moveWorkflowDragTarget(event)
}

function startWorkflowEdgeLineDrag(event: PointerEvent, edge: WorkflowAgentEdge) {
  const path = workflowEdgePath(edge)
  const point = workflowPointFromPointer(event)
  if (!path || !point) return
  workflowDragTarget.value = {
    kind: 'edge-line',
    edgeId: edge.id,
    origin: {
      from: { x: path.x, y: path.y },
      to: { x: path.x2, y: path.y2 },
      pointer: point
    }
  }
  ;(event.currentTarget as SVGLineElement).setPointerCapture(event.pointerId)
}

function stopWorkflowDrag() {
  workflowDragTarget.value = undefined
}

function stageEvents(stage: WorkflowStage) {
  return props.events.filter((event) => {
    if (!stage.eventTypes.includes(event.type)) return false
    if (event.type !== 'agent_message') return true
    return !stage.eventPhases?.length || stage.eventPhases.includes(eventPhase(event) ?? '')
  })
}

function stageSuccessEvents(stage: WorkflowStage) {
  return props.events.filter((event) => stage.successEventTypes.includes(event.type))
}

function stageState(stage: WorkflowStage) {
  if (stage.key === selectedStageKey.value) return 'selected'
  if (stage.key === 'review' && props.status === 'COMPLETED') return 'completed'
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

const selectedStageEvents = computed(() => [...stageEvents(selectedStage.value)].reverse())
const workflowKeySignals = computed(() => {
  const counts = {
    claim: 0,
    decline: 0,
    routing: 0,
    communication: 0,
    fileChanges: 0,
    delivery: 0
  }
  for (const event of props.events) {
    const phase = eventPhase(event)
    const payload = event.metadata.payload as { fileChanges?: unknown[] } | undefined
    if (phase === 'task_claim_decision' || phase === 'task_acceptance') counts.claim += 1
    if (phase === 'task_claim_declined') counts.decline += 1
    if (phase === 'user_message_routing') counts.routing += 1
    if (phase === 'agent_runtime_communication') counts.communication += 1
    counts.fileChanges += payload?.fileChanges?.length ?? 0
    if (event.type === 'final_delivery_created') counts.delivery += 1
  }
  return [
    { key: 'claim', label: '接单', value: counts.claim },
    { key: 'decline', label: '拒单转派', value: counts.decline },
    { key: 'routing', label: '补充路由', value: counts.routing },
    { key: 'communication', label: 'Agent 通信', value: counts.communication },
    { key: 'fileChanges', label: '文件变更', value: counts.fileChanges },
    { key: 'delivery', label: '最终交付', value: counts.delivery }
  ]
})

function workflowEventTitle(event: CollaborationEvent) {
  const phase = eventPhase(event)
  return phase ? `${event.type} / ${phase}` : event.type
}

function workflowEventMeta(event: CollaborationEvent) {
  const payload = event.metadata.payload as { fileChanges?: unknown[]; reason?: string; code?: string } | undefined
  const items: string[] = []
  const phase = eventPhase(event)
  if (phase) items.push(phase)
  if (payload?.reason) items.push(payload.reason)
  if (payload?.code) items.push(payload.code)
  const fileChangeCount = payload?.fileChanges?.length ?? 0
  if (fileChangeCount) items.push(`${fileChangeCount} file changes`)
  return items
}

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

const modeTabs: Array<{ mode: 'chat' | 'collaboration_graph' | 'workflow' | 'debug'; label: string; icon: string }> = [
  { mode: 'chat', label: '群聊', icon: 'message' },
  { mode: 'collaboration_graph', label: '协作图', icon: 'graph' },
  { mode: 'workflow', label: '流程图', icon: 'workflow' },
  { mode: 'debug', label: '调试', icon: 'debug' }
]
</script>

<template>
  <section class="flow-view workflow-cockpit">
    <header class="workflow-topbar">
      <h2>多 Agent 协同工作流</h2>
      <div class="workflow-mode-switcher" role="toolbar" aria-label="视图切换">
        <button
          v-for="mode in modeTabs"
          :key="mode.mode"
          type="button"
          :class="['mode-button', { active: currentMode === mode.mode }]"
          @click="emit('switchView', mode.mode)"
        >
          <UiIcon :name="mode.icon" :size="16" />
          {{ mode.label }}
        </button>
      </div>
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

        <div class="workflow-map zoom-viewport" @wheel.prevent="handleWorkflowWheel" @pointermove.prevent="moveWorkflowDragTarget" @pointerup="stopWorkflowDrag" @pointercancel="stopWorkflowDrag" @pointerleave="stopWorkflowDrag">
          <div class="zoom-content" :style="workflowZoomStyle">
            <article
            v-for="node in workflowAgentNodes"
            :key="node.agent.agentId"
            :class="['workflow-node', 'workflow-agent-node', `agent-tone-${node.tone}`, node.agent.status]"
            :style="workflowNodeStyle(node.index, workflowAgentNodes.length)"
            @pointerdown.prevent="startWorkflowNodeDrag($event, node.agent.agentId)"
            >
            <header>
              <AgentPortrait :tone="node.tone" :label="node.agent.name" size="sm" />
              <span>{{ node.index + 1 }}</span>
              <div>
                <h4>{{ node.agent.name }}</h4>
                <p>{{ statusLabel(node.agent.status) }}</p>
              </div>
            </header>
            <ul>
              <li>{{ node.latestTask?.title ?? node.agent.currentTaskTitle ?? node.agent.actionSummary ?? '等待任务分配' }}</li>
              <li>任务 {{ node.completedTasks }}/{{ node.assignedTasks.length }}</li>
              <li>{{ node.agent.recentLogs[0] ?? node.agent.role }}</li>
            </ul>
            </article>

            <svg class="workflow-agent-links editable-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <template v-for="edge in workflowAgentEdges" :key="edge.id">
                <line
                  v-if="workflowEdgePath(edge)"
                  :x1="workflowEdgePath(edge)?.x"
                  :y1="workflowEdgePath(edge)?.y"
                  :x2="workflowEdgePath(edge)?.x2"
                  :y2="workflowEdgePath(edge)?.y2"
                  :class="['edge-drag-line', { highlighted: edge.phase === 'agent_runtime_communication' || edge.phase === 'user_message_routing' }]"
                  @pointerdown.stop.prevent="startWorkflowEdgeLineDrag($event, edge)"
                />
                <circle
                  v-if="workflowEdgePath(edge)"
                  class="edge-drag-handle"
                  :cx="workflowEdgePath(edge)?.x"
                  :cy="workflowEdgePath(edge)?.y"
                  r="1.5"
                  @pointerdown.stop.prevent="startWorkflowEdgeDrag($event, edge.id, 'from')"
                  @pointermove.prevent="moveWorkflowDragTarget"
                  @pointerup="stopWorkflowDrag"
                  @pointercancel="stopWorkflowDrag"
                />
                <circle
                  v-if="workflowEdgePath(edge)"
                  class="edge-drag-handle"
                  :cx="workflowEdgePath(edge)?.x2"
                  :cy="workflowEdgePath(edge)?.y2"
                  r="1.5"
                  @pointerdown.stop.prevent="startWorkflowEdgeDrag($event, edge.id, 'to')"
                  @pointermove.prevent="moveWorkflowDragTarget"
                  @pointerup="stopWorkflowDrag"
                  @pointercancel="stopWorkflowDrag"
                />
              </template>
            </svg>

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

        <section class="workflow-signal-strip">
          <article v-for="signal in workflowKeySignals" :key="signal.key">
            <span>{{ signal.label }}</span>
            <strong>{{ signal.value }}</strong>
          </article>
        </section>

        <section class="workflow-stage-events">
          <header>
            <h3>{{ selectedStage.title }}事件</h3>
            <span>{{ selectedStageEvents.length }} 条</span>
          </header>
          <article v-for="event in selectedStageEvents" :key="event.id">
            <strong>{{ workflowEventTitle(event) }}</strong>
            <div v-if="workflowEventMeta(event).length" class="workflow-event-meta">
              <span v-for="item in workflowEventMeta(event)" :key="item">{{ item }}</span>
            </div>
            <p>{{ event.content }}</p>
          </article>
          <p v-if="!selectedStageEvents.length">当前阶段还没有事件。</p>
        </section>
      </main>
    </div>
  </section>
</template>
