<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  VueFlow,
  getStraightPath,
  useVueFlow,
  type EdgeProps,
  type NodeDragEvent,
  type NodeMouseEvent
} from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import type { AgentDefinition, WorkflowNode } from '@/types/contracts'
import type { WorkflowResource } from '../workflowBuilderModel'
import UiIcon from '../UiIcon.vue'

const props = defineProps<{ nodes: WorkflowNode[]; agents: AgentDefinition[]; selectedNodeId?: string }>()
const emit = defineEmits<{
  select: [nodeId: string]
  reorder: [nodeIds: string[]]
  insert: [index: number, resource: WorkflowResource]
  remove: [nodeId: string]
}>()

const insertMenuIndex = ref<number>()
const zoomLabel = ref(100)
const { fitView, zoomIn, zoomOut, getNodes, screenToFlowCoordinate } = useVueFlow()

const flowNodes = computed(() => [
  { id: '__start__', type: 'terminal', position: { x: 190, y: 24 }, draggable: false, selectable: false, data: { terminal: 'start', label: '开始' } },
  ...props.nodes.map((node, index) => ({
    id: node.id,
    type: 'workflow',
    position: node.ui ?? { x: 140, y: 112 + index * 116 },
    draggable: true,
    data: { node }
  })),
  { id: '__end__', type: 'terminal', position: { x: 190, y: 112 + props.nodes.length * 116 }, draggable: false, selectable: false, data: { terminal: 'end', label: '结束' } }
])

const flowEdges = computed(() => {
  const ids = ['__start__', ...props.nodes.map((node) => node.id), '__end__']
  return ids.slice(0, -1).map((source, index) => ({
    id: `insert-edge:${source}:${ids[index + 1]}`,
    source,
    target: ids[index + 1],
    type: 'insert',
    markerEnd: MarkerType.ArrowClosed,
    data: { insertionIndex: index }
  }))
})

function nodeTitle(node: WorkflowNode) {
  if (node.name) return node.name
  if (node.type === 'agent') return props.agents.find((agent) => agent.id === node.agentId)?.name ?? 'Agent 节点'
  return node.type === 'human_approval' ? '人工确认' : '机器人确认'
}

function nodeSubtitle(node: WorkflowNode) {
  if (node.type === 'agent') return node.stageDescription || props.agents.find((agent) => agent.id === node.agentId)?.description || '执行工作流阶段'
  if (node.type === 'human_approval') return node.instruction || '等待会话发起人确认'
  return node.criteria.length ? node.criteria.join('；') : '评审 Agent 自动判断'
}

function nodeTone(node: WorkflowNode) {
  return node.type === 'agent' ? 'agent' : node.type === 'human_approval' ? 'human' : 'robot'
}

function edgeGeometry(edge: EdgeProps) {
  return getStraightPath({ sourceX: edge.sourceX, sourceY: edge.sourceY, targetX: edge.targetX, targetY: edge.targetY })
}

function onNodeClick(event: NodeMouseEvent) {
  if (!event.node.id.startsWith('__')) emit('select', event.node.id)
}

function onNodeDragStop(_event: NodeDragEvent) {
  emit('reorder', getNodes.value
    .filter((node) => !node.id.startsWith('__'))
    .sort((left, right) => left.computedPosition.y - right.computedPosition.y)
    .map((node) => node.id))
}

function insert(index: number, resource: WorkflowResource) {
  emit('insert', index, resource)
  insertMenuIndex.value = undefined
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  const raw = event.dataTransfer?.getData('application/x-workflow-resource')
  if (!raw) return
  try {
    const resource = JSON.parse(raw) as WorkflowResource
    const point = screenToFlowCoordinate({ x: event.clientX, y: event.clientY })
    const index = Math.max(0, Math.min(props.nodes.length, Math.round((point.y - 74) / 116)))
    emit('insert', index, resource)
  } catch {
    // Ignore drag payloads that do not belong to the workflow editor.
  }
}

async function fit() {
  await nextTick()
  await fitView({ padding: 0.22, duration: 180 })
}

watch(() => props.nodes.length, () => void fit())
onMounted(() => void fit())
</script>

