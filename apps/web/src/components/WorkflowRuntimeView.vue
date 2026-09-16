<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { actorAgentId } from '@/composables/useActor'
import { useAgentStore } from '@/stores/agent'
import { useWorkspaceUiStore, type WorkflowStageKey } from '@/stores/workspaceUi'
import { applicableArtifactFileChanges } from './artifactFileChangeModel'
import {
  buildWorkflowChain,
  discussionRounds,
  workflowChainEdges,
  type WorkflowChainEdgeInput,
  type WorkflowChainState
} from './workflowChainModel'
import type { ActorRef, AgentCardState, ArtifactEventPayload, CollaborationEvent, ConfirmationCardState, SessionStatus, TaskViewState } from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import UiIcon from './UiIcon.vue'
import WorkflowAgentInspector from './WorkflowAgentInspector.vue'

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

type WorkflowStage = {
  key: WorkflowStageKey
  title: string
  agent: string
  points: string[]
  eventTypes: CollaborationEvent['type'][]
  eventPhases?: string[]
  successEventTypes: CollaborationEvent['type'][]
}

type GraphPoint = { x: number; y: number }

const agentStore = useAgentStore()
const workspaceUiStore = useWorkspaceUiStore()
const { selectedWorkflowStage: selectedStageKey } = storeToRefs(workspaceUiStore)
const workflowScale = ref(1)
const workflowNodePositions = ref<Record<string, GraphPoint>>({})
const draggingAgentId = ref<string | undefined>()
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
    title: '分发接受',
    agent: 'Assigned Agents',
    points: ['创建任务池', 'Agent 接受任务', '依赖就绪后启动'],
    eventTypes: ['task_created', 'task_assigned', 'task_accepted', 'task_claimed', 'task_blocked', 'task_reassigned', 'task_started', 'task_waiting', 'task_rejected', 'agent_message'],
    eventPhases: ['task_acceptance', 'task_acceptance_decision', 'task_acceptance_blocked', 'task_handoff'],
    successEventTypes: ['task_accepted', 'task_claimed', 'task_started']
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
      'task_failed',
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

const completedTaskCount = computed(() => props.tasks.filter((task) => task.status === 'completed').length)
const progressPercent = computed(() => {
  if (!props.tasks.length) return props.status === 'COMPLETED' ? 100 : 0
  return Math.round((completedTaskCount.value / props.tasks.length) * 100)
})
const selectedStage = computed(() => stages.find((stage) => stage.key === selectedStageKey.value) ?? stages[0])

const systemAgentIds = computed(() =>
  agentStore.agents.filter((agent) => agent.management?.systemRole).map((agent) => agent.id)
)

/**
 * The ordered Agent chain. All state derivation lives in workflowChainModel so it
 * stays testable and this component only lays out and renders.
 */
const chain = computed(() =>
  buildWorkflowChain({
    events: props.events,
    tasks: props.tasks,
    agents: props.agents.filter((agent) => agent.status !== 'disabled'),
    resolveName: (agentId: string) => {
      const name = agentStore.agentName(agentId)
      return name === agentId ? '' : name
    },
    systemAgentIds: systemAgentIds.value
  })
)

const chainNodes = computed(() =>
  chain.value.map((node, index, nodes) => ({
    ...node,
    index,
    position: workflowNodePositions.value[node.agentId] ?? workflowNodePosition(index, nodes.length)
  }))
)

const selectedAgentId = ref('')
const selectedNode = computed(() => chainNodes.value.find((node) => node.agentId === selectedAgentId.value))

function selectChainNode(agentId: string) {
  selectedAgentId.value = selectedAgentId.value === agentId ? '' : agentId
}

function stateLabel(state: WorkflowChainState) {
  return { done: '已执行', active: '执行中', pending: '未执行' }[state]
}

/**
 * Discussion content shown below the canvas, grouped by round.
 *
 * Keyed on `round` rather than `phase`: the orchestrator emits discussion
 * agent_message without a phase, so a phase-based filter renders nothing.
 */
