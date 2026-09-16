<script setup lang="ts">
import { computed } from 'vue'
import ChatScrollArea from './ChatScrollArea.vue'
import { useAgentStore } from '@/stores/agent'
import { actorAgentId } from '@/composables/useActor'
import type {
  ArtifactEventPayload,
  ChatMessage,
  ConfirmationCardState,
  ConfirmationRequestedPayload,
  FinalDeliveryPayload,
  RuntimeContextRequest,
  RuntimeError,
  RuntimeFileChange,
  SupplementalContextResolution,
  TaskEventPayload,
  ToolEventPayload,
  SessionStatus,
  WorkspaceSnapshot
} from '@/types/contracts'
import AgentPortrait from './AgentPortrait.vue'
import ConfirmationCard from './ConfirmationCard.vue'
import CapabilityApprovalCard from './CapabilityApprovalCard.vue'
import { observedArtifactFileChanges, platformArtifactProjections } from './artifactFileChangeModel'

const props = defineProps<{
  messages: ChatMessage[]
  sessionId?: string
  status?: SessionStatus
  disconnected?: boolean
  workspaceSnapshot?: WorkspaceSnapshot
  capabilityApprovalBusy?: boolean
}>()

const emit = defineEmits<{
  resolveConfirmation: [optionKey: string, confirmationId: string]
  approveCapability: [sessionId: string, capabilityIds: string[], agentId?: string]
}>()

const agentStore = useAgentStore()
const timeline = computed(() => collapseDuplicateFailureMessages(props.messages))

function collapseDuplicateFailureMessages(messages: ChatMessage[]) {
  const seenFailureKeys = new Set<string>()
  return messages.filter((message) => {
    const key = runtimeFailureKey(message)
    if (!key) return true
    if (seenFailureKeys.has(key)) return false
    seenFailureKeys.add(key)
    return true
  })
}

function runtimeFailureKey(message: ChatMessage) {
  const payload = message.payload ?? {}
  const status = typeof payload.status === 'string' ? payload.status : undefined
  const isFailureCard = message.messageType === 'error' || (message.messageType === 'task' && status === 'failed')
  if (!isFailureCard) return undefined

  const runtimeError = payload.runtimeError && typeof payload.runtimeError === 'object'
    ? payload.runtimeError as Record<string, unknown>
    : undefined
  const details = runtimeError?.details && typeof runtimeError.details === 'object'
    ? runtimeError.details as Record<string, unknown>
    : undefined
  const code = typeof runtimeError?.code === 'string' ? runtimeError.code : undefined
  const diagnosticRef = typeof details?.diagnosticRef === 'string' ? details.diagnosticRef : undefined
  const phase = typeof payload.phase === 'string' ? payload.phase : ''
  if (code) {
    const stableMessage = typeof runtimeError?.message === 'string' ? runtimeError.message.trim() : ''
    return `${diagnosticRef ?? (stableMessage || message.id)}:${code}:${phase}`
  }

  const sourceText = [payload.message, payload.resultSummary, payload.reason, payload.fullMessage, message.content]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim()
  if (!sourceText) return undefined

  const normalized = canonicalRuntimeFailureText(sourceText)
  if (!normalized) return undefined
  const title =
    typeof payload.title === 'string'
      ? payload.title
      : sourceText.match(/(?:运行时执行任务失败|任务执行失败)[:：]\s*([^:：\n]+)/)?.[1]?.trim() ?? ''
  return `${title}::${normalized}`
}

function canonicalRuntimeFailureText(text: string) {
  const compact = text.replace(/\s+/g, ' ').trim()
  const runtimeStart = compact.search(/(?:Tool-loop\s+)?LLM request/i)
  const runtimeText = runtimeStart >= 0 ? compact.slice(runtimeStart) : compact
  return /HTTP\s+(?:408|504|524)|RUNTIME_TIMEOUT|timed out/i.test(runtimeText) ? runtimeText : undefined
}

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
  if (payload.reason === 'approve_capability' || Array.isArray(payload.pendingApprovals)) return undefined
  return {
    confirmationId: payload.confirmationId,
    reason: payload.reason,
    title: payload.title,
    description: payload.description,
    status: (payload.status as ConfirmationCardState['status'] | undefined) ?? 'pending',
    options: payload.options,
    actions: payload.actions,
    relatedBriefId: payload.relatedBriefId as string | undefined,
    relatedTaskId: payload.relatedTaskId as string | undefined,
    relatedCapabilityId: payload.relatedCapabilityId as string | undefined,
    relatedArtifactId: payload.relatedArtifactId as string | undefined,
    workflowId: payload.workflowId as string | undefined,
    workflowName: payload.workflowName as string | undefined,
    workflowRunId: payload.workflowRunId as string | undefined,
    workflowNodeId: payload.workflowNodeId as string | undefined,
    workflowNodeRunId: payload.workflowNodeRunId as string | undefined,
    candidateAgentIds: payload.candidateAgentIds as string[] | undefined,
    expectedRunRevision: payload.expectedRunRevision as number | undefined
  }
}

