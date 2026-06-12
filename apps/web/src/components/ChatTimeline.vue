<script setup lang="ts">
import { computed } from 'vue'
import { useAgentStore } from '@/stores/agent'
import type {
  ArtifactEventPayload,
  ChatMessage,
  ConfirmationCardState,
  ConfirmationRequestedPayload,
  FinalDeliveryPayload,
  RuntimeFileChange,
  TaskEventPayload,
  ToolEventPayload,
  WorkspaceSnapshot
} from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import ConfirmationCard from './ConfirmationCard.vue'

const props = defineProps<{
  messages: ChatMessage[]
  workspaceSnapshot?: WorkspaceSnapshot
}>()

const emit = defineEmits<{
  resolveConfirmation: [optionKey: string]
}>()

const agentStore = useAgentStore()
const timeline = computed(() => props.messages)

function senderLabel(message: ChatMessage) {
  if (message.senderType === 'user') return '你'
  if (message.senderType === 'agent') return agentStore.agentName(message.senderAgentId)
  return '系统'
}

function agentName(agentId?: string) {
  return agentId ? agentStore.agentName(agentId) : ''
}

function agentTone(message: ChatMessage) {
  const index = agentStore.agents.findIndex((agent) => agent.id === message.senderAgentId)
  if (message.senderType === 'system') return 'system'
  if (message.senderType === 'user') return 'user'
  return ((index < 0 ? 0 : index) % 5) + 1
}

function confirmationFromMessage(message: ChatMessage): ConfirmationCardState | undefined {
  if (message.messageType !== 'confirmation') return undefined
  const payload = message.payload as (ConfirmationRequestedPayload & Record<string, unknown>) | undefined
  if (!payload) return undefined
  return {
    confirmationId: payload.confirmationId,
    reason: payload.reason,
    title: payload.title,
    description: payload.description,
    status: (payload.status as ConfirmationCardState['status'] | undefined) ?? 'pending',
    options: payload.options,
    relatedBriefId: payload.relatedBriefId as string | undefined,
    relatedTaskId: payload.relatedTaskId as string | undefined,
    relatedCapabilityId: payload.relatedCapabilityId as string | undefined,
    relatedArtifactId: payload.relatedArtifactId as string | undefined
  }
}

function listFromPayload(message: ChatMessage, key: string) {
  const value = message.payload?.[key]
  return Array.isArray(value) ? value : []
}

function toolPayload(message: ChatMessage) {
  if (message.messageType !== 'tool') return undefined
  const payload = message.payload as ToolEventPayload | undefined
  return payload?.capabilityId || payload?.capabilityName ? payload : undefined
}

function taskPayload(message: ChatMessage) {
  return message.messageType === 'task' ? (message.payload as TaskEventPayload | undefined) : undefined
}

function artifactPayload(message: ChatMessage) {
  return message.messageType === 'artifact' ? (message.payload as ArtifactEventPayload | undefined) : undefined
}

function artifactFileChanges(message: ChatMessage): RuntimeFileChange[] {
  return artifactPayload(message)?.fileChanges ?? []
}

function runtimeTestArtifacts(message: ChatMessage) {
  return (artifactPayload(message)?.runtimeArtifacts ?? []).filter((artifact) => artifact.type === 'test_report')
}

function runtimeArtifactStatus(artifact: { metadata?: Record<string, unknown> }) {
  const status = artifact.metadata?.status
  return typeof status === 'string' ? status : 'unknown'
}

function runtimeArtifactCommand(artifact: { metadata?: Record<string, unknown> }) {
  const command = artifact.metadata?.command
  return typeof command === 'string' ? command : undefined
}

function runtimeArtifactContent(content?: string) {
  if (!content) return ''
  return content.length > 1200 ? `${content.slice(0, 1200)}...` : content
}

function projectAnalysisReportChange(message: ChatMessage) {
  const payload = artifactPayload(message)
  if (!payload) return undefined
  return artifactFileChanges(message).find((change) => {
    const title = payload.title ?? ''
    return (
      change.path === 'agent-output/project-architecture-analysis.md' ||
      title.includes('项目架构分析') ||
      title.includes('工作区架构分析')
    )
  })
}

function workspaceAnalysisPayload(message: ChatMessage) {
  if (message.payload?.phase !== 'workspace_analysis') return undefined
  const workspace = message.payload.workspace as Record<string, unknown> | undefined
  return workspace
}