const discussion = computed(() =>
  discussionRounds(props.events, (agentId: string) => {
    const name = agentStore.agentName(agentId)
    return name === agentId ? '' : name
  })
)
const discussionMessageCount = computed(() =>
  discussion.value.reduce((total, round) => total + round.messages.length, 0)
)

function eventPhase(event: CollaborationEvent) {
  const payload = event.metadata.payload as { phase?: string } | undefined
  return payload?.phase
}

/** Raw edge candidates. Pulse eligibility is decided by the model, not here. */
const edgeCandidates = computed<WorkflowChainEdgeInput[]>(() => {
  const agentIds = new Set(chainNodes.value.map((node) => node.agentId))
  const messageEdges = props.events
    .filter((event) => event.type === 'agent_message' && actorAgentId(event.actor))
    .flatMap((event) => {
      const fromAgentId = actorAgentId(event.actor)!
      const payload = event.metadata.payload as { mentionedAgentIds?: string[]; phase?: string } | undefined
      const targets = Array.from(new Set([...(event.toAgentIds ?? []), ...(payload?.mentionedAgentIds ?? [])]))
      return targets
        .filter((targetId) => targetId && targetId !== fromAgentId && agentIds.has(targetId) && agentIds.has(fromAgentId))
        .map((targetId) => ({
          id: `${event.id}:${targetId}`,
          fromAgentId,
          toAgentId: targetId,
          phase: payload?.phase,
          kind: 'message'
        }))
    })
    .slice(-24)

  const taskOwnerById = new Map<string, string>()
  const taskEdges: WorkflowChainEdgeInput[] = []
  const headAgentId = chainNodes.value[0]?.agentId
  for (const event of props.events) {
    const payload = event.metadata.payload as { taskId?: string; assignee?: ActorRef; dependsOnTaskIds?: string[] } | undefined
    const taskId = payload?.taskId ?? event.taskId
    const assigneeId = actorAgentId(payload?.assignee)
    if (!taskId || !assigneeId || !agentIds.has(assigneeId)) continue
    taskOwnerById.set(taskId, assigneeId)
    if (
      headAgentId &&
      headAgentId !== assigneeId &&
      ['task_created', 'task_assigned', 'task_accepted', 'task_claimed', 'task_blocked', 'task_reassigned', 'task_started', 'task_waiting'].includes(event.type)
    ) {
      taskEdges.push({
        id: `${event.id}:${headAgentId}:${assigneeId}`,
        fromAgentId: headAgentId,
        toAgentId: assigneeId,
        phase: event.type === 'task_created' || event.type === 'task_assigned' ? 'task_acceptance' : 'task_handoff',
        kind: 'task'
      })
    }
    for (const dependsOnTaskId of payload?.dependsOnTaskIds ?? []) {
      const upstreamAgentId = taskOwnerById.get(dependsOnTaskId)
      if (!upstreamAgentId || upstreamAgentId === assigneeId || !agentIds.has(upstreamAgentId)) continue
      taskEdges.push({
        id: `${event.id}:${upstreamAgentId}:${assigneeId}:${dependsOnTaskId}`,
        fromAgentId: upstreamAgentId,
        toAgentId: assigneeId,
        phase: 'task_handoff',
        kind: 'task'
      })
    }
  }

  const deduped = new Map<string, WorkflowChainEdgeInput>()
  for (const edge of [...messageEdges, ...taskEdges]) deduped.set(edge.id, edge)
  const selected = [...deduped.values()]
  if (!selected.length && chainNodes.value.length < 2) return selected

  // Layout-only links so an Agent with no real traffic still hangs off the chain.
  // The model refuses to pulse these, so they never imply flow that never happened.
  const connected = new Set(selected.flatMap((edge) => [edge.fromAgentId, edge.toAgentId]))
  const head = chainNodes.value[0]
  const fallback = head
    ? chainNodes.value
        .slice(1)
        .filter((node) => !connected.has(node.agentId))
        .map((node) => ({
          id: `fallback:${head.agentId}:${node.agentId}`,
          fromAgentId: head.agentId,
          toAgentId: node.agentId,
          kind: 'fallback'
        }))
    : []
  return [...selected, ...fallback]
})

