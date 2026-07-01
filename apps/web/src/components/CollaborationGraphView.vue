<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentCardState, CollaborationEvent } from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  events: CollaborationEvent[]
  agents: AgentCardState[]
  currentMode?: 'chat' | 'collaboration_graph' | 'workflow' | 'debug'
}>()

const emit = defineEmits<{
  switchView: [mode: 'chat' | 'collaboration_graph' | 'workflow' | 'debug']
}>()

const displayAgents = computed(() => props.agents.filter((agent) => agent.status !== 'disabled'))
const agentNameById = computed(() => new Map(props.agents.map((agent) => [agent.agentId, agent.name])))
const activeAgent = computed(
  () => displayAgents.value.find((agent) => ['running', 'thinking', 'discussing', 'reviewing', 'reworking'].includes(agent.status))
    ?? displayAgents.value[0]
)
type CommunicationEdge = {
  id: string
  fromAgentId: string
  toAgentId: string
  fromName: string
  toName: string
  kind: string
  phase?: string
  content: string
  createdAt: string
}
type GraphPoint = { x: number; y: number }
type DragTarget =
  | { kind: 'node'; agentId: string }
  | { kind: 'edge'; edgeId: string; endpoint: 'from' | 'to' }
  | { kind: 'edge-line'; edgeId: string; origin: { from: GraphPoint; to: GraphPoint; pointer: GraphPoint } }

const nodePositions = ref<Record<string, GraphPoint>>({})
const edgePositions = ref<Record<string, { from?: GraphPoint; to?: GraphPoint }>>({})
const dragTarget = ref<DragTarget | undefined>()

const pinnedPhases = new Set([
  'task_acceptance_decision',
  'task_acceptance_blocked',
  'task_claim_decision',
  'task_claim_declined',
  'task_acceptance',
  'user_message_routing',
  'agent_runtime_communication'
])

const eventDerivedEdges = computed<CommunicationEdge[]>(() =>
  props.events
    .filter((event) => event.type === 'agent_message' && event.fromAgentId)
    .flatMap((event) => {
      const payload = event.metadata.payload as { mentionedAgentIds?: string[]; messageKind?: string; phase?: string } | undefined
      const targetIds = Array.from(new Set([...(event.toAgentIds ?? []), ...(payload?.mentionedAgentIds ?? [])]))
        .filter((agentId) => agentId && agentId !== event.fromAgentId)
      return targetIds.map((targetId) => ({
        id: `${event.id}:${targetId}`,
        fromAgentId: event.fromAgentId!,
        toAgentId: targetId,
        fromName: agentNameById.value.get(event.fromAgentId!) ?? event.fromAgentId!,
        toName: agentNameById.value.get(targetId) ?? targetId,
        kind: payload?.messageKind ?? 'message',
        phase: payload?.phase,
        content: event.content,
        createdAt: event.createdAt
      }))
    })
)

const taskDerivedEdges = computed<CommunicationEdge[]>(() => {
  const seenTasks = new Map<string, string>()
  const coordinatorId = displayAgents.value[0]?.agentId
  const edges: CommunicationEdge[] = []
  for (const event of props.events) {
    const payload = event.metadata.payload as { taskId?: string; assigneeAgentId?: string; title?: string; dependsOnTaskIds?: string[] } | undefined
    const taskId = payload?.taskId ?? event.taskId
    const assigneeAgentId = payload?.assigneeAgentId
    if (taskId && assigneeAgentId) {
      seenTasks.set(taskId, assigneeAgentId)
      if (
        coordinatorId &&
        coordinatorId !== assigneeAgentId &&
        ['task_created', 'task_assigned', 'task_accepted', 'task_claimed', 'task_blocked', 'task_reassigned', 'task_started', 'task_waiting'].includes(event.type)
      ) {
        edges.push({
          id: `${event.id}:${coordinatorId}:${assigneeAgentId}`,
          fromAgentId: coordinatorId,
          toAgentId: assigneeAgentId,
          fromName: agentNameById.value.get(coordinatorId) ?? coordinatorId,
          toName: agentNameById.value.get(assigneeAgentId) ?? assigneeAgentId,
          kind: 'handoff',
          phase: event.type === 'task_created' || event.type === 'task_assigned' ? 'task_acceptance' : 'task_handoff',
          content: payload?.title ?? event.content,
          createdAt: event.createdAt
        })
      }
      for (const dependsOnTaskId of payload?.dependsOnTaskIds ?? []) {
        const upstreamAgentId = seenTasks.get(dependsOnTaskId)
        if (!upstreamAgentId || upstreamAgentId === assigneeAgentId) continue
        edges.push({
          id: `${event.id}:${upstreamAgentId}:${assigneeAgentId}:${dependsOnTaskId}`,
          fromAgentId: upstreamAgentId,
          toAgentId: assigneeAgentId,
          fromName: agentNameById.value.get(upstreamAgentId) ?? upstreamAgentId,
          toName: agentNameById.value.get(assigneeAgentId) ?? assigneeAgentId,
          kind: 'handoff',
          phase: 'task_handoff',
          content: payload?.title ?? event.content,
          createdAt: event.createdAt
        })
      }
    }
  }
  return edges
})

