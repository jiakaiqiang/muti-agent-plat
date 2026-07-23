<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useAgentStore } from '@/stores/agent'
import { useWorkflowStore } from '@/stores/workflow'
import type { AgentDefinition, WorkflowDefinition, WorkflowNode, WorkflowStatus } from '@/types/contracts'
import UiIcon from './UiIcon.vue'
import WorkflowResourcePanel from './workflow/WorkflowResourcePanel.vue'
import WorkflowCanvas from './workflow/WorkflowCanvas.vue'
import WorkflowNodeInspector from './workflow/WorkflowNodeInspector.vue'
import {
  buildLinearWorkflowEdges,
  createWorkflowNode,
  insertWorkflowNode,
  removeWorkflowNode,
  reorderWorkflowNodes,
  replaceWorkflowNode,
  type WorkflowResource
} from './workflowBuilderModel'

const agentStore = useAgentStore()
const workflowStore = useWorkflowStore()
const {
  managerView: view,
  creating,
  draftName,
  draftDescription,
  draftNodes,
  selectedNodeId,
  searchQuery,
  statusFilter,
  errorMessage,
  successMessage,
  dirty,
  undoStack,
  redoStack,
  deleteTarget
} = storeToRefs(workflowStore)

const activeAgents = computed(() => agentStore.agents.filter((agent) => agent.status === 'active'))
const selectedWorkflow = computed(() => workflowStore.selectedWorkflow)
const selectedNode = computed(() => draftNodes.value.find((node) => node.id === selectedNodeId.value))
const canSave = computed(() => Boolean(draftName.value.trim()) && !workflowStore.saving)
const filteredWorkflows = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  return workflowStore.workflows.filter((workflow) => {
    const matchesQuery = !query || `${workflow.name} ${workflow.description ?? ''}`.toLowerCase().includes(query)
    return matchesQuery && (statusFilter.value === 'all' || workflow.status === statusFilter.value)
  })
})

onMounted(async () => {
  try {
    await Promise.all([
      workflowStore.loadWorkflows(),
      agentStore.agents.length ? Promise.resolve() : agentStore.loadAgents()
    ])
  } catch (error) {
    errorMessage.value = messageOf(error, '加载工作流失败')
  }
})

function cloneNodes(nodes: WorkflowNode[]) {
  return nodes.map((node) => JSON.parse(JSON.stringify(node)) as WorkflowNode)
}

function hydrate(workflow?: WorkflowDefinition) {
  draftName.value = workflow?.name ?? ''
  draftDescription.value = workflow?.description ?? ''
  draftNodes.value = cloneNodes(workflow?.nodes ?? [])
  selectedNodeId.value = draftNodes.value[0]?.id ?? ''
  undoStack.value = []
  redoStack.value = []
  dirty.value = false
  errorMessage.value = ''
}

function openCreate() {
  creating.value = true
  hydrate()
  view.value = 'editor'
  successMessage.value = ''
}

function openEditor(workflow: WorkflowDefinition) {
  creating.value = false
  workflowStore.selectWorkflow(workflow.id)
  hydrate(workflow)
  view.value = 'editor'
  successMessage.value = ''
}

function returnToList() {
  creating.value = false
  view.value = 'list'
  errorMessage.value = ''
}

function snapshot() {
  undoStack.value.push(cloneNodes(draftNodes.value))
  if (undoStack.value.length > 30) undoStack.value.shift()
  redoStack.value = []
}

function changed() {
  dirty.value = true
  successMessage.value = ''
}

function addResource(resource: WorkflowResource, index = draftNodes.value.length) {
  snapshot()
  const effective = resource.type === 'robot_approval' && !resource.agentId
    ? { ...resource, agentId: activeAgents.value[0]?.id }
    : resource
  const node = createWorkflowNode(effective, index)
  draftNodes.value = insertWorkflowNode(draftNodes.value, node, index)
  selectedNodeId.value = node.id
  changed()
}

function insertResource(index: number, resource: WorkflowResource) {
  addResource(resource, index)
}

function updateNode(node: WorkflowNode) {
  snapshot()
  draftNodes.value = replaceWorkflowNode(draftNodes.value, node)
  changed()
}

function removeNode(nodeId: string) {
  snapshot()
  draftNodes.value = removeWorkflowNode(draftNodes.value, nodeId)
  selectedNodeId.value = draftNodes.value[Math.max(0, Math.min(draftNodes.value.length - 1, 0))]?.id ?? ''
  changed()
}

