<script setup lang="ts">
import { computed } from 'vue'
import { VueFlow, Handle, Position } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import type { WorkflowVersion, WorkflowNodeRun } from '@agent-cluster/shared'
import { nodeTitle, executionLabel } from './workflowPresentation'

const props = defineProps<{ definition: WorkflowVersion; nodeRuns?: WorkflowNodeRun[]; selectedNodeId?: string }>()
const emit = defineEmits<{ select: [nodeId: string] }>()
const nodes = computed(() => props.definition.nodes.map((node, index) => {
  const attempts = (props.nodeRuns ?? []).filter((item) => item.nodeId === node.id)
  const latest = [...attempts].sort((a, b) => b.attempt - a.attempt)[0]
  return { id: node.id, type: 'workflow', position: node.ui ?? { x: 60, y: index * 140 + 40 }, data: { title: nodeTitle(node), type: node.type, status: latest?.status ?? 'pending', attempt: latest?.attempt, selected: node.id === props.selectedNodeId } }
}))
const edges = computed(() => {
  const base = props.definition.edges.map((edge) => ({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, type: 'smoothstep', markerEnd: 'arrowclosed' as const }))
  const history = [...(props.nodeRuns ?? [])].filter(item => item.startedAt).sort((a,b) => a.startedAt!.localeCompare(b.startedAt!))
  const rework = history.flatMap((item,index) => {
    const previous = history[index - 1]
    if (!previous || item.attempt < 2) return []
    const from = props.definition.nodes.find(node => node.id === previous.nodeId)
    const to = props.definition.nodes.find(node => node.id === item.nodeId)
    if (!from || !to || from.order < to.order) return []
    return [{ id: `rework:${item.id}`, source: previous.nodeId, target: item.nodeId, sourceHandle: 'rework-source', targetHandle: 'rework-target', type: 'smoothstep', pathOptions: { offset: 60 }, label: `返工 · 第 ${item.attempt} 轮`, style: { stroke: '#b88230', strokeDasharray: '6 4' }, markerEnd: 'arrowclosed' as const }]
  })
  return [...base, ...rework]
})
</script>

<template>
  <section class="selected-flow" aria-label="所选流程图">
    <VueFlow :key="definition.id" :nodes="nodes" :edges="edges" :nodes-draggable="false" :nodes-connectable="false" :edges-updatable="false" :delete-key-code="null" fit-view-on-init :min-zoom="0.2" :max-zoom="1">
      <template #node-workflow="{ id, data }">
        <Handle type="target" :position="Position.Top" :connectable="false" />
        <button class="flow-node" :class="[{ selected: data.selected }, `state-${data.status}`]" type="button" @click="emit('select', id)">
          <small>{{ data.type === 'human_approval' ? '人工确认' : data.type === 'robot_approval' ? '质量验证' : 'Agent 任务' }}</small>
          <strong>{{ data.title }}</strong>
          <span>{{ executionLabel(data.status) }}<template v-if="data.attempt"> · 第 {{ data.attempt }} 轮</template></span>
        </button>
        <Handle type="source" :position="Position.Bottom" :connectable="false" />
        <Handle id="rework-target" type="target" :position="Position.Left" :style="{ top: '30%' }" :connectable="false" />
        <Handle id="rework-source" type="source" :position="Position.Left" :style="{ top: '70%' }" :connectable="false" />
      </template>
    </VueFlow>
    <details class="flow-accessible-list"><summary>节点与连线列表</summary>
      <button v-for="node in definition.nodes" :key="node.id" type="button" @click="emit('select', node.id)">{{ nodeTitle(node) }}</button>
      <p v-for="edge in definition.edges" :key="edge.id">{{ definition.nodes.find(n => n.id === edge.sourceNodeId)?.name ?? edge.sourceNodeId }} → {{ definition.nodes.find(n => n.id === edge.targetNodeId)?.name ?? edge.targetNodeId }}</p>
    </details>
  </section>
</template>

<style scoped>
.selected-flow { position: relative; flex: 1; min-height: 320px; height: 100%; background: #f8f9fb; }
.flow-node { width: 240px; display: grid; gap: 8px; text-align: left; padding: 16px; background: #fff; color: #303133; border: 1px solid #dcdfe6; border-radius: 6px; cursor: pointer; }
.flow-node small, .flow-node span { color: #606266; font-size: 12px; }
.flow-node strong { font-size: 14px; }
.flow-node.selected, .flow-node:focus-visible { outline: 2px solid #409eff; outline-offset: 2px; }
.state-running { border-left: 4px solid #409eff; }
.state-completed, .state-approved { border-left: 4px solid #67c23a; }
.state-revision_requested, .state-waiting { border-left: 4px solid #e6a23c; }
.state-failed { border-left: 4px solid #f56c6c; }
.flow-accessible-list { position: absolute; bottom: 12px; left: 12px; padding: 8px; background: #fff; max-height: 40%; overflow: auto; border: 1px solid #e4e7ed; border-radius: 4px; }
.flow-accessible-list button { display: block; padding: 6px; margin: 4px 0; }
</style>