const allCommunicationEdges = computed<CommunicationEdge[]>(() => {
  const edges = [...eventDerivedEdges.value, ...taskDerivedEdges.value]
  const deduped = new Map<string, CommunicationEdge>()
  for (const edge of edges) deduped.set(edge.id, edge)
  return [...deduped.values()]
})

const communicationEdges = computed(() => {
  const edges = allCommunicationEdges.value
  const selected = new Map<string, CommunicationEdge>()
  for (const edge of edges.filter((item) => pinnedPhases.has(item.phase ?? ''))) {
    selected.set(edge.id, edge)
  }
  for (const edge of edges.slice(-12)) {
    selected.set(edge.id, edge)
  }
  return [...selected.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
})

const graphAgentNodes = computed(() =>
  displayAgents.value.map((agent, index, agents) => ({
    agent,
    index,
    tone: agentTone(index),
    position: nodePositions.value[agent.agentId] ?? graphNodePosition(index, agents.length),
    inbound: allCommunicationEdges.value.filter((edge) => edge.toAgentId === agent.agentId).length,
    outbound: allCommunicationEdges.value.filter((edge) => edge.fromAgentId === agent.agentId).length
  }))
)

const graphCanvasEdges = computed(() => {
  const nodeIds = new Set(graphAgentNodes.value.map((node) => node.agent.agentId))
  const selected = communicationEdges.value
    .filter((edge) => nodeIds.has(edge.fromAgentId) && nodeIds.has(edge.toAgentId))
    .slice(0, 14)
  const connected = new Set(selected.flatMap((edge) => [edge.fromAgentId, edge.toAgentId]))
  const fallback = graphAgentNodes.value
    .filter((node) => node.agent.agentId !== activeAgent.value?.agentId && !connected.has(node.agent.agentId))
    .map((node) => ({
      id: `fallback:${activeAgent.value!.agentId}:${node.agent.agentId}`,
      fromAgentId: activeAgent.value!.agentId,
      toAgentId: node.agent.agentId,
      fromName: activeAgent.value!.name,
      toName: node.agent.name,
      kind: 'status',
      phase: undefined,
      content: activeAgent.value!.currentTaskTitle ?? '',
      createdAt: activeAgent.value!.updatedAt
    }))
  if (!activeAgent.value) return selected
  return [...selected, ...fallback]
})

const phaseCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const edge of allCommunicationEdges.value) {
    const key = edge.phase ?? 'message'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([phase]) => pinnedPhases.has(phase))
    .map(([phase, count]) => ({ phase, count }))
})
const graphScale = ref(1)
const graphZoomStyle = computed(() => ({
  transform: `scale(${graphScale.value})`
}))
const graphZoomLabel = computed(() => `${Math.round(graphScale.value * 100)}%`)

function clampZoom(value: number) {
  return Math.min(1.8, Math.max(0.6, Number(value.toFixed(2))))
}

function zoomGraph(delta: number) {
  graphScale.value = clampZoom(graphScale.value + delta)
}

function resetGraphZoom() {
  graphScale.value = 1
}

function handleGraphWheel(event: WheelEvent) {
  zoomGraph(event.deltaY > 0 ? -0.08 : 0.08)
}

function agentTone(index: number) {
  return ((index % 5) + 1) as 1 | 2 | 3 | 4 | 5
}

function graphNodePosition(index: number, total: number) {
  if (total <= 1) return { x: 50, y: 48 }
  const radiusX = total <= 4 ? 30 : 36
  const radiusY = total <= 4 ? 28 : 32
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total
  return {
    x: Math.round((50 + Math.cos(angle) * radiusX) * 10) / 10,
    y: Math.round((50 + Math.sin(angle) * radiusY) * 10) / 10
  }
}