const chainEdges = computed(() => workflowChainEdges(chain.value, edgeCandidates.value))

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

function workflowNodeStyle(agentId: string, index: number, total: number) {
  const position = workflowNodePositions.value[agentId] ?? workflowNodePosition(index, total)
  return {
    left: `${position.x}%`,
    top: `${position.y}%`
  }
}

function workflowEdgePath(edge: { fromAgentId: string; toAgentId: string }) {
  const from = chainNodes.value.find((node) => node.agentId === edge.fromAgentId)?.position
  const to = chainNodes.value.find((node) => node.agentId === edge.toAgentId)?.position
  if (!from || !to) return undefined
  return { x: from.x, y: from.y, x2: to.x, y2: to.y }
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
  const agentId = draggingAgentId.value
  if (!agentId) return
  const point = workflowPointFromPointer(event)
  if (!point) return
  workflowNodePositions.value = { ...workflowNodePositions.value, [agentId]: point }
}

function startWorkflowNodeDrag(event: PointerEvent, agentId: string) {
  draggingAgentId.value = agentId
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  moveWorkflowDragTarget(event)
}

function stopWorkflowDrag() {
  draggingAgentId.value = undefined
}

function stageEvents(stage: WorkflowStage) {
  return props.events.filter((event) => {
    if (!stage.eventTypes.includes(event.type)) return false
    if (event.type !== 'agent_message') return true
    if (!stage.eventPhases?.length) return true
    const payload = event.metadata.payload as { round?: number } | undefined
    // Discussion messages carry round but no phase, so a phase-only test drops them.
    if (stage.key === 'intake' && typeof payload?.round === 'number') return true
    return stage.eventPhases.includes(eventPhase(event) ?? '')
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

const sessionStateLabel = computed(() => {
  if (props.activeConfirmation?.reason === 'workflow_agent_substitution') return '等待改派或跳过'
  if (props.activeConfirmation?.reason === 'workflow_upstream_rerun') return '等待选择返工节点'
  if (props.activeConfirmation?.reason === 'confirm_workflow_human_gate') return '等待人工验收'
  if (props.status === 'COMPLETED') return '已完成'
  if (props.status === 'PAUSED') return '已暂停'
  if (props.status === 'FAILED') return '已失败'
  if (props.status === 'CANCELLED') return '已取消'
  if (props.status === 'WAIT_USER_DECISION') return '等待用户决策'
  if (props.status === 'WAIT_WORKFLOW_STEP_CONFIRM') return '等待人工验收'
  return props.events.length ? '运行中' : '等待开始'
})

/** Real elapsed span between the first and last event, replacing the old fixed clock. */
const runtimeDuration = computed(() => {
  if (props.events.length < 2) return ''
  const timestamps = props.events.map((event) => new Date(event.createdAt).getTime()).filter((value) => !Number.isNaN(value))
  if (timestamps.length < 2) return ''
  const totalSeconds = Math.max(0, Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 1000))
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
})

function workflowEventTitle(event: CollaborationEvent) {
  if (event.type === 'task_failed') return '任务执行失败'
  if (event.type === 'task_rejected') return 'Agent 拒绝接单'
  const phase = eventPhase(event)
  return phase ? `${event.type} / ${phase}` : event.type
}

function workflowEventMeta(event: CollaborationEvent) {
  const payload = event.metadata.payload as (Partial<ArtifactEventPayload> & { reason?: string; code?: string }) | undefined
  const items: string[] = []
  const phase = eventPhase(event)
  if (phase) items.push(phase)
  if (payload?.reason) items.push(payload.reason)
  if (payload?.code) items.push(payload.code)
  const fileChangeCount = event.type === 'artifact_created'
    ? applicableArtifactFileChanges(payload as ArtifactEventPayload | undefined).length
    : 0
  if (fileChangeCount) items.push(`${fileChangeCount} 个文件变更`)
  return items
}

function agentTone(index: number) {
  return ((index % 5) + 1) as 1 | 2 | 3 | 4 | 5
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
      <span class="project-chip">会话：{{ sessionTitle ?? '暂无进行中的会话' }}</span>
      <span class="progress-chip">
        整体进度
        <strong>{{ progressPercent }}%</strong>
        <span><i :style="{ width: `${progressPercent}%` }"></i></span>
      </span>
      <span class="session-state" :class="{ online: sessionStateLabel === '运行中' }">{{ sessionStateLabel }}</span>
      <span v-if="runtimeDuration" class="graph-clock">运行时长 {{ runtimeDuration }}</span>
    </header>

    <div class="workflow-layout">
      <aside class="workflow-agent-rail" aria-label="Agents">
        <h3>Agents</h3>
        <button
          v-for="node in chainNodes"
          :key="node.agentId"
          type="button"
          :class="['workflow-agent-card', `agent-tone-${agentTone(node.index)}`, { selected: node.agentId === selectedAgentId }]"
          @click="selectChainNode(node.agentId)"
        >
          <AgentPortrait :tone="agentTone(node.index)" :label="node.name" size="md" />
          <strong><span>{{ String(node.index + 1).padStart(2, '0') }}</span>{{ node.name }}</strong>
          <small>{{ stateLabel(node.state) }}</small>
        </button>

        <section class="workflow-status-legend">
          <h3>状态说明</h3>
          <span><i class="dot-chain-done"></i>已执行</span>
          <span><i class="dot-chain-active"></i>执行中</span>
          <span><i class="dot-chain-pending"></i>未执行</span>
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

        <div
          class="workflow-map zoom-viewport"
          @wheel.prevent="handleWorkflowWheel"
          @pointermove.prevent="moveWorkflowDragTarget"
          @pointerup="stopWorkflowDrag"
          @pointercancel="stopWorkflowDrag"
          @pointerleave="stopWorkflowDrag"
        >
          <div class="zoom-content" :style="workflowZoomStyle">
            <svg class="workflow-agent-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <template v-for="edge in chainEdges" :key="edge.id">
                <line
                  v-if="workflowEdgePath(edge)"
                  :x1="workflowEdgePath(edge)?.x"
                  :y1="workflowEdgePath(edge)?.y"
                  :x2="workflowEdgePath(edge)?.x2"
                  :y2="workflowEdgePath(edge)?.y2"
                  :class="['workflow-chain-link', { pulsing: edge.pulsing, fallback: edge.kind === 'fallback' }]"
                />
              </template>
            </svg>

            <button
              v-for="node in chainNodes"
              :key="node.agentId"
              type="button"
              :class="[
                'workflow-chain-node',
                `is-${node.state}`,
                { 'is-system': node.kind === 'system', selected: node.agentId === selectedAgentId }
              ]"
              :style="workflowNodeStyle(node.agentId, node.index, chainNodes.length)"
              :aria-pressed="node.agentId === selectedAgentId"
              @pointerdown.prevent="startWorkflowNodeDrag($event, node.agentId)"
              @click="selectChainNode(node.agentId)"
            >
              <span class="workflow-chain-node__index">{{ node.index + 1 }}</span>
              <strong class="workflow-chain-node__name">{{ node.name }}</strong>
              <small class="workflow-chain-node__state">{{ stateLabel(node.state) }}</small>
            </button>
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

        <WorkflowAgentInspector
          v-if="selectedNode"
          :node="selectedNode"
          :tone="agentTone(selectedNode.index)"
        />

        <section class="workflow-discussion" aria-label="Agent 讨论">
          <header>
            <h3>Agent 讨论</h3>
            <span>{{ discussionMessageCount }} 条</span>
          </header>
          <article
            v-for="round in discussion"
            :key="round.round"
            class="workflow-discussion-round"
          >
            <h4>第 {{ round.round }} 轮</h4>
            <div
              v-for="message in round.messages"
              :key="message.eventId"
              class="workflow-discussion-message"
            >
              <strong>{{ message.agentName }}</strong>
              <p>{{ message.content }}</p>
            </div>
          </article>
          <p v-if="!discussion.length">本次会话还没有 Agent 讨论内容。</p>
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