function reorder(nodeIds: string[]) {
  snapshot()
  draftNodes.value = reorderWorkflowNodes(draftNodes.value, nodeIds)
  changed()
}

function undo() {
  const previous = undoStack.value.pop()
  if (!previous) return
  redoStack.value.push(cloneNodes(draftNodes.value))
  draftNodes.value = previous
  selectedNodeId.value = draftNodes.value.find((node) => node.id === selectedNodeId.value)?.id ?? draftNodes.value[0]?.id ?? ''
  changed()
}

function redo() {
  const next = redoStack.value.pop()
  if (!next) return
  undoStack.value.push(cloneNodes(draftNodes.value))
  draftNodes.value = next
  selectedNodeId.value = draftNodes.value.find((node) => node.id === selectedNodeId.value)?.id ?? draftNodes.value[0]?.id ?? ''
  changed()
}

function validate(publish: boolean) {
  if (!draftName.value.trim()) return '请输入工作流名称。'
  if (!publish) return ''
  if (!draftNodes.value.some((node) => node.type === 'agent')) return '发布前至少需要添加一个 Agent 节点。'
  for (const [index, node] of draftNodes.value.entries()) {
    if (node.type !== 'agent' && !draftNodes.value.slice(0, index).some((item) => item.type === 'agent')) {
      return '确认节点前必须存在一个 Agent 节点。'
    }
    if (node.type === 'robot_approval' && (!node.reviewerAgentId || !node.reviewPrompt.trim() || !node.criteria.length)) {
      return '请完善机器人确认节点的评审 Agent、提示词和评审标准。'
    }
    if (node.type === 'human_approval' && (!node.title.trim() || !node.allowedDecisions.length)) {
      return '请完善人工确认节点的标题和允许操作。'
    }
  }
  return ''
}

async function saveDraft() {
  const validation = validate(false)
  if (validation) throw new Error(validation)
  const input = {
    name: draftName.value.trim(),
    description: draftDescription.value.trim() || undefined,
    nodes: draftNodes.value,
    edges: buildLinearWorkflowEdges(draftNodes.value)
  }
  if (creating.value) {
    const created = await workflowStore.createWorkflow(input)
    creating.value = false
    hydrate(created)
    return created
  }
  if (!selectedWorkflow.value) throw new Error('未找到需要保存的工作流。')
  const updated = await workflowStore.updateWorkflow(selectedWorkflow.value.id, {
    ...input,
    expectedDraftRevision: selectedWorkflow.value.draftRevision
  })
  hydrate(updated)
  return updated
}

async function persistWorkflow(publish = false) {
  const validation = validate(publish)
  if (validation) {
    errorMessage.value = validation
    return
  }
  try {
    const saved = await saveDraft()
    if (publish) {
      const published = await workflowStore.publishWorkflow(saved.id, saved.draftRevision)
      hydrate(published)
      returnToList()
      successMessage.value = `工作流已发布为 v${published.currentPublishedVersion}`
    } else {
      successMessage.value = `草稿已保存（修订 ${saved.draftRevision}）`
    }
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = messageOf(error, publish ? '发布工作流失败' : '保存工作流失败')
  }
}

async function archiveWorkflow(workflow: WorkflowDefinition) {
  try {
    await workflowStore.archiveWorkflow(workflow.id)
    successMessage.value = '工作流已归档'
  } catch (error) {
    errorMessage.value = messageOf(error, '归档工作流失败')
  }
}

async function removeWorkflow() {
  if (!deleteTarget.value) return
  try {
    await workflowStore.deleteWorkflow(deleteTarget.value.id)
    deleteTarget.value = undefined
    successMessage.value = '工作流已删除'
  } catch (error) {
    errorMessage.value = messageOf(error, '删除工作流失败')
  }
}

function workflowAgents(workflow: WorkflowDefinition) {
  const ids = new Set<string>()
  for (const node of workflow.nodes) {
    if (node.type === 'agent') ids.add(node.agentId)
    if (node.type === 'robot_approval') ids.add(node.reviewerAgentId)
  }
  return [...ids].map((id) => agentStore.agentById(id)).filter((agent): agent is AgentDefinition => Boolean(agent))
}

function statusLabel(status: WorkflowStatus) {
  return { draft: '草稿', published: '已发布', archived: '已归档' }[status]
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date)
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}
</script>