function graphNodeStyle(index: number, total: number) {
  const agent = graphAgentNodes.value.find((node) => node.index === index)?.agent
  const position = agent ? (nodePositions.value[agent.agentId] ?? graphNodePosition(index, total)) : graphNodePosition(index, total)
  return {
    left: `${position.x}%`,
    top: `${position.y}%`
  }
}

function graphEdgePath(edge: CommunicationEdge) {
  const from = edgePositions.value[edge.id]?.from ?? graphAgentNodes.value.find((node) => node.agent.agentId === edge.fromAgentId)?.position
  const to = edgePositions.value[edge.id]?.to ?? graphAgentNodes.value.find((node) => node.agent.agentId === edge.toAgentId)?.position
  if (!from || !to) return undefined
  return { ...from, x2: to.x, y2: to.y }
}

function pointFromPointer(event: PointerEvent): GraphPoint | undefined {
  const target = event.currentTarget as HTMLElement | SVGElement
  const canvas = target.closest('.agent-graph-canvas')
  if (!canvas) return undefined
  const rect = canvas.getBoundingClientRect()
  return {
    x: Math.min(96, Math.max(4, ((event.clientX - rect.left) / rect.width) * 100)),
    y: Math.min(94, Math.max(6, ((event.clientY - rect.top) / rect.height) * 100))
  }
}

