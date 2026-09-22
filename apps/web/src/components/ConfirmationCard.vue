<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ConfirmationCardState, PostReviewAction } from '@/types/contracts'
import { useWorkflowStore } from '@/stores/workflow'
import WorkflowSelectionDialog, { type WorkflowSelectionOption } from './workflow/WorkflowSelectionDialog.vue'

const props = defineProps<{
  confirmation: ConfirmationCardState
  compact?: boolean
  autoOpenWorkflowDialog?: boolean
}>()
const emit = defineEmits<{ resolve: [optionKey: string] }>()
const workflowStore = useWorkflowStore()
const showWorkflowDialog = ref(
  Boolean(props.autoOpenWorkflowDialog) &&
  props.confirmation.reason === 'select_workflow' &&
  props.confirmation.status === 'pending'
)

watch(
  () => [
    props.confirmation.confirmationId,
    props.confirmation.reason,
    props.confirmation.status,
    props.autoOpenWorkflowDialog
  ] as const,
  ([, reason, status, autoOpen]) => {
    showWorkflowDialog.value = Boolean(autoOpen) && reason === 'select_workflow' && status === 'pending'
  },
  { immediate: true }
)

const availableWorkflows = computed<WorkflowSelectionOption[]>(() => {
  if (workflowStore.workflows.length) {
    return workflowStore.publishedWorkflows
      .filter((workflow) => Boolean(workflow.currentPublishedVersion))
      .map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        version: workflow.currentPublishedVersion!,
        nodeCount: workflow.nodes.length,
        agentCount: workflow.nodes.filter((node) => node.type === 'agent').length,
        humanApprovalCount: workflow.nodes.filter((node) => node.type === 'human_approval').length,
        robotApprovalCount: workflow.nodes.filter((node) => node.type === 'robot_approval').length
      }))
  }
  return (props.confirmation.workflowOptions ?? [])
    .filter((workflow) => workflow.status === 'published')
    .map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      version: workflow.version,
      nodeCount: workflow.nodeCount,
      agentCount: workflow.agentCount ?? workflow.nodeCount,
      humanApprovalCount: workflow.humanApprovalCount ?? 0,
      robotApprovalCount: workflow.robotApprovalCount ?? 0
    }))
})

onMounted(async () => {
  if (props.confirmation.reason !== 'select_workflow') return
  try {
    await workflowStore.loadWorkflows()
  } catch {
    // The confirmation event contains a published-workflow snapshot for offline fallback.
  }
})

function selectWorkflow(workflowId: string, version: number) {
  showWorkflowDialog.value = false
  emit('resolve', `workflow:${workflowId}:${version}`)
}

function manageWorkflows() {
  showWorkflowDialog.value = false
  emit('resolve', 'manage_workflows')
}

function actionLabel(action: PostReviewAction) {
  return {
    request_workspace_context: '补读工作区',
    deliver_with_limitations: '受限交付',
    save_progress: '保存当前进度',
    cancel: '取消任务'
  }[action.action]
}

function actionStyle(action: PostReviewAction) {
  if (action.action === 'request_workspace_context') return 'primary'
  if (action.action === 'cancel') return 'danger'
  return 'default'
}

function gapReason(reason: string) {
  return ({ not_participating: '尚未加入当前会话', disabled: 'Agent 已禁用', unknown: 'Agent 不存在' } as Record<string, string>)[reason] ?? reason
}

function nodeTypeLabel(type: string) {
  return type === 'robot_approval' ? '机器人质量审核' : 'Agent 执行'
}
</script>