function capabilityApprovalFromMessage(message: ChatMessage) {
  if (message.messageType !== 'confirmation') return undefined
  const payload = message.payload as (ConfirmationRequestedPayload & Record<string, unknown>) | undefined
  if (!payload) return undefined
  if (!Array.isArray(payload.pendingApprovals) || !payload.pendingApprovals.length) return undefined
  const approvedIds = new Set(
    props.messages
      .map((candidate) => candidate.payload?.approvalKey)
      .filter((approvalKey): approvalKey is string => typeof approvalKey === 'string')
  )
  return {
    sessionId: message.sessionId,
    pendingApprovals: payload.pendingApprovals,
    approvedApprovalIds: payload.pendingApprovals
      .map((approval) => approval.approvalId)
      .filter((approvalId) => approvedIds.has(approvalId))
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

function requestedContextPayload(message: ChatMessage): RuntimeContextRequest | undefined {
  const payload = message.payload as {
    requestedContext?: RuntimeContextRequest
    error?: { requestedContext?: RuntimeContextRequest }
    runtimeError?: { requestedContext?: RuntimeContextRequest }
  } | undefined
  return payload?.requestedContext ?? payload?.runtimeError?.requestedContext ?? payload?.error?.requestedContext
}

function requestedContextResolution(message: ChatMessage): SupplementalContextResolution | undefined {
  return (message.payload as { resolution?: SupplementalContextResolution } | undefined)?.resolution
}

function requestedContextStatus(message: ChatMessage) {
  const payload = message.payload as { rejectionReason?: string } | undefined
  if (payload?.rejectionReason) return { label: '已拒绝', tone: 'failed' }
  const resolution = requestedContextResolution(message)
  if (!resolution) return { label: '等待中', tone: 'waiting' }
  if (resolution.outcome === 'resolved') return { label: '已补充', tone: 'completed' }
  if (resolution.outcome === 'partial') return { label: '部分完成', tone: 'running' }
  if (resolution.outcome === 'cancelled') return { label: '已取消', tone: 'failed' }
  if (resolution.outcome === 'exhausted') {
    if (resolution.failedPaths.length) return { label: '读取失败', tone: 'failed' }
    if (resolution.failedRefs?.length) return { label: '引用无效', tone: 'failed' }
    return { label: '无可用内容', tone: 'failed' }
  }
  if (resolution.hydratedPaths.length && (resolution.failedPaths.length || resolution.deferredPaths.length)) {
    return { label: '部分完成', tone: 'running' }
  }
  if (resolution.hydratedPaths.length) return { label: '已补充', tone: 'completed' }
  if (resolution.failedPaths.length) return { label: '读取失败', tone: 'failed' }
  if (resolution.deferredPaths.length) return { label: '已延期', tone: 'running' }
  return { label: '无可用内容', tone: 'failed' }
}

function requestedContextRefs(message: ChatMessage) {
  return requestedContextPayload(message)?.requestedRefs ?? []
}

function requestedContextPaths(message: ChatMessage) {
  const requested = requestedContextPayload(message)
  return Array.from(new Set([
    ...(requested?.requestedFiles ?? []).map((item) => item.path),
    ...(requested?.requestedPaths ?? [])
  ]))
}

function requestedContextCommands(message: ChatMessage) {
  return requestedContextPayload(message)?.requestedCommands ?? []
}

function artifactPayload(message: ChatMessage) {
  return message.messageType === 'artifact' ? (message.payload as ArtifactEventPayload | undefined) : undefined
}

function artifactFileChanges(message: ChatMessage): RuntimeFileChange[] {
  return observedArtifactFileChanges(artifactPayload(message))
}

function artifactPlatformProjections(message: ChatMessage): RuntimeFileChange[] {
  return platformArtifactProjections(artifactPayload(message))
}

function runtimeTestArtifacts(message: ChatMessage) {
  return (artifactPayload(message)?.runtimeProposals ?? []).filter((artifact) => artifact.type === 'test_report')
}

function verifiedTestResults(message: ChatMessage) {
  return artifactPayload(message)?.systemEvidence?.verifiedTestResults ?? []
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
  return content ?? ''
}

function projectAnalysisReportChange(message: ChatMessage) {
  const payload = artifactPayload(message)
  if (!payload) return undefined
  return [...artifactPlatformProjections(message), ...artifactFileChanges(message)].find((change) => {
    const title = payload.title ?? ''
    return (
      change.path === 'agent-output/project-architecture-analysis.md' ||
      title.includes('项目架构分析') ||
      title.includes('工作区架构分析')
    )
  })
}

function projectAnalysisReportArtifact(message: ChatMessage) {
  const payload = artifactPayload(message)
  return payload?.report?.kind === 'project_architecture_analysis' ? payload.report : undefined
}

function projectAnalysisReport(message: ChatMessage) {
  const change = projectAnalysisReportChange(message)
  if (change) {
    return {
      label: change.path,
      content: fileChangePreview(change)
    }
  }

  const artifact = projectAnalysisReportArtifact(message)
  if (!artifact?.content?.trim()) return undefined
  return {
    label: artifact.title,
    content: runtimeArtifactContent(artifact.content)
  }
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
  return content
}

type DiffRow = {
  kind: 'equal' | 'add' | 'remove' | 'meta'
  text: string
}

type MessageDocumentPart =
  | {
      kind: 'paragraph'
      text: string
    }
  | {
      kind: 'list'
      items: string[]
    }

type MessageDocumentBlock = {
  heading?: string
  parts: MessageDocumentPart[]
}

const messageSectionHeadings = [
  '需求理解',
  '范围内建议',
  '范围外建议',
  '关键信息缺口与风险',
  '建议的验收标准',
  '可验证依据应用说明',
  '下一步建议',
  '关键结论'
]

const requiredColonSectionHeadings = [
  '风险',
  '结论',
  '建议',
  '背景',
  '范围',
  '验收标准',
  '下一步'
]

const sectionHeadingPattern = new RegExp(
  `\\s*(?:(${messageSectionHeadings.join('|')})[:：]?|(${requiredColonSectionHeadings.join('|')})[:：])`,
  'g'
)

function workspaceFileContent(path: string) {
  return props.workspaceSnapshot?.files.find((file) => file.path === path)?.content
}

function splitLines(content: string) {
  return content.replace(/\r\n/g, '\n').split('\n')
}

function cleanMessageText(text: string) {
  return text
    .replace(/^[\s,，;；.。:：]+/, '')
    .replace(/[\s,，;；]+$/, '')
    .trim()
}

function splitPlainParagraphs(text: string) {
  const lineParagraphs = splitLines(text)
    .map(cleanMessageText)
    .filter(Boolean)

  if (lineParagraphs.length > 1 || text.length <= 220) return lineParagraphs

  const sentences = text.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.map(cleanMessageText).filter(Boolean) ?? [text]
  const paragraphs: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if (!current) {
      current = sentence
      continue
    }

    if (current.length + sentence.length > 180) {
      paragraphs.push(current)
      current = sentence
    } else {
      current += sentence
    }
  }

  if (current) paragraphs.push(current)
  return paragraphs
}

function splitNumberedItems(text: string) {
  const matches = Array.from(text.matchAll(/(?:^|[\s,，;；.。])(\d+)[)、.）]\s*/g))
  if (matches.length < 2) return undefined

  const lead = cleanMessageText(text.slice(0, matches[0].index))
  const items = matches
    .map((match, index) => {
      const start = (match.index ?? 0) + match[0].length
      const end = index + 1 < matches.length ? matches[index + 1].index ?? text.length : text.length
      return cleanMessageText(text.slice(start, end))
    })
    .filter(Boolean)

  return items.length ? { lead, items } : undefined
}

