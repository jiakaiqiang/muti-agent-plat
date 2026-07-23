<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentDefinition } from '@/types/contracts'
import type { WorkflowResource } from '../workflowBuilderModel'
import UiIcon from '../UiIcon.vue'

const props = defineProps<{ agents: AgentDefinition[] }>()
const emit = defineEmits<{ add: [resource: WorkflowResource] }>()
const search = ref('')
const collapsed = ref({ agent: false, human: false, robot: false })
const filteredAgents = computed(() => {
  const query = search.value.trim().toLowerCase()
  return props.agents.filter((agent) => !query || `${agent.name} ${agent.role} ${agent.tags.join(' ')}`.toLowerCase().includes(query))
})

function startDrag(event: DragEvent, resource: WorkflowResource) {
  event.dataTransfer?.setData('application/x-workflow-resource', JSON.stringify(resource))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}
</script>

<template>
  <aside class="workflow-resource-panel" aria-label="工作流节点资源">
    <header><div><h2>节点资源</h2><span>{{ agents.length + 2 }}</span></div><p>拖入画布或点击添加</p></header>
    <label class="resource-search"><UiIcon name="search" :size="16" /><input v-model="search" type="search" placeholder="搜索 Agent" aria-label="搜索 Agent" /></label>

    <section class="resource-group">
      <button type="button" class="resource-group__heading" :aria-expanded="!collapsed.agent" @click="collapsed.agent = !collapsed.agent">
        <span><UiIcon name="bot" :size="16" />Agent 列表</span><em>{{ filteredAgents.length }}</em><UiIcon name="chevron" :size="14" />
      </button>
      <div v-if="!collapsed.agent" class="resource-group__items">
        <button v-for="agent in filteredAgents" :key="agent.id" type="button" class="resource-item agent workflow-agent-resource" draggable="true" @dragstart="startDrag($event, { type: 'agent', agentId: agent.id })" @click="emit('add', { type: 'agent', agentId: agent.id })">
          <span class="resource-item__icon"><UiIcon name="bot" :size="16" /></span><span class="resource-item__copy"><strong>{{ agent.name }}</strong><small>{{ agent.description || agent.role }}</small></span><em>{{ agent.role }}</em>
        </button>
        <p v-if="!filteredAgents.length" class="resource-empty">没有匹配的 Agent</p>
      </div>
    </section>

    <section class="resource-group">
      <button type="button" class="resource-group__heading" :aria-expanded="!collapsed.human" @click="collapsed.human = !collapsed.human">
        <span><UiIcon name="users" :size="16" />人工确认</span><em>1</em><UiIcon name="chevron" :size="14" />
      </button>
      <div v-if="!collapsed.human" class="resource-group__items">
        <button type="button" class="resource-item human" draggable="true" @dragstart="startDrag($event, { type: 'human_approval' })" @click="emit('add', { type: 'human_approval' })">
          <span class="resource-item__icon"><UiIcon name="users" :size="16" /></span><span class="resource-item__copy"><strong>人工确认</strong><small>暂停流程，等待会话发起人决策</small></span><em>人工</em>
        </button>
      </div>
    </section>

    <section class="resource-group">
      <button type="button" class="resource-group__heading" :aria-expanded="!collapsed.robot" @click="collapsed.robot = !collapsed.robot">
        <span><UiIcon name="sparkles" :size="16" />机器人确认</span><em>1</em><UiIcon name="chevron" :size="14" />
      </button>
      <div v-if="!collapsed.robot" class="resource-group__items">
        <button type="button" class="resource-item robot" draggable="true" @dragstart="startDrag($event, { type: 'robot_approval' })" @click="emit('add', { type: 'robot_approval' })">
          <span class="resource-item__icon"><UiIcon name="sparkles" :size="16" /></span><span class="resource-item__copy"><strong>机器人确认</strong><small>评审 Agent 自动判断，异常转人工</small></span><em>自动</em>
        </button>
      </div>
    </section>
  </aside>
</template>

<style scoped>
.workflow-resource-panel{display:flex;flex-direction:column;min-width:0;min-height:0;padding:16px 12px;border-right:1px solid #e4e7ed;background:#fff;overflow:auto}.workflow-resource-panel header{padding:0 4px 12px}.workflow-resource-panel header>div{display:flex;align-items:center;gap:8px}.workflow-resource-panel h2{margin:0;color:#303133;font-size:15px}.workflow-resource-panel header span{padding:1px 6px;border-radius:10px;background:#ecf5ff;color:#409eff;font-size:11px}.workflow-resource-panel header p{margin:4px 0 0;color:#909399;font-size:12px}.resource-search{display:flex;align-items:center;gap:8px;height:34px;margin-bottom:12px;padding:0 10px;border:1px solid #dcdfe6;border-radius:4px;color:#909399}.resource-search:focus-within{border-color:#409eff;box-shadow:0 0 0 2px rgb(64 158 255 / 12%)}.resource-search input{width:100%;min-width:0;border:0;outline:0;color:#303133;font-size:13px}.resource-group{border-top:1px solid #ebeef5}.resource-group__heading{display:grid;grid-template-columns:minmax(0,1fr) auto 16px;align-items:center;gap:8px;width:100%;height:42px;padding:0 4px;border:0;background:#fff;color:#303133;cursor:pointer}.resource-group__heading>span{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600}.resource-group__heading>em{padding:1px 6px;border-radius:9px;background:#f4f4f5;color:#909399;font-size:10px;font-style:normal}.resource-group__heading[aria-expanded=false] :deep(.ui-icon:last-child){transform:rotate(-90deg)}.resource-group__items{display:grid;gap:6px;padding:0 0 12px}.resource-item{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:9px;width:100%;min-height:56px;padding:7px;border:1px solid transparent;border-radius:6px;background:#fff;color:#303133;text-align:left;cursor:grab;transition:border-color 180ms,background 180ms,box-shadow 180ms}.resource-item:hover,.resource-item:focus-visible{border-color:#b3d8ff;background:#f5faff;box-shadow:0 3px 10px rgb(64 158 255 / 8%);outline:0}.resource-item__icon{display:grid;place-items:center;width:34px;height:34px;border-radius:6px}.resource-item.agent .resource-item__icon{background:#ecf5ff;color:#409eff}.resource-item.human .resource-item__icon{background:#f0f9eb;color:#67c23a}.resource-item.robot .resource-item__icon{background:#fdf6ec;color:#e6a23c}.resource-item__copy{display:grid;gap:3px;min-width:0}.resource-item__copy strong,.resource-item__copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.resource-item__copy strong{font-size:12px}.resource-item__copy small{color:#909399;font-size:10px}.resource-item>em{max-width:64px;padding:2px 6px;border-radius:4px;background:#f4f4f5;color:#606266;font-size:9px;font-style:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.resource-empty{padding:18px 0;color:#909399;font-size:12px;text-align:center}
</style>
