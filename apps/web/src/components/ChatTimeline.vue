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
  ToolEventPayload
} from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import ConfirmationCard from './ConfirmationCard.vue'

const props = defineProps<{
  messages: ChatMessage[]
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

function artifactPayload(message: ChatMessage) {
  return message.messageType === 'artifact' ? (message.payload as ArtifactEventPayload | undefined) : undefined
}

function artifactFileChanges(message: ChatMessage): RuntimeFileChange[] {
  return artifactPayload(message)?.fileChanges ?? []
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

function deliveryPayload(message: ChatMessage) {
  return message.messageType === 'delivery' ? (message.payload as FinalDeliveryPayload | undefined) : undefined
}

function statusLabel(status?: string) {
  return (
    {
      allowed: 'Allowed',
      approved: 'Approved',
      blocked: 'Blocked',
      completed: 'Completed',
      failed: 'Failed',
      pending: 'Pending',
      running: 'Running'
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
      user_message_routing: '消息路由'
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
                <pre class="file-change-preview">{{ fileChangePreview(change) }}</pre>
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
