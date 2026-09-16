<script setup lang="ts">
import { computed } from 'vue'
import type { CollaborationEvent } from '@/types/contracts'
import { useTaskWorkspaceStore } from '@/stores/taskWorkspace'
import { useAgentStore } from '@/stores/agent'
import { useHistoryDiffStore } from '@/stores/historyDiff'
import { actorAgentId } from '@/composables/useActor'
import { nodeTitle, executionLabel, tasksForNode } from './workflowPresentation'
import { filesFromChanges } from '@/utils/historyDiffModel'

const props = defineProps<{ events: CollaborationEvent[]; inspector?: boolean }>()
const emit = defineEmits<{ process: [confirmationId?: string]; close: []; locate: [nodeId: string] }>()
const store = useTaskWorkspaceStore()
const agents = useAgentStore()
const diff = useHistoryDiffStore()
const nodes = computed(() => (store.detail?.run.definitionSnapshot.nodes ?? []).filter(node => !props.inspector || node.id === store.selection.nodeId))
const selectedTask = computed(() => store.tasks.find(task => task.id === store.selection.taskId && task.workflowRunId === store.selection.runId && task.workflowNodeId === store.selection.nodeId))
const selectedArtifacts = computed(() => store.artifacts.filter(item => item.taskId === selectedTask.value?.id && item.sessionId === store.sessionId))
const taskEvents = computed(() => props.events.filter(event => event.metadata?.payload?.taskId === selectedTask.value?.id && event.sessionId === store.sessionId))
function openArtifact(artifactId: string, path?: string) {
  const artifact = store.artifacts.find(item => item.id === artifactId)
  if (!artifact) return
  const files = filesFromChanges(artifact.systemEvidence?.workspaceChangeSet?.changes ?? [])
  diff.open({ files, path, title: artifact.title, source: `${agents.agentName(artifact.agentId)} · ${selectedTask.value?.title ?? ''} · 第 ${selectedTask.value?.workflowAttempt ?? '—'} 轮 · 本轮执行前 → 执行后 · ${artifact.systemEvidence?.workspaceChangeSet?.id ?? '无文件版本证据'}`, sessionId: store.sessionId })
}
</script>
<template>
  <section class="execution-details" :class="{ inspector }">
    <header><h2>{{ inspector ? (selectedTask ? 'Agent 执行详情' : '节点任务') : '工作流详情' }}</h2><el-button v-if="inspector && selectedTask" text @click="store.select({ taskId: '' })">返回列表</el-button><el-button v-if="inspector" text @click="emit('close')">关闭</el-button></header>
    <template v-if="selectedTask && inspector">
      <h3>{{ selectedTask.title }}</h3><p>{{ agents.agentName(actorAgentId(selectedTask.assignee)) }} · {{ executionLabel(selectedTask.status) }} · 第 {{ selectedTask.workflowAttempt ?? '—' }} 轮</p><p>{{ selectedTask.description }}</p><small>{{ selectedTask.createdAt }} → {{ selectedTask.updatedAt }}</small>
      <h4>验收标准</h4><ul><li v-for="criterion in selectedTask.acceptanceCriteria" :key="criterion">{{ criterion }}</li></ul>
      <h4>依赖</h4><p>{{ selectedTask.dependsOnTaskIds.map(id => store.tasks.find(t => t.id === id)?.title ?? id).join('；') || '无前置任务' }}</p>
      <h4>执行结果</h4><p>{{ selectedTask.resultSummary || '尚未形成结果' }}</p>
      <h4>验证与产物</h4><p v-if="!selectedArtifacts.length">暂无产物证据</p>
      <article v-for="artifact in selectedArtifacts" :key="artifact.id"><button type="button" class="file-link" @click="diff.openArtifact(artifact.id, store.sessionId)">{{ artifact.title }}</button><p>{{ artifact.contentSummary }}</p><button v-for="file in filesFromChanges(artifact.systemEvidence?.workspaceChangeSet?.changes ?? [])" :key="file.path" type="button" class="file-link" @click="openArtifact(artifact.id, file.path)">{{ file.path }}</button><p v-for="test in artifact.systemEvidence?.verifiedTestResults ?? []" :key="`${test.command}:${test.startedAt}`">{{ test.command }} · {{ test.status === 'passed' ? '通过' : '失败' }}<details><summary>测试输出</summary><pre>{{ test.stdout }}{{ test.stderr }}</pre></details></p></article>
      <h4>实施记录</h4><article v-for="event in taskEvents" :key="event.id"><small>{{ event.createdAt }}</small><p>{{ event.content }}</p></article>
    </template>
    <template v-else>
      <p v-if="!inspector && store.detail?.run.status === 'completed'"><el-button @click="diff.openDelivery(store.selection.runId, store.sessionId)">查看最终交付文件差异</el-button></p>
      <p v-if="!nodes.length">暂无可展示的节点记录</p>
      <article v-for="node in nodes" :key="node.id" class="execution-node"><h3>{{ nodeTitle(node) }}</h3><p v-if="node.type === 'agent'">{{ node.stageDescription }}</p>
        <div v-for="attempt in store.detail?.nodeRuns.filter(item => item.nodeId === node.id) ?? []" :key="attempt.id" class="attempt"><strong>第 {{ attempt.attempt }} 轮 · {{ executionLabel(attempt.status) }}</strong><p>{{ attempt.outputSummary || attempt.error?.message }}</p><small>{{ attempt.startedAt }}<template v-if="attempt.completedAt"> → {{ attempt.completedAt }}</template></small><p v-if="attempt.status === 'waiting' && attempt.confirmationId"><el-button size="small" @click="emit('process', attempt.confirmationId)">去处理</el-button></p>
          <p v-for="approval in store.detail?.approvals.filter(item => item.nodeRunId === attempt.id) ?? []" :key="approval.id">{{ approval.decision === 'approve' ? '验证通过' : approval.decision === 'revise' ? '要求返工' : approval.decision === 'reject' ? '不通过' : '取消' }}：{{ approval.reason }} {{ approval.revisionInstruction }}</p>
        </div>
        <p v-if="!store.detail?.nodeRuns.some(item => item.nodeId === node.id)">尚未执行</p>
        <button v-for="task in tasksForNode(store.tasks, store.selection.runId, node.id, store.detail?.nodeRuns ?? [])" :key="task.id" type="button" class="execution-task" @click="store.select({ nodeId: node.id, taskId: task.id, nodeRunId: task.workflowNodeRunId ?? '' }); emit('locate', node.id)"><strong>{{ task.title }}</strong><span>{{ agents.agentName(actorAgentId(task.assignee)) }} · 第 {{ task.workflowAttempt ?? '—' }} 轮 · {{ executionLabel(task.status) }}</span></button>
        <p v-if="node.type === 'human_approval'">人工确认节点，处理动作在群聊中完成。</p>
        <p v-else-if="!tasksForNode(store.tasks, store.selection.runId, node.id, store.detail?.nodeRuns ?? []).length">尚未分配 Agent 子任务</p>
      </article>
    </template>
  </section>
</template>
<style scoped>
.execution-details { overflow:auto; min-height:0; padding:16px; color:#303133; background:#fff; }header{display:flex;align-items:center;gap:8px;border-bottom:1px solid #e4e7ed;padding-bottom:12px}h2{flex:1;font-size:16px;margin:0}h3{font-size:14px}h4{font-size:13px;margin-top:20px}p,li{font-size:13px;line-height:1.6;overflow-wrap:anywhere}small{font-size:11px;color:#606266}article{padding:12px 0;border-bottom:1px solid #ebeef5}.attempt{border-left:2px solid #dcdfe6;padding-left:12px;margin:12px 0}.execution-task{display:grid;gap:8px;width:100%;padding:12px;margin:8px 0;border:1px solid #e4e7ed;border-radius:4px;background:#f8fafc;text-align:left;color:#303133;cursor:pointer}.execution-task:hover{border-color:#409eff}.execution-task span{font-size:12px;color:#606266}.file-link{display:block;padding:6px 0;border:0;background:transparent;color:#245d96;cursor:pointer;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