function moveDragTarget(event: PointerEvent) {
  if (!dragTarget.value) return
  const point = pointFromPointer(event)
  if (!point) return
  if (dragTarget.value.kind === 'node') {
    nodePositions.value = { ...nodePositions.value, [dragTarget.value.agentId]: point }
    return
  }
  if (dragTarget.value.kind === 'edge') {
    edgePositions.value = {
      ...edgePositions.value,
      [dragTarget.value.edgeId]: {
        ...edgePositions.value[dragTarget.value.edgeId],
        [dragTarget.value.endpoint]: point
      }
    }
    return
  }
  if (dragTarget.value.kind === 'edge-line') {
    const { edgeId, origin } = dragTarget.value
    const deltaX = point.x - origin.pointer.x
    const deltaY = point.y - origin.pointer.y
    edgePositions.value = {
      ...edgePositions.value,
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

function startNodeDrag(event: PointerEvent, agentId: string) {
  dragTarget.value = { kind: 'node', agentId }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  moveDragTarget(event)
}

function startEdgeDrag(event: PointerEvent, edgeId: string, endpoint: 'from' | 'to') {
  dragTarget.value = { kind: 'edge', edgeId, endpoint }
  ;(event.currentTarget as SVGCircleElement).setPointerCapture(event.pointerId)
  moveDragTarget(event)
}

function startEdgeLineDrag(event: PointerEvent, edge: CommunicationEdge) {
  const path = graphEdgePath(edge)
  const point = pointFromPointer(event)
  if (!path || !point) return
  dragTarget.value = {
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

function stopDrag() {
  dragTarget.value = undefined
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

function communicationLabel(kind: string) {
  return (
    {
      discussion: '讨论',
      handoff: '交接',
      progress: '进展',
      decision: '决策',
      risk: '风险',
      summary: '总结'
    }[kind] ?? kind
  )
}
function phaseLabel(phase?: string) {
  return (
    {
      discussion: '讨论',
      brief_generation: '任务契约',
      task_acceptance: '任务分配',
      task_acceptance_decision: '接受决策',
      task_acceptance_blocked: '接受受阻',
      task_claim_decision: '接受决策',
      task_claim_declined: '拒绝接受',
      task_handoff: '交接',
      task_execution: '执行',
      post_review: '复盘',
      final_delivery: '交付',
      user_message_routing: '补充需求路由',
      agent_runtime_communication: 'Agent 通信',
      workspace_analysis: '工作区分析'
    }[phase ?? ''] ?? phase
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
      <div class="graph-view-switcher" role="toolbar" aria-label="视图切换">
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
    </header>

    <section class="agent-array-heading">
      <h3>Agent 阵列（{{ displayAgents.length }}/{{ displayAgents.length }} 在线）</h3>
    </section>

    <div class="agent-graph-shell">
      <div class="canvas-toolbar zoom-toolbar" aria-label="协同卡板缩放控制">
        <button type="button" data-zoom="out" aria-label="缩小协同卡板" @click="zoomGraph(-0.1)">-</button>
        <span>{{ graphZoomLabel }}</span>
        <button type="button" data-zoom="in" aria-label="放大协同卡板" @click="zoomGraph(0.1)">+</button>
        <button type="button" data-zoom="reset" aria-label="重置协同卡板缩放" @click="resetGraphZoom">复位</button>
      </div>

      <div class="agent-graph-canvas zoom-viewport" @wheel.prevent="handleGraphWheel" @pointermove.prevent="moveDragTarget" @pointerup="stopDrag" @pointercancel="stopDrag" @pointerleave="stopDrag">
        <div class="zoom-content" :style="graphZoomStyle">
          <article class="graph-callout">
        <span class="agent-node-icon agent-tone-2">
          <UiIcon name="list" :size="18" />
        </span>
        <strong>{{ activeAgent?.currentTaskTitle ?? '正在制定促销策略和活动规则' }}</strong>
      </article>

          <svg class="agent-graph-links editable-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <template v-for="edge in graphCanvasEdges" :key="edge.id">
              <line
                v-if="graphEdgePath(edge)"
                :x1="graphEdgePath(edge)?.x"
                :y1="graphEdgePath(edge)?.y"
                :x2="graphEdgePath(edge)?.x2"
                :y2="graphEdgePath(edge)?.y2"
                :class="['edge-drag-line', { highlighted: edge.phase === 'agent_runtime_communication' || edge.phase === 'user_message_routing' }]"
                @pointerdown.stop.prevent="startEdgeLineDrag($event, edge)"
              />
              <circle
                v-if="graphEdgePath(edge)"
                class="edge-drag-handle"
                :cx="graphEdgePath(edge)?.x"
                :cy="graphEdgePath(edge)?.y"
                r="1.5"
                @pointerdown.stop.prevent="startEdgeDrag($event, edge.id, 'from')"
                @pointermove.prevent="moveDragTarget"
                @pointerup="stopDrag"
                @pointercancel="stopDrag"
              />
              <circle
                v-if="graphEdgePath(edge)"
                class="edge-drag-handle"
                :cx="graphEdgePath(edge)?.x2"
                :cy="graphEdgePath(edge)?.y2"
                r="1.5"
                @pointerdown.stop.prevent="startEdgeDrag($event, edge.id, 'to')"
                @pointermove.prevent="moveDragTarget"
                @pointerup="stopDrag"
                @pointercancel="stopDrag"
              />
            </template>
          </svg>

          <button
        v-for="node in graphAgentNodes"
        :key="node.agent.agentId"
        type="button"
        :class="['agent-graph-node', `agent-tone-${node.tone}`, { active: node.agent.agentId === activeAgent?.agentId }]"
        :style="graphNodeStyle(node.index, graphAgentNodes.length)"
        @pointerdown.prevent="startNodeDrag($event, node.agent.agentId)"
          >
        <span class="agent-node-icon">
          <UiIcon :name="node.index === 0 ? 'search' : node.index === 1 ? 'workflow' : node.index === 2 ? 'sparkles' : node.index === 3 ? 'graph' : 'list'" :size="18" />
        </span>
        <h3>Agent {{ String(node.index + 1).padStart(2, '0') }}</h3>
        <p>{{ shortAgentName(node.agent.name) }}</p>
        <AgentPortrait :tone="node.tone" :label="node.agent.name" size="lg" />
        <strong class="agent-node-status">{{ statusLabel(node.agent.status) }}</strong>
        <small class="agent-node-traffic">出 {{ node.outbound }} / 入 {{ node.inbound }}</small>
          </button>
        </div>
      </div>
    </div>

    <section class="communication-flow-list">
      <h3>Agent 通信流</h3>
      <div class="communication-flow-meta">
        <span>{{ communicationEdges.length }} / {{ allCommunicationEdges.length }}</span>
        <span v-for="item in phaseCounts" :key="item.phase">{{ phaseLabel(item.phase) }} {{ item.count }}</span>
      </div>
      <article v-for="edge in communicationEdges" :key="edge.id">
        <strong>{{ edge.fromName }}</strong>
        <span>{{ communicationLabel(edge.kind) }}</span>
        <em v-if="edge.phase">{{ phaseLabel(edge.phase) }}</em>
        <strong>{{ edge.toName }}</strong>
        <p>{{ edge.content }}</p>
      </article>
      <p v-if="!communicationEdges.length">暂无 Agent 间通信事件。</p>
    </section>

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