function workspaceList(workspace: Record<string, unknown> | undefined, key: string) {
  const value = workspace?.[key]
  return Array.isArray(value) ? value.map(String) : []
}

function workspaceNumber(workspace: Record<string, unknown> | undefined, key: string) {
  const value = workspace?.[key]
  return typeof value === 'number' ? value : 0
}

function fileOperationLabel(operation: RuntimeFileChange['operation']) {
  return (
    {
      create: '新增',
      update: '修改',
      delete: '删除'
    }[operation] ?? operation
  )
}

function fileChangePreview(change: RuntimeFileChange) {
  if (change.operation === 'delete') return '该文件将在选择的目录中删除。'
  const content = change.content?.trim()
  if (!content) return '该文件变更没有提供内容预览。'
  return content.length > 1200 ? `${content.slice(0, 1200)}...` : content
}

type DiffRow = {
  kind: 'equal' | 'add' | 'remove' | 'meta'
  text: string
}

function workspaceFileContent(path: string) {
  return props.workspaceSnapshot?.files.find((file) => file.path === path)?.content
}

function splitLines(content: string) {
  return content.replace(/\r\n/g, '\n').split('\n')
}

function compactDiffRows(before: string, after: string): DiffRow[] {
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1
  }

  let beforeSuffix = beforeLines.length - 1
  let afterSuffix = afterLines.length - 1
  while (
    beforeSuffix >= prefix &&
    afterSuffix >= prefix &&
    beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix -= 1
    afterSuffix -= 1
  }

  return [
    ...beforeLines.slice(0, prefix).map((text) => ({ kind: 'equal' as const, text })),
    ...beforeLines.slice(prefix, beforeSuffix + 1).map((text) => ({ kind: 'remove' as const, text })),
    ...afterLines.slice(prefix, afterSuffix + 1).map((text) => ({ kind: 'add' as const, text })),
    ...afterLines.slice(afterSuffix + 1).map((text) => ({ kind: 'equal' as const, text }))
  ]
}

function fileChangeDiffRows(change: RuntimeFileChange): DiffRow[] {
  const before = change.operation === 'create' ? '' : workspaceFileContent(change.path)
  const after = change.operation === 'delete' ? '' : change.content ?? ''

  if (before === undefined && change.operation !== 'create') {
    return [
      { kind: 'meta', text: '原始内容不在当前工作区快照中，只展示 runtime 生成的目标内容。' },
      ...splitLines(after).map((text) => ({ kind: 'add' as const, text }))
    ]
  }

  return compactDiffRows(before ?? '', after)
}

function diffPrefix(kind: DiffRow['kind']) {
  return (
    {
      add: '+',
      remove: '-',
      equal: ' ',
      meta: '!'
    }[kind] ?? ' '
  )
}

function deliveryPayload(message: ChatMessage) {
  return message.messageType === 'delivery' ? (message.payload as FinalDeliveryPayload | undefined) : undefined
}

function statusLabel(status?: string) {
  return (
    {
      allowed: 'Allowed',
      approved: 'Approved',
      blocked: 'Blocked',
      claimed: '已接受',
      completed: 'Completed',
      failed: 'Failed',
      pending: 'Pending',
      reworking: '返工中',
      running: 'Running',
      waiting: 'Waiting'
    }[status ?? ''] ?? status ?? 'Unknown'
  )
}

function capabilityLabel(capabilityId?: string) {
  return capabilityId ? agentStore.capabilityName(capabilityId) : undefined
}

function phaseLabel(phase?: string) {
  return (
    {
      discussion: 'Agent 讨论',
      brief_generation: '任务契约生成',
      brief_revision: '任务契约修订',
      task_brief: '任务契约生成',
      task_execution: '任务执行',
      post_review: '复盘评估',
      final_delivery: '最终交付',
      workspace_analysis: '工作区分析',
      user_message_routing: '消息路由',
      task_claim_decision: '接单决策',
      task_claim_declined: '拒单转派',
      agent_runtime_communication: 'Agent 通信'
    }[phase ?? ''] ?? phase ?? '未知阶段'
  )
}

function discussionRound(message: ChatMessage) {
  const round = message.payload?.round
  return typeof round === 'number' ? round : undefined
}

function messageKindLabel(message: ChatMessage) {
  const kind = message.payload?.messageKind
  if (typeof kind !== 'string') return undefined
  return (
    {
      discussion: 'Agent 讨论',
      answer: '答复',
      handoff: '交接',
      progress: '进展',
      risk: '风险',
      decision: '决策',
      summary: '总结'
    }[kind] ?? kind
  )
}