<template>
  <section class="workflow-canvas-panel" aria-label="流程画布">
    <header><div><h2>流程画布</h2><span>线性流程</span></div><div class="canvas-tools"><button type="button" title="缩小" aria-label="缩小画布" @click="zoomOut({ duration: 120 })">−</button><strong>{{ zoomLabel }}%</strong><button type="button" title="放大" aria-label="放大画布" @click="zoomIn({ duration: 120 })">+</button><button type="button" title="适应画布" aria-label="适应画布" @click="fit">适应</button></div></header>
    <div class="workflow-canvas" data-testid="workflow-canvas" @dragover.prevent @drop="onDrop">
      <VueFlow :nodes="flowNodes" :edges="flowEdges" :min-zoom="0.6" :max-zoom="1.8" :nodes-connectable="false" :elements-selectable="true" fit-view-on-init @node-click="onNodeClick" @node-drag-stop="onNodeDragStop" @viewport-change="zoomLabel = Math.round($event.zoom * 100)">
        <template #node-terminal="{ data }">
          <div class="terminal-node" :class="data.terminal"><span></span>{{ data.label }}</div><Handle v-if="data.terminal === 'start'" type="source" :position="Position.Bottom" :connectable="false" /><Handle v-else type="target" :position="Position.Top" :connectable="false" />
        </template>
        <template #node-workflow="{ data }">
          <Handle type="target" :position="Position.Top" :connectable="false" />
          <article class="canvas-node workflow-builder-node" :class="[nodeTone(data.node), { selected: data.node.id === selectedNodeId }]" :aria-label="nodeTitle(data.node)">
            <span class="canvas-node__icon"><UiIcon :name="data.node.type === 'agent' ? 'bot' : data.node.type === 'human_approval' ? 'users' : 'sparkles'" :size="17" /></span><span class="canvas-node__copy"><strong>{{ nodeTitle(data.node) }}</strong><small>{{ nodeSubtitle(data.node) }}</small></span><button type="button" title="删除节点" aria-label="删除节点" @click.stop="emit('remove', data.node.id)"><UiIcon name="trash" :size="14" /></button>
          </article>
          <Handle type="source" :position="Position.Bottom" :connectable="false" />
        </template>
        <template #edge-insert="edgeProps">
          <BaseEdge :path="edgeGeometry(edgeProps)[0]" :marker-end="edgeProps.markerEnd" />
          <EdgeLabelRenderer>
            <button type="button" class="edge-insert-button nodrag nopan" :style="{ transform: `translate(-50%, -50%) translate(${edgeGeometry(edgeProps)[1]}px, ${edgeGeometry(edgeProps)[2]}px)` }" :aria-label="`在第 ${edgeProps.data.insertionIndex + 1} 个位置插入节点`" @click="insertMenuIndex = insertMenuIndex === edgeProps.data.insertionIndex ? undefined : edgeProps.data.insertionIndex">+</button>
            <div v-if="insertMenuIndex === edgeProps.data.insertionIndex" class="edge-insert-menu nodrag nopan" :style="{ transform: `translate(-50%, 8px) translate(${edgeGeometry(edgeProps)[1]}px, ${edgeGeometry(edgeProps)[2]}px)` }">
              <strong>插入节点</strong><button v-for="agent in agents.slice(0, 6)" :key="agent.id" type="button" @click="insert(edgeProps.data.insertionIndex, { type: 'agent', agentId: agent.id })"><UiIcon name="bot" :size="14" />{{ agent.name }}</button><button type="button" @click="insert(edgeProps.data.insertionIndex, { type: 'human_approval' })"><UiIcon name="users" :size="14" />人工确认</button><button type="button" @click="insert(edgeProps.data.insertionIndex, { type: 'robot_approval' })"><UiIcon name="sparkles" :size="14" />机器人确认</button>
            </div>
          </EdgeLabelRenderer>
        </template>
      </VueFlow>
    </div>
  </section>
</template>

