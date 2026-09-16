<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useTaskWorkspaceStore } from '@/stores/taskWorkspace'
import SelectedWorkflowGraph from './SelectedWorkflowGraph.vue'
import { nodeTitle } from './workflowPresentation'
const props = defineProps<{ canUse: boolean; busy?: boolean; taskTitle?: string }>()
const emit = defineEmits<{ use: [workflowId: string, version: number]; close: [] }>()
const store = useTaskWorkspaceStore()
const query = ref('')
const selectedId = ref('')
const selectedNodeId = ref('')
const confirming = ref(false)
const filtered = computed(() => store.catalog.filter(item => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(query.value.toLowerCase())))
const selected = computed(() => store.catalog.find(item => item.id === selectedId.value))
const selectedNode = computed(() => selected.value?.nodes.find(node => node.id === selectedNodeId.value))
onMounted(() => store.loadCatalog())
</script>
<template>
  <section class="workflow-catalog">
    <header><div><h2>流程管理</h2><p>系统发布的流程 · 查看和使用</p></div><el-button @click="store.loadCatalog()" :loading="store.catalogLoading">刷新</el-button><el-button @click="emit('close')">返回任务</el-button></header>
    <el-alert v-if="store.catalogError" :title="store.catalogError" type="error" :closable="false" />
    <div class="catalog-body">
      <nav aria-label="系统流程列表"><el-input v-model="query" placeholder="搜索流程" aria-label="搜索流程" clearable />
        <p v-if="store.catalogLoading" role="status">正在读取流程…</p>
        <p v-else-if="!filtered.length">暂无可用流程</p>
        <button v-for="item in filtered" :key="item.id" type="button" :class="{ selected: selectedId === item.id }" @click="selectedId = item.id; selectedNodeId = ''; confirming = false"><strong>{{ item.name }}</strong><small>v{{ item.version }} · {{ item.nodes.length }} 个节点</small><span>{{ item.description }}</span></button>
      </nav>
      <main v-if="selected"><header><div><h3>{{ selected.name }} · v{{ selected.version }}</h3><p>{{ selected.description }}</p></div><el-button type="primary" :disabled="!props.canUse || store.catalogLoading || !!store.catalogError" @click="confirming = true">使用此流程</el-button></header>
        <p v-if="!canUse" class="catalog-hint">先在当前任务中聊清需求并确认总结，再选择流程。</p>
        <SelectedWorkflowGraph :definition="selected" :selected-node-id="selectedNodeId" @select="selectedNodeId = $event" />
        <section v-if="selectedNode" class="node-preview"><strong>{{ nodeTitle(selectedNode) }}</strong><p v-if="selectedNode.type === 'agent'">{{ selectedNode.stageDescription }}<br>输出：{{ selectedNode.outputContract?.join('；') }}</p><p v-else-if="selectedNode.type === 'human_approval'">{{ selectedNode.instruction }}</p><p v-else>{{ selectedNode.criteria.join('；') }}</p></section>
      </main><el-empty v-else description="选择流程查看节点与连线" />
    </div>
    <el-dialog v-model="confirming" title="确认启动工作流" width="460px" :close-on-click-modal="false">
      <p>任务：{{ taskTitle }}</p><p>流程：{{ selected?.name }} · v{{ selected?.version }}</p><p>启动后将固定此版本，执行过程记录在当前任务中。</p>
      <template #footer><el-button @click="confirming = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="!canUse || !selected || store.catalogLoading || !!store.catalogError" @click="selected && emit('use', selected.workflowId, selected.version)">确认启动</el-button></template>
    </el-dialog>
  </section>
</template>
<style scoped>
.workflow-catalog { display: flex; flex-direction: column; height: 100%; min-height: 0; background: #fff; color: #303133; }
header { display: flex; align-items: center; gap: 12px; padding: 16px; border-bottom: 1px solid #e4e7ed; }
header>div { flex: 1; min-width: 0; } h2,h3,p { margin: 0; } h2 { font-size: 18px; } h3 { font-size: 15px; } p,small { color: #606266; font-size: 13px; margin-top: 6px; }
.catalog-body { display: grid; grid-template-columns: 230px minmax(0,1fr); flex: 1; min-height: 0; }
nav { padding: 12px; border-right: 1px solid #e4e7ed; overflow: auto; } nav button { display: grid; gap: 7px; width: 100%; padding: 12px; margin-top: 10px; border: 1px solid #e4e7ed; border-radius: 4px; background: #fff; color: #303133; text-align: left; cursor: pointer; } nav button.selected { border-color: #409eff; background: #ecf5ff; } nav span { font-size: 12px; color: #606266; }
main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }.catalog-hint,.node-preview { padding: 12px 16px; }.node-preview { max-height: 160px; overflow: auto; }
@media(max-width:720px) { .catalog-body { grid-template-columns: 160px minmax(0,1fr); } header { flex-wrap: wrap; } }
</style>