<template>
  <section v-if="confirmation.reason !== 'confirm_file_revision_apply'" class="confirmation-card" :class="{ compact }">
    <div class="confirmation-card__heading"><span class="status-dot" :class="confirmation.status"></span><div><h3>{{ confirmation.title }}</h3><p>{{ confirmation.description }}</p></div></div>
    <div class="confirmation-card__meta"><span>{{ confirmation.reason }}</span><span>{{ confirmation.status }}</span></div>

    <div v-if="confirmation.status === 'pending' && confirmation.reason === 'select_workflow'" class="confirmation-card__workflow-selection">
      <p>{{ availableWorkflows.length }} 个已发布工作流可用</p>
      <div class="confirmation-card__actions"><button class="action-button default" type="button" @click="manageWorkflows">管理工作流</button><button class="action-button primary" type="button" @click="showWorkflowDialog = true">选择工作流</button></div>
      <WorkflowSelectionDialog v-if="showWorkflowDialog" :workflows="availableWorkflows" @select="selectWorkflow" @manage="manageWorkflows" @close="showWorkflowDialog = false" />
    </div>

    <div v-else-if="confirmation.status === 'pending' && confirmation.reason === 'confirm_workflow_member_mapping'" class="confirmation-card__member-mapping">
      <p class="confirmation-card__workflow-context">{{ confirmation.workflowName ?? confirmation.workflowId }} · v{{ confirmation.workflowVersion ?? '未知' }}</p>
      <article v-for="gap in confirmation.memberGaps ?? []" :key="gap.agentId" class="confirmation-card__member-gap">
        <header><strong>{{ gap.agentName }}</strong><span>{{ gapReason(gap.reason) }}</span></header>
        <div v-for="node in gap.nodes ?? []" :key="node.nodeId" class="confirmation-card__node-evidence">
          <div><b>{{ node.nodeName ?? node.nodeId }}</b><span>{{ nodeTypeLabel(node.nodeType) }}</span></div>
          <p>{{ node.stageDescription || node.reviewPrompt || '流程未提供职责说明' }}</p>
          <p v-if="node.inputContract?.length">输入：{{ node.inputContract.join('；') }}</p><p v-else-if="node.nodeType === 'agent'">输入：流程未提供</p>
          <p v-if="node.outputContract?.length">输出：{{ node.outputContract.join('；') }}</p><p v-else-if="node.nodeType === 'agent'">输出：流程未提供</p>
          <p v-if="node.criteria?.length">审核标准：{{ node.criteria.join('；') }}</p><p v-else-if="node.nodeType === 'robot_approval'">审核标准：流程未提供</p>
          <p class="confirmation-card__impact">{{ node.impact }}</p>
        </div>
      </article>
      <p v-if="(confirmation.memberGaps ?? []).some(gap => gap.reason !== 'not_participating')" class="confirmation-card__blocking-note">存在不可邀请的 Agent，不能只邀请部分成员后启动。</p>
      <div class="confirmation-card__actions"><button v-for="option in confirmation.options" :key="option.key" :class="['action-button', option.style ?? 'default']" type="button" :disabled="option.key === 'approve' && (confirmation.memberGaps ?? []).some(gap => gap.reason !== 'not_participating')" @click="emit('resolve', option.key)">{{ option.label }}</button></div>
    </div>

    <div v-else-if="confirmation.status === 'pending' && confirmation.actions?.length" class="confirmation-card__structured-actions">
      <div v-for="(action, index) in confirmation.actions" :key="`${action.action}-${index}`" class="confirmation-card__structured-action">
        <div class="confirmation-card__action-copy"><strong>{{ actionLabel(action) }}</strong><p v-if="action.action === 'request_workspace_context'">{{ action.reason }}</p><p v-else-if="action.action === 'cancel' && action.reason">{{ action.reason }}</p><ul v-if="action.action === 'request_workspace_context'"><li v-for="path in action.missingPaths" :key="path">{{ path }}</li></ul><ul v-else-if="action.action === 'deliver_with_limitations'"><li v-for="limitation in action.limitations" :key="limitation">{{ limitation }}</li></ul></div>
        <button :data-action="action.action" :class="['action-button', actionStyle(action)]" type="button" @click="emit('resolve', action.action)">{{ actionLabel(action) }}</button>
      </div>
    </div>

    <div v-else-if="confirmation.status === 'pending'" class="confirmation-card__actions">
      <button v-for="option in confirmation.options" :key="option.key" :class="['action-button', option.style ?? 'default']" type="button" @click="emit('resolve', option.key)">{{ option.label }}</button>
    </div>
  </section>
</template>