<template>
  <section class="workflow-manager" aria-label="工作流管理">
    <template v-if="view === 'list'">
      <header class="list-heading">
        <div><p>流程管理 <span>/</span> <strong>工作流列表</strong></p><small>管理工作流并编排 Agent、人工确认和机器人确认节点</small></div>
        <button type="button" class="primary-button" data-testid="workflow-create" @click="openCreate"><UiIcon name="plus" :size="16" />添加工作流</button>
      </header>

      <div class="list-surface">
        <div class="filters">
          <label><UiIcon name="search" :size="16" /><input v-model="searchQuery" type="search" placeholder="搜索工作流名称" aria-label="搜索工作流名称" /></label>
          <select v-model="statusFilter" aria-label="工作流状态"><option value="all">全部状态</option><option value="published">已发布</option><option value="draft">草稿</option><option value="archived">已归档</option></select>
        </div>
        <p v-if="errorMessage" class="message error" role="alert">{{ errorMessage }}</p>
        <p v-else-if="successMessage" class="message success" role="status">{{ successMessage }}</p>

        <div class="table-wrap">
          <table>
            <thead><tr><th>工作流名称</th><th>相关 Agent</th><th>流程构成</th><th>描述</th><th>更新时间</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="workflow in filteredWorkflows" :key="workflow.id">
                <td><button type="button" class="name-link" @click="openEditor(workflow)">{{ workflow.name }}</button><small>ID: {{ workflow.id }}</small></td>
                <td><div class="agent-chips"><span v-for="agent in workflowAgents(workflow).slice(0, 3)" :key="agent.id">{{ agent.name }}</span><em v-if="workflowAgents(workflow).length > 3">+{{ workflowAgents(workflow).length - 3 }}</em><small v-if="!workflowAgents(workflow).length">未配置</small></div></td>
                <td><div class="node-counts"><span><UiIcon name="bot" :size="13" />{{ workflow.nodes.filter(node => node.type === 'agent').length }}</span><span><UiIcon name="users" :size="13" />{{ workflow.nodes.filter(node => node.type === 'human_approval').length }}</span><span><UiIcon name="sparkles" :size="13" />{{ workflow.nodes.filter(node => node.type === 'robot_approval').length }}</span></div></td>
                <td class="description-cell">{{ workflow.description || '暂无描述' }}</td>
                <td><time>{{ formatDate(workflow.updatedAt) }}</time></td>
                <td><span :class="['status-badge', workflow.status]">{{ statusLabel(workflow.status) }}</span></td>
                <td><div class="row-actions"><button type="button" :data-testid="`workflow-edit-${workflow.id}`" title="编辑" aria-label="编辑工作流" @click="openEditor(workflow)"><UiIcon name="settings" :size="15" /></button><button v-if="workflow.status === 'published'" type="button" title="归档" aria-label="归档工作流" @click="archiveWorkflow(workflow)"><UiIcon name="folder" :size="15" /></button><button v-else-if="workflow.status === 'draft'" type="button" class="danger" title="删除" aria-label="删除工作流" @click="deleteTarget = workflow"><UiIcon name="trash" :size="15" /></button></div></td>
              </tr>
              <tr v-if="!filteredWorkflows.length"><td colspan="7" class="empty-row">{{ workflowStore.loading ? '正在加载工作流…' : '暂无符合条件的工作流' }}</td></tr>
            </tbody>
          </table>
        </div>
        <footer class="pagination"><span>共 {{ filteredWorkflows.length }} 条</span><div><button type="button" disabled>‹</button><strong>1</strong><button type="button" disabled>›</button><span>10 条/页</span></div></footer>
      </div>
    </template>

    <template v-else>
      <header class="editor-heading">
        <div class="breadcrumb"><button type="button" title="返回" aria-label="返回工作流列表" @click="returnToList">‹</button><span>流程管理 <em>/</em> <strong>{{ creating ? '创建工作流' : '编辑工作流' }}</strong></span><i v-if="dirty">未保存</i></div>
        <div class="editor-actions"><button type="button" @click="returnToList">取消</button><button type="button" data-testid="workflow-save" :disabled="!canSave" @click="persistWorkflow(false)">保存草稿</button><button type="button" class="primary-button" :disabled="!canSave" @click="persistWorkflow(true)">发布</button></div>
      </header>

      <div class="definition-bar">
        <label><span>工作流名称 <em>*</em></span><div><input v-model="draftName" maxlength="50" placeholder="请输入工作流名称" @input="changed" /><small>{{ draftName.length }}/50</small></div></label>
        <label><span>描述</span><div><input v-model="draftDescription" maxlength="200" placeholder="请输入工作流描述" @input="changed" /><small>{{ draftDescription.length }}/200</small></div></label>
        <div class="history-tools"><button type="button" :disabled="!undoStack.length" title="撤销" aria-label="撤销" @click="undo">↶</button><button type="button" :disabled="!redoStack.length" title="重做" aria-label="重做" @click="redo">↷</button></div>
      </div>
      <p v-if="errorMessage" class="message editor-message error" role="alert">{{ errorMessage }}</p>
      <p v-else-if="successMessage" class="message editor-message success" role="status">{{ successMessage }}</p>

      <div class="editor-grid">
        <WorkflowResourcePanel :agents="activeAgents" @add="addResource" />
        <WorkflowCanvas :nodes="draftNodes" :agents="activeAgents" :selected-node-id="selectedNodeId" @select="selectedNodeId = $event" @insert="insertResource" @remove="removeNode" @reorder="reorder" />
        <WorkflowNodeInspector :node="selectedNode" :agents="activeAgents" @update="updateNode" @remove="removeNode" />
      </div>
    </template>

    <div v-if="deleteTarget" class="dialog-backdrop" role="presentation" @click.self="deleteTarget = undefined">
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-workflow-title">
        <h2 id="delete-workflow-title">删除工作流</h2><p>确定删除草稿“{{ deleteTarget.name }}”吗？此操作不可撤销。</p>
        <footer><button type="button" @click="deleteTarget = undefined">取消</button><button type="button" class="danger-solid" @click="removeWorkflow">删除</button></footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.workflow-manager{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:#f5f7fa;color:#303133;font-family:Inter,"Microsoft YaHei",sans-serif;letter-spacing:0}.list-heading,.editor-heading{display:flex;align-items:center;justify-content:space-between;min-height:64px;padding:0 18px;border-bottom:1px solid #e4e7ed;background:#fff}.list-heading p{margin:0;font-size:14px}.list-heading p span,.breadcrumb em{padding:0 7px;color:#c0c4cc;font-style:normal}.list-heading small{display:block;margin-top:5px;color:#909399;font-size:11px}.primary-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border-color:#409eff!important;background:#409eff!important;color:#fff!important}.primary-button:hover,.primary-button:focus-visible{border-color:#66b1ff!important;background:#66b1ff!important}.list-surface{display:flex;flex:1;flex-direction:column;min-height:0;margin:14px 18px 18px;border:1px solid #ebeef5;border-radius:6px;background:#fff;box-shadow:0 3px 12px rgb(31 64 115 / 4%)}.filters{display:flex;gap:10px;padding:14px}.filters label{display:flex;align-items:center;gap:7px;width:220px;height:34px;padding:0 10px;border:1px solid #dcdfe6;border-radius:4px;color:#909399}.filters input{width:100%;border:0;outline:0}.filters select{width:120px;height:34px;padding:0 10px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#606266}.message{margin:0 14px 10px;padding:8px 10px;border-radius:4px;font-size:12px}.message.error{background:#fef0f0;color:#f56c6c}.message.success{background:#f0f9eb;color:#529b2e}.table-wrap{min-height:0;overflow:auto}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:10px 12px;border-bottom:1px solid #ebeef5;text-align:left;font-size:11px;vertical-align:middle}th{background:#f5f7fa;color:#303133;font-weight:600}th:nth-child(1){width:15%}th:nth-child(2){width:18%}th:nth-child(3){width:11%}th:nth-child(4){width:20%}th:nth-child(5){width:12%}th:nth-child(6){width:8%}th:nth-child(7){width:8%}td>small{display:block;margin-top:4px;color:#909399}.name-link{padding:0;border:0;background:transparent;color:#409eff;font-weight:600;cursor:pointer}.agent-chips{display:flex;align-items:center;gap:5px;min-width:0}.agent-chips span{max-width:90px;padding:3px 8px;border-radius:11px;background:#f4f4f5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-chips em{color:#606266;font-style:normal}.node-counts{display:flex;gap:6px}.node-counts span{display:flex;align-items:center;gap:3px;color:#606266}.description-cell{color:#606266;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}time{color:#606266}.status-badge{display:inline-block;padding:3px 7px;border-radius:4px;font-size:10px}.status-badge.draft{background:#f4f4f5;color:#606266}.status-badge.published{background:#f0f9eb;color:#529b2e}.status-badge.archived{background:#f4f4f5;color:#909399}.row-actions{display:flex;gap:6px}.row-actions button,.history-tools button{display:grid;place-items:center;width:28px;height:28px;padding:0;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#606266;cursor:pointer}.row-actions button:hover,.row-actions button:focus-visible{border-color:#409eff;color:#409eff;outline:0}.row-actions .danger:hover{border-color:#f56c6c;color:#f56c6c}.empty-row{height:180px;color:#909399;text-align:center}.pagination{display:flex;justify-content:space-between;margin-top:auto;padding:11px 14px;color:#909399;font-size:11px}.pagination div{display:flex;align-items:center;gap:7px}.pagination button,.pagination strong,.pagination div span{display:grid;place-items:center;min-width:25px;height:25px;padding:0 6px;border:1px solid #dcdfe6;border-radius:4px;background:#fff}.pagination strong{border-color:#409eff;color:#409eff}.editor-heading{min-height:52px;padding:0 14px}.breadcrumb{display:flex;align-items:center;gap:8px;font-size:12px}.breadcrumb>button{width:28px;height:28px;border:0;background:transparent;color:#606266;font-size:22px;cursor:pointer}.breadcrumb i{padding:2px 6px;border-radius:4px;background:#fdf6ec;color:#b88230;font-size:10px;font-style:normal}.editor-actions{display:flex;gap:8px}.editor-actions button,.list-heading>button{height:32px;padding:0 13px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#606266;cursor:pointer}.editor-actions button:disabled{cursor:not-allowed;opacity:.55}.definition-bar{display:grid;grid-template-columns:minmax(280px,1fr) minmax(340px,1.4fr) auto;align-items:center;gap:24px;min-height:52px;padding:0 14px;border-bottom:1px solid #e4e7ed;background:#fff}.definition-bar>label{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:9px;color:#606266;font-size:11px}.definition-bar label>span em{color:#f56c6c;font-style:normal}.definition-bar label>div{position:relative}.definition-bar input{box-sizing:border-box;width:100%;height:32px;padding:0 43px 0 9px;border:1px solid #dcdfe6;border-radius:4px;outline:0}.definition-bar input:focus{border-color:#409eff}.definition-bar small{position:absolute;right:8px;top:9px;color:#c0c4cc}.history-tools{display:flex;gap:6px}.history-tools button:disabled{cursor:not-allowed;opacity:.45}.editor-message{position:absolute;z-index:20;top:108px;left:50%;min-width:260px;margin:8px 0 0;box-shadow:0 4px 12px rgb(0 0 0 / 10%);transform:translateX(-50%)}.editor-grid{display:grid;grid-template-columns:270px minmax(480px,1fr) 320px;flex:1;min-height:0;background:#fff}.dialog-backdrop{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:rgb(0 0 0 / 32%)}.confirm-dialog{width:min(420px,calc(100vw - 32px));padding:20px;border-radius:6px;background:#fff;box-shadow:0 12px 35px rgb(0 0 0 / 18%)}.confirm-dialog h2{margin:0;font-size:16px}.confirm-dialog p{margin:14px 0 20px;color:#606266;font-size:13px;line-height:1.6}.confirm-dialog footer{display:flex;justify-content:flex-end;gap:8px}.confirm-dialog button{height:32px;padding:0 14px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;cursor:pointer}.confirm-dialog .danger-solid{border-color:#f56c6c;background:#f56c6c;color:#fff}@media(max-width:1100px){.editor-grid{grid-template-columns:230px minmax(420px,1fr) 280px}.definition-bar{grid-template-columns:1fr 1fr auto}.node-counts{flex-direction:column}}@media(max-width:800px){.list-heading,.editor-heading{align-items:flex-start;gap:10px;padding:12px;flex-wrap:wrap}.list-surface{margin:10px}.filters{flex-wrap:wrap}.table-wrap{overflow-x:auto}table{min-width:1050px}.definition-bar{grid-template-columns:1fr;padding:10px;gap:8px}.editor-grid{grid-template-columns:220px minmax(520px,1fr) 280px;overflow-x:auto}.editor-message{top:170px}}
</style>