function messagePartsFromText(text: string): MessageDocumentPart[] {
  const parts: MessageDocumentPart[] = []
  const numbered = splitNumberedItems(text)

  if (numbered) {
    if (numbered.lead) {
      parts.push({ kind: 'paragraph', text: numbered.lead })
    }
    parts.push({ kind: 'list', items: numbered.items })
    return parts
  }

  return splitPlainParagraphs(text).map((paragraph) => ({ kind: 'paragraph', text: paragraph }))
}

function messageDocumentBlocks(content: unknown): MessageDocumentBlock[] {
  const safeContent = typeof content === 'string' ? content : ''
  const normalized = cleanMessageText(safeContent.replace(/\r\n/g, '\n'))
  if (!normalized) return [{ parts: [{ kind: 'paragraph', text: '该事件缺少可展示内容' }] }]

  const marked = normalized.replace(sectionHeadingPattern, (_match, optionalHeading?: string, requiredHeading?: string) => {
    return `\u0000${optionalHeading ?? requiredHeading}：`
  })
  const sections = marked
    .split('\u0000')
    .map(cleanMessageText)
    .filter(Boolean)

  const blocks = sections.map((section) => {
    const headingMatch = section.match(/^([^：:]{1,18})[:：]\s*(.*)$/s)
    if (!headingMatch) {
      return { parts: messagePartsFromText(section) }
    }

    return {
      heading: headingMatch[1].trim(),
      parts: messagePartsFromText(headingMatch[2])
    }
  })

  return blocks.length ? blocks : [{ parts: messagePartsFromText(normalized) }]
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

function deliveryReport(message: ChatMessage) {
  const report = deliveryPayload(message)?.report
  if (report?.format === 'markdown' && report.content.trim()) return report

  for (const candidate of [...props.messages].reverse()) {
    const historical = projectAnalysisReport(candidate)
    if (!historical?.content.trim()) continue
    return {
      artifactId: artifactPayload(candidate)?.artifactId ?? 'historical-project-architecture-report',
      title: '完整系统架构说明',
      format: 'markdown' as const,
      content: historical.content,
      suggestedPath: 'agent-output/project-architecture-analysis.md',
      requiresUserConfirmation: true
    }
  }
  return undefined
}

function statusLabel(status?: string) {
  return (
    {
      allowed: '已允许',
      approved: '已批准',
      accepted: '已接受',
      assigned: '已分配',
      blocked: '阻塞',
      claimed: '已接受',
      completed: '已完成',
      failed: '失败',
      pending: '待处理',
      reworking: '返工中',
      running: '进行中',
      waiting: '等待中'
    }[status ?? ''] ?? '未知'
  )
}

function priorityLabel(priority?: string) {
  return (
    {
      low: '低',
      normal: '普通',
      high: '高',
      critical: '紧急'
    }[priority ?? ''] ?? '普通'
  )
}

function riskLevelLabel(riskLevel?: string) {
  return (
    {
      low: '低',
      medium: '中',
      high: '高',
      critical: '紧急'
    }[riskLevel ?? ''] ?? '未知'
  )
}

function recommendationLabel(recommendation?: string) {
  return (
    {
      deliver: '可以交付',
      rework: '需要返工',
      ask_user: '等待用户确认',
      running: '进行中'
    }[recommendation ?? ''] ?? '进行中'
  )
}

function artifactTypeLabel(type?: string) {
  return (
    {
      markdown: '文档',
      json: '数据',
      test_report: '测试报告',
      project_analysis: '项目分析'
    }[type ?? ''] ?? '产物'
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
      task_acceptance_decision: '接受决策',
      task_acceptance_blocked: '接受受阻',
      task_claim_declined: '拒绝接受',
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

function runtimeErrorPayload(message: ChatMessage): RuntimeError | undefined {
  const payload = errorPayload(message)
  const candidate = payload?.runtimeError ?? payload?.error
  if (!candidate || typeof candidate !== 'object') return undefined
  const runtimeError = candidate as Partial<RuntimeError>
  return typeof runtimeError.code === 'string' &&
    typeof runtimeError.message === 'string' &&
    typeof runtimeError.retryable === 'boolean'
    ? runtimeError as RuntimeError
    : undefined
}

function runtimeErrorDetails(message: ChatMessage) {
  const details = runtimeErrorPayload(message)?.details
  if (!details) return ''
  const safeDetails = Object.fromEntries(
    ['stage', 'diagnosticRef']
      .filter((key) => details[key] !== undefined)
      .map((key) => [key, details[key]])
  )
  return Object.keys(safeDetails).length > 0 ? JSON.stringify(safeDetails, null, 2) : ''
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
  <ChatScrollArea :reading-key="`web-task-reading:${sessionId ?? messages[0]?.sessionId ?? ''}`" :message-count="messages.length" :status="status" :disconnected="disconnected">
    <article
      v-for="message in timeline"
      :key="message.id"
      :data-message-id="message.id"
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
          @resolve="emit('resolveConfirmation', $event, confirmationFromMessage(message)!.confirmationId)"
        />

        <CapabilityApprovalCard
          v-else-if="capabilityApprovalFromMessage(message)"
          :session-id="capabilityApprovalFromMessage(message)!.sessionId"
          :pending-approvals="capabilityApprovalFromMessage(message)!.pendingApprovals"
          :approved-approval-ids="capabilityApprovalFromMessage(message)!.approvedApprovalIds"
          :busy="capabilityApprovalBusy"
          compact
          @approve="emit(
            'approveCapability',
            message.sessionId,
            capabilityApprovalFromMessage(message)!.pendingApprovals.map((approval) => approval.toolId),
            message.senderAgentId
          )"
        />

        <template v-else>
          <div v-if="discussionRound(message)" class="discussion-message-meta">
            第 {{ discussionRound(message) }} 轮 · {{ messageKindLabel(message) ?? 'Agent 讨论' }}
          </div>
          <div class="message-content message-document">
            <section
              v-for="(block, blockIndex) in messageDocumentBlocks(message.content)"
              :key="`${message.id}:content-block:${blockIndex}`"
              class="message-document__section"
            >
              <h4 v-if="block.heading">{{ block.heading }}</h4>
              <template
                v-for="(part, partIndex) in block.parts"
                :key="`${message.id}:content-block:${blockIndex}:part:${partIndex}`"
              >
                <p v-if="part.kind === 'paragraph'">{{ part.text }}</p>
                <ol v-else>
                  <li v-for="(item, itemIndex) in part.items" :key="`${message.id}:content-block:${blockIndex}:part:${partIndex}:item:${itemIndex}`">
                    {{ item }}
                  </li>
                </ol>
              </template>
            </section>
          </div>

          <details v-if="Number(message.payload?.collapsedStopReceiptCount) > 1" class="stop-receipt-history">
            <summary>查看 {{ message.payload?.collapsedStopReceiptCount }} 次停止回执时间</summary>
            <ul>
              <li v-for="time in (message.payload?.collapsedStopReceiptTimes as string[])" :key="time">
                {{ new Date(time).toLocaleString() }}
              </li>
            </ul>
          </details>

            <details v-if="Array.isArray(message.payload?.validationErrors)">
              <summary>查看完整校验原因</summary>
              <ul><li v-for="detail in message.payload.validationErrors" :key="String(detail)">{{ detail }}</li></ul>
            </details>
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
                <dt>索引条目</dt>
                <dd>{{ workspaceNumber(workspaceAnalysisPayload(message), 'fileCount') }}</dd>
              </div>
              <div>
                <dt>本次按需读取</dt>
                <dd>{{ workspaceNumber(workspaceAnalysisPayload(message), 'readableFileCount') }}</dd>
              </div>
              <div>
                <dt>过滤</dt>
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
              <span class="status-pill running">{{ priorityLabel(routingPlan(message)?.priority) }}</span>
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

          <div v-if="requestedContextPayload(message)" class="structured-block context-request-block">
            <div class="structured-block__heading">
              <h3>上下文请求</h3>
              <span class="status-pill" :class="requestedContextStatus(message).tone">
                {{ requestedContextStatus(message).label }}
              </span>
            </div>
            <dl>
              <div v-if="requestedContextPayload(message)?.reason">
                <dt>原因</dt>
                <dd>{{ requestedContextPayload(message)?.reason }}</dd>
              </div>
              <div v-if="requestedContextPayload(message)?.followUpInstruction">
                <dt>下一步指令</dt>
                <dd>{{ requestedContextPayload(message)?.followUpInstruction }}</dd>
              </div>
            </dl>
            <div v-if="requestedContextRefs(message).length" class="context-request-list">
              <strong>请求引用</strong>
              <code v-for="ref in requestedContextRefs(message)" :key="`${ref.type ?? 'ref'}:${ref.ref ?? ref.label}`">
                {{ [ref.type, ref.label, ref.ref].filter(Boolean).join(' / ') }}
              </code>
            </div>
            <div v-if="requestedContextPaths(message).length" class="context-request-list">
              <strong>请求路径</strong>
              <code v-for="path in requestedContextPaths(message)" :key="path">{{ path }}</code>
            </div>
            <div v-if="requestedContextCommands(message).length" class="context-request-list">
              <strong>请求命令</strong>
              <code v-for="command in requestedContextCommands(message)" :key="command">{{ command }}</code>
            </div>
            <div v-if="requestedContextResolution(message)?.hydratedPaths.length" class="context-request-list">
              <strong>已读取路径</strong>
              <code v-for="path in requestedContextResolution(message)?.hydratedPaths" :key="`hydrated:${path}`">{{ path }}</code>
            </div>
            <div v-if="requestedContextResolution(message)?.resolvedRefs?.length" class="context-request-list">
              <strong>已解析引用</strong>
              <code v-for="ref in requestedContextResolution(message)?.resolvedRefs" :key="`resolved-ref:${ref.type}:${ref.ref ?? ref.label}`">
                {{ [ref.type, ref.label, ref.ref].filter(Boolean).join(' / ') }}
              </code>
            </div>
            <div v-if="requestedContextResolution(message)?.failedRefs?.length" class="context-request-list">
              <strong>引用失败</strong>
              <code v-for="ref in requestedContextResolution(message)?.failedRefs" :key="`failed-ref:${ref.type}:${ref.ref ?? ref.label}`">
                {{ [ref.type, ref.label, ref.ref, ref.code].filter(Boolean).join(' / ') }}
              </code>
            </div>
            <div v-if="requestedContextResolution(message)?.failedPaths.length" class="context-request-list">
              <strong>读取失败</strong>
              <code v-for="item in requestedContextResolution(message)?.failedPaths" :key="`failed:${item.path}`">
                {{ item.path }} / {{ item.code }}
              </code>
            </div>
            <div v-if="requestedContextResolution(message)?.deferredPaths.length" class="context-request-list">
              <strong>延期路径</strong>
              <code v-for="path in requestedContextResolution(message)?.deferredPaths" :key="`deferred:${path}`">{{ path }}</code>
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
                <dd>{{ errorText(message, 'message') || runtimeErrorPayload(message)?.message || message.content }}</dd>
              </div>
            </dl>
            <dl v-if="runtimeErrorPayload(message)" class="runtime-error-contract">
              <div>
                <dt>错误代码</dt>
                <dd><code>{{ runtimeErrorPayload(message)?.code }}</code></dd>
              </div>
              <div>
                <dt>可重试</dt>
                <dd>{{ runtimeErrorPayload(message)?.retryable ? '可重试' : '不可重试' }}</dd>
              </div>
            </dl>
            <pre v-if="runtimeErrorDetails(message)" class="error-stack">{{ runtimeErrorDetails(message) }}</pre>
            <pre class="error-stack">{{ errorText(message, 'fullMessage') || message.content }}</pre>
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
              <div v-if="actorAgentId(taskPayload(message)?.assignedBy)">
                <dt>分配者</dt>
                <dd>{{ agentName(actorAgentId(taskPayload(message)?.assignedBy)) }}</dd>
              </div>
              <div v-if="actorAgentId(taskPayload(message)?.assignee)">
                <dt>负责 Agent</dt>
                <dd>{{ agentName(actorAgentId(taskPayload(message)?.assignee)) }}</dd>
              </div>
              <div v-if="taskPayload(message)?.handoffSuggestion">
                <dt>建议交接</dt>
                <dd>{{ taskPayload(message)?.handoffSuggestion?.targetAgentKey ?? taskPayload(message)?.handoffSuggestion?.targetAgentId ?? 'Coordinator 处理' }}：{{ taskPayload(message)?.handoffSuggestion?.reason }}</dd>
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

          <div v-if="message.messageType === 'delivery'" class="structured-block delivery-block">
            <div class="structured-block__heading">
              <h3>最终交付</h3>
              <span class="status-pill completed">已生成</span>
            </div>
            <p>{{ message.payload?.summary }}</p>
            <div
              v-if="deliveryPayload(message)?.notificationDraftArtifactId && !deliveryReport(message)"
              class="inline-metadata"
            >
              <span>Feishu draft</span>
              <strong>{{ deliveryPayload(message)?.notificationDraftArtifactId }}</strong>
            </div>
            <details v-if="deliveryReport(message)" class="delivery-report" open>
              <summary>
                <span>完整系统架构说明</span>
                <code>{{ deliveryReport(message)?.suggestedPath }}</code>
              </summary>
              <pre aria-label="完整系统架构说明正文">{{ deliveryReport(message)?.content }}</pre>
            </details>
            <section v-if="listFromPayload(message, 'completedItems').length" class="delivery-list">
              <h4>已完成</h4>
              <ul>
                <li v-for="item in listFromPayload(message, 'completedItems')" :key="`completed-${String(item)}`">{{ item }}</li>
              </ul>
            </section>
            <section v-if="listFromPayload(message, 'incompleteItems').length" class="delivery-list warning">
              <h4>未完成</h4>
              <ul>
                <li v-for="item in listFromPayload(message, 'incompleteItems')" :key="`incomplete-${String(item)}`">{{ item }}</li>
              </ul>
            </section>
            <section v-if="listFromPayload(message, 'risks').length" class="delivery-list warning">
              <h4>风险与限制</h4>
              <ul>
                <li v-for="item in listFromPayload(message, 'risks')" :key="`risk-${String(item)}`">{{ item }}</li>
              </ul>
            </section>
          </div>

          <div v-if="reviewPayload(message)" class="structured-block review-block">
            <div class="structured-block__heading">
              <h3>复盘结果</h3>
              <span class="status-pill" :class="String(reviewPayload(message)?.recommendation ?? 'running')">
                {{ recommendationLabel(String(reviewPayload(message)?.recommendation ?? 'running')) }}
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
                <dt>风险</dt>
                <dd>{{ riskLevelLabel(toolPayload(message)?.riskLevel) }}</dd>
              </div>
              <div v-if="toolPayload(message)?.requiresUserConfirmation">
                <dt>策略</dt>
                <dd>需要用户确认</dd>
              </div>
              <div v-if="toolPayload(message)?.reason">
                <dt>原因</dt>
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
              <span class="status-pill" :class="artifactPayload(message)?.type">{{ artifactTypeLabel(artifactPayload(message)?.type) }}</span>
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
                  <span :class="['status-pill', runtimeArtifactStatus(artifact)]">{{ statusLabel(runtimeArtifactStatus(artifact)) }}</span>
                </header>
                <p v-if="artifact.summary">{{ artifact.summary }}</p>
                <code v-if="runtimeArtifactCommand(artifact)">{{ runtimeArtifactCommand(artifact) }}</code>
                <pre v-if="artifact.content">{{ runtimeArtifactContent(artifact.content) }}</pre>
              </article>
            </div>
            <div v-if="verifiedTestResults(message).length" class="runtime-test-report-list">
              <h4>平台验证结果</h4>
              <article v-for="result in verifiedTestResults(message)" :key="`${result.command}:${result.completedAt}`">
                <header>
                  <strong>{{ result.command }}</strong>
                  <span :class="['status-pill', result.status]">{{ statusLabel(result.status) }}</span>
                </header>
                <code>exit {{ result.exitCode ?? '-' }}</code>
                <pre v-if="result.stdout || result.stderr">{{ [result.stdout, result.stderr].filter(Boolean).join('\n') }}</pre>
              </article>
            </div>
            <article v-if="projectAnalysisReport(message)" class="project-analysis-report">
              <header>
                <span class="file-operation create">报告</span>
                <code>{{ projectAnalysisReport(message)?.label }}</code>
              </header>
              <pre class="file-change-preview project-analysis-preview">{{ projectAnalysisReport(message)?.content }}</pre>
            </article>
            <div v-if="artifactPlatformProjections(message).length" class="file-change-list">
              <h4>平台生成的待写入文件</h4>
              <article
                v-for="change in artifactPlatformProjections(message)"
                :key="`platform:${change.operation}:${change.path}`"
                class="file-change-item"
              >
                <header>
                  <span class="file-operation" :class="change.operation">{{ fileOperationLabel(change.operation) }}</span>
                  <code>{{ change.path }}</code>
                </header>
                <pre class="file-change-diff" aria-label="平台文件投影 diff"><span
                  v-for="(row, index) in fileChangeDiffRows(change)"
                  :key="`platform:${change.path}:${index}`"
                  :class="['diff-line', row.kind]"
                ><b>{{ diffPrefix(row.kind) }}</b>{{ row.text }}</span></pre>
              </article>
            </div>
            <div v-if="artifactFileChanges(message).length" class="file-change-list">
              <h4>平台观测的文件变更</h4>
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
  </ChatScrollArea>
</template>