function errorPayload(message: ChatMessage) {
  return message.messageType === 'error' ? (message.payload as Record<string, unknown> | undefined) : undefined
}

function errorText(message: ChatMessage, key: string) {
  const value = errorPayload(message)?.[key]
  return typeof value === 'string' ? value : ''
}

function reviewPayload(message: ChatMessage) {
  return message.messageType === 'review' ? message.payload : undefined
}

function routingPlan(message: ChatMessage) {
  if (message.payload?.phase !== 'user_message_routing') return undefined
  return message.payload.handlingPlan as
    | {
        intent?: string
        priority?: string
        shouldPause?: boolean
        affectedTaskIds?: string[]
        affectedAgentIds?: string[]
        requiresBriefRevision?: boolean
        requiresUserConfirmation?: boolean
        coordinatorInstruction?: string
      }
    | undefined
}

function routingAgentNames(message: ChatMessage) {
  const plan = routingPlan(message)
  return (plan?.affectedAgentIds ?? message.toAgentIds ?? []).map((agentId) => agentName(agentId))
}

function yesNo(value?: boolean) {
  return value ? '是' : '否'
}
</script>

<template>
  <main class="chat-timeline">
    <article
      v-for="message in timeline"
      :key="message.id"
      class="timeline-item"
      :class="[message.senderType, message.messageType]"
    >
      <AgentPortrait :tone="agentTone(message)" :label="senderLabel(message)" size="md" />
      <div class="message-bubble">
        <header class="message-header">
          <strong>{{ senderLabel(message) }}</strong>
          <span>{{ new Date(message.createdAt).toLocaleTimeString() }}</span>
        </header>

        <ConfirmationCard
          v-if="confirmationFromMessage(message)"
          :confirmation="confirmationFromMessage(message)!"
          compact
          @resolve="emit('resolveConfirmation', $event)"
        />

        <template v-else>
          <div v-if="discussionRound(message)" class="discussion-message-meta">
            第 {{ discussionRound(message) }} 轮 · {{ messageKindLabel(message) ?? 'Agent 讨论' }}
          </div>
          <p class="message-content">{{ message.content }}</p>

          <div v-if="workspaceAnalysisPayload(message)" class="structured-block workspace-analysis-block">
            <div class="structured-block__heading">
              <h3>工作区分析</h3>
              <span class="status-pill completed">已完成</span>
            </div>
            <dl>
              <div>
                <dt>工作区</dt>
                <dd>{{ workspaceAnalysisPayload(message)?.rootName }}</dd>
              </div>
              <div>
                <dt>扫描条目</dt>
                <dd>{{ workspaceNumber(workspaceAnalysisPayload(message), 'fileCount') }}</dd>
              </div>
              <div>
                <dt>可读文件</dt>
                <dd>{{ workspaceNumber(workspaceAnalysisPayload(message), 'readableFileCount') }}</dd>
              </div>
              <div>
                <dt>跳过</dt>
                <dd>{{ workspaceNumber(workspaceAnalysisPayload(message), 'skippedFileCount') }}</dd>
              </div>
              <div>
                <dt>技术栈</dt>
                <dd>{{ workspaceList(workspaceAnalysisPayload(message), 'detectedStack').join(', ') || '未识别' }}</dd>
              </div>
            </dl>
            <div v-if="workspaceList(workspaceAnalysisPayload(message), 'relevantFiles').length" class="workspace-file-chips">
              <strong>重点文件</strong>
              <code
                v-for="file in workspaceList(workspaceAnalysisPayload(message), 'relevantFiles').slice(0, 8)"
                :key="file"
              >
                {{ file }}
              </code>
            </div>
          </div>

          <div v-if="routingPlan(message)" class="structured-block routing-block">
            <div class="structured-block__heading">
              <h3>补充需求路由</h3>
              <span class="status-pill running">{{ routingPlan(message)?.priority ?? 'normal' }}</span>
            </div>
            <dl>
              <div>
                <dt>意图</dt>
                <dd>{{ routingPlan(message)?.intent ?? 'constraint' }}</dd>
              </div>
              <div>
                <dt>暂停当前执行</dt>
                <dd>{{ yesNo(routingPlan(message)?.shouldPause) }}</dd>
              </div>
              <div>
                <dt>重订任务契约</dt>
                <dd>{{ yesNo(routingPlan(message)?.requiresBriefRevision) }}</dd>
              </div>
              <div>
                <dt>需要用户确认</dt>
                <dd>{{ yesNo(routingPlan(message)?.requiresUserConfirmation) }}</dd>
              </div>
            </dl>
            <div v-if="routingAgentNames(message).length" class="routing-chip-list">
              <strong>已同步 Agent</strong>
              <span v-for="name in routingAgentNames(message)" :key="name">{{ name }}</span>
            </div>
            <div v-if="routingPlan(message)?.affectedTaskIds?.length" class="routing-chip-list">
              <strong>关联任务</strong>
              <code v-for="taskId in routingPlan(message)?.affectedTaskIds" :key="taskId">{{ taskId }}</code>
            </div>
            <p v-if="routingPlan(message)?.coordinatorInstruction" class="routing-instruction">
              {{ routingPlan(message)?.coordinatorInstruction }}
            </p>
          </div>

          <div v-if="errorPayload(message)" class="structured-block error-block">
            <div class="structured-block__heading">
              <h3>错误详情</h3>
              <span class="status-pill failed">{{ phaseLabel(errorText(message, 'phase')) }}</span>
            </div>
            <dl>
              <div>
                <dt>阶段</dt>
                <dd>{{ errorText(message, 'phaseLabel') || phaseLabel(errorText(message, 'phase')) }}</dd>
              </div>
              <div>
                <dt>错误</dt>
                <dd>{{ errorText(message, 'message') || message.content }}</dd>
              </div>
            </dl>
            <pre v-if="errorText(message, 'stack')" class="error-stack">{{ errorText(message, 'stack') }}</pre>
            <pre v-else class="error-stack">{{ errorText(message, 'fullMessage') || message.content }}</pre>
          </div>

          <div v-if="message.messageType === 'brief'" class="structured-block">
            <h3>{{ message.payload?.goal }}</h3>
            <dl>
              <div>
                <dt>Scope</dt>
                <dd>{{ listFromPayload(message, 'scope').join(', ') }}</dd>
              </div>
              <div>
                <dt>Acceptance</dt>
                <dd>{{ listFromPayload(message, 'acceptanceCriteria').join(', ') }}</dd>
              </div>
              <div>
                <dt>Risks</dt>
                <dd>{{ listFromPayload(message, 'risks').join(', ') }}</dd>
              </div>
            </dl>
          </div>

          <div v-if="taskPayload(message)" class="structured-block task-block">
            <div class="structured-block__heading">
              <h3>{{ taskPayload(message)?.title ?? message.content }}</h3>
              <span class="status-pill" :class="taskPayload(message)?.status">
                {{ statusLabel(taskPayload(message)?.status) }}
              </span>
            </div>
            <p v-if="taskPayload(message)?.description">{{ taskPayload(message)?.description }}</p>
            <dl>
              <div v-if="taskPayload(message)?.assigneeAgentId">
                <dt>Agent</dt>
                <dd>{{ agentName(taskPayload(message)?.assigneeAgentId) }}</dd>
              </div>
              <div v-if="taskPayload(message)?.resultSummary">
                <dt>结果</dt>
                <dd>{{ taskPayload(message)?.resultSummary }}</dd>
              </div>
            </dl>
            <ul v-if="taskPayload(message)?.acceptanceCriteria?.length">
              <li v-for="item in taskPayload(message)?.acceptanceCriteria" :key="item">{{ item }}</li>
            </ul>
          </div>

          <div v-if="message.messageType === 'delivery'" class="structured-block">
            <h3>{{ message.payload?.summary }}</h3>
            <div v-if="deliveryPayload(message)?.notificationDraftArtifactId" class="inline-metadata">
              <span>Feishu draft</span>
              <strong>{{ deliveryPayload(message)?.notificationDraftArtifactId }}</strong>
            </div>
            <ul>
              <li v-for="item in listFromPayload(message, 'completedItems')" :key="String(item)">{{ item }}</li>
            </ul>
          </div>

          <div v-if="reviewPayload(message)" class="structured-block review-block">
            <div class="structured-block__heading">
              <h3>复盘结果</h3>
              <span class="status-pill" :class="String(reviewPayload(message)?.recommendation ?? 'running')">
                {{ reviewPayload(message)?.recommendation ?? '进行中' }}
              </span>
            </div>
            <p>{{ message.content }}</p>
            <ul>
              <li v-for="item in listFromPayload(message, 'matchedItems')" :key="`matched-${String(item)}`">
                {{ item }}
              </li>
              <li v-for="item in listFromPayload(message, 'missingItems')" :key="`missing-${String(item)}`">
                缺失：{{ item }}
              </li>
              <li v-for="item in listFromPayload(message, 'testResults')" :key="`test-${String(item)}`">
                测试：{{ item }}
              </li>
            </ul>
          </div>

          <div v-if="toolPayload(message)" class="structured-block tool-block">
            <div class="structured-block__heading">
              <h3>{{ toolPayload(message)?.capabilityName ?? 'Capability' }}</h3>
              <span class="status-pill" :class="toolPayload(message)?.status">
                {{ statusLabel(toolPayload(message)?.status) }}
              </span>
            </div>
            <dl>
              <div>
                <dt>Risk</dt>
                <dd>{{ toolPayload(message)?.riskLevel ?? 'unknown' }}</dd>
              </div>
              <div v-if="toolPayload(message)?.requiresUserConfirmation">
                <dt>Policy</dt>
                <dd>User confirmation required</dd>
              </div>
              <div v-if="toolPayload(message)?.reason">
                <dt>Reason</dt>
                <dd>{{ toolPayload(message)?.reason }}</dd>
              </div>
              <div v-if="toolPayload(message)?.code">
                <dt>Code</dt>
                <dd>{{ toolPayload(message)?.code }}</dd>
              </div>
            </dl>
          </div>

          <div v-if="artifactPayload(message)" class="structured-block artifact-block">
            <div class="structured-block__heading">
              <h3>{{ artifactPayload(message)?.title }}</h3>
              <span class="status-pill" :class="artifactPayload(message)?.type">{{ artifactPayload(message)?.type }}</span>
            </div>
            <p v-if="artifactPayload(message)?.contentSummary">{{ artifactPayload(message)?.contentSummary }}</p>
            <p v-if="artifactPayload(message)?.relatedCapabilityId">
              Capability: {{ capabilityLabel(artifactPayload(message)?.relatedCapabilityId) }}
            </p>
            <div v-if="runtimeTestArtifacts(message).length" class="runtime-test-report-list">
              <h4>测试报告</h4>
              <article v-for="artifact in runtimeTestArtifacts(message)" :key="`${artifact.title}:${runtimeArtifactCommand(artifact) ?? ''}`">
                <header>
                  <strong>{{ artifact.title }}</strong>
                  <span :class="['status-pill', runtimeArtifactStatus(artifact)]">{{ runtimeArtifactStatus(artifact) }}</span>
                </header>
                <p v-if="artifact.summary">{{ artifact.summary }}</p>
                <code v-if="runtimeArtifactCommand(artifact)">{{ runtimeArtifactCommand(artifact) }}</code>
                <pre v-if="artifact.content">{{ runtimeArtifactContent(artifact.content) }}</pre>
              </article>
            </div>
            <article v-if="projectAnalysisReportChange(message)" class="project-analysis-report">
              <header>
                <span class="file-operation create">报告</span>
                <code>{{ projectAnalysisReportChange(message)?.path }}</code>
              </header>
              <pre class="file-change-preview project-analysis-preview">{{ fileChangePreview(projectAnalysisReportChange(message)!) }}</pre>
            </article>
            <div v-if="artifactFileChanges(message).length" class="file-change-list">
              <h4>文件修改</h4>
              <article
                v-for="change in artifactFileChanges(message)"
                :key="`${change.operation}:${change.path}`"
                class="file-change-item"
              >
                <header>
                  <span class="file-operation" :class="change.operation">{{ fileOperationLabel(change.operation) }}</span>
                  <code>{{ change.path }}</code>
                </header>
                <pre class="file-change-diff" aria-label="文件变更 diff"><span
                  v-for="(row, index) in fileChangeDiffRows(change)"
                  :key="`${change.path}:${index}`"
                  :class="['diff-line', row.kind]"
                ><b>{{ diffPrefix(row.kind) }}</b>{{ row.text }}</span></pre>
              </article>
            </div>
          </div>

          <div v-if="message.messageType === 'rag'" class="structured-block">
            <h3>{{ message.payload?.query }}</h3>
            <p
              v-for="chunk in (message.payload?.matchedChunks as Array<Record<string, unknown>> | undefined) ?? []"
              :key="String(chunk.chunkId)"
            >
              {{ chunk.title }}: {{ chunk.snippet }}
            </p>
          </div>
        </template>
      </div>
    </article>
  </main>
</template>