<style scoped>
.workflow-canvas-panel{display:grid;grid-template-rows:44px minmax(0,1fr);min-width:0;min-height:0;border-right:1px solid #e4e7ed;background:#fff}.workflow-canvas-panel>header{display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid #e4e7ed}.workflow-canvas-panel>header>div:first-child{display:flex;align-items:center;gap:8px}.workflow-canvas-panel h2{margin:0;color:#303133;font-size:14px}.workflow-canvas-panel header span{padding:2px 6px;border-radius:4px;background:#f4f4f5;color:#909399;font-size:10px}.canvas-tools{display:flex;align-items:center;gap:6px}.canvas-tools button,.canvas-tools strong{display:inline-flex;align-items:center;justify-content:center;height:28px;min-width:30px;padding:0 8px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#606266;font-size:11px}.canvas-tools button{cursor:pointer}.canvas-tools button:hover,.canvas-tools button:focus-visible{border-color:#409eff;color:#409eff;outline:0}.canvas-tools strong{min-width:48px;font-weight:500}.workflow-canvas{position:relative;min-height:0;background:#fbfcfe;background-image:radial-gradient(circle,#d9e1ec 1px,transparent 1px);background-size:16px 16px;overflow:hidden}.workflow-canvas :deep(.vue-flow__pane){cursor:grab}.workflow-canvas :deep(.vue-flow__node){width:auto}.workflow-canvas :deep(.vue-flow__handle){width:7px;height:7px;border:1px solid #a8abb2;background:#fff;opacity:0}.terminal-node{display:flex;align-items:center;gap:7px;height:30px;padding:0 13px;border:1px solid #67c23a;border-radius:15px;background:#f0f9eb;color:#529b2e;font-size:11px;font-weight:600}.terminal-node.end{border-color:#c0c4cc;background:#f4f4f5;color:#606266}.terminal-node>span{width:8px;height:8px;border:2px solid currentColor;border-radius:50%}.canvas-node{display:grid;grid-template-columns:34px minmax(0,1fr) 26px;align-items:center;gap:9px;width:270px;min-height:62px;padding:8px 9px;border:1px solid #409eff;border-radius:6px;background:#fff;box-shadow:0 4px 12px rgb(31 64 115 / 8%);color:#409eff;transition:border-color 180ms,box-shadow 180ms,transform 180ms}.canvas-node.human{border-color:#67c23a;color:#67c23a}.canvas-node.robot{border-color:#e6a23c;color:#e6a23c}.canvas-node.selected{border-width:2px;box-shadow:0 6px 18px rgb(64 158 255 / 18%);transform:translateY(-1px)}.canvas-node__icon{display:grid;place-items:center;width:34px;height:34px;border-radius:6px;background:#ecf5ff}.canvas-node.human .canvas-node__icon{background:#f0f9eb}.canvas-node.robot .canvas-node__icon{background:#fdf6ec}.canvas-node__copy{display:grid;gap:4px;min-width:0;color:#303133}.canvas-node__copy strong,.canvas-node__copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.canvas-node__copy strong{font-size:12px}.canvas-node__copy small{color:#909399;font-size:10px}.canvas-node>button{display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:4px;background:transparent;color:#909399;cursor:pointer}.canvas-node>button:hover,.canvas-node>button:focus-visible{background:#fef0f0;color:#f56c6c;outline:0}.edge-insert-button{position:absolute;display:grid;place-items:center;width:20px;height:20px;padding:0;border:1px solid #c0c4cc;border-radius:50%;background:#fff;color:#606266;font-size:14px;line-height:1;cursor:pointer;pointer-events:all;z-index:5}.edge-insert-button:hover,.edge-insert-button:focus-visible{border-color:#409eff;color:#409eff;outline:2px solid rgb(64 158 255 / 15%)}.edge-insert-menu{position:absolute;display:grid;width:190px;max-height:250px;padding:8px;border:1px solid #dcdfe6;border-radius:6px;background:#fff;box-shadow:0 6px 18px rgb(0 0 0 / 10%);pointer-events:all;overflow:auto;z-index:8}.edge-insert-menu strong{padding:5px 7px;color:#303133;font-size:11px}.edge-insert-menu button{display:flex;align-items:center;gap:7px;min-height:30px;padding:0 7px;border:0;border-radius:4px;background:#fff;color:#606266;font-size:11px;text-align:left;cursor:pointer}.edge-insert-menu button:hover,.edge-insert-menu button:focus-visible{background:#ecf5ff;color:#409eff;outline:0}@media(max-width:900px){.canvas-node{width:230px}}@media(prefers-reduced-motion:reduce){.canvas-node{transition:none}}
</style>
