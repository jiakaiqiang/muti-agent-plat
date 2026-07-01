<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useEventStore } from '@/stores/event'
import { useKnowledgeStore } from '@/stores/knowledge'
import { useLocalWorkspaceStore } from '@/stores/localWorkspace'
import type { ReviewableFileChange } from '@/stores/localWorkspace'
import { useSessionStore } from '@/stores/session'
import { apiBaseUrl, runtimeModeLabel } from '@/config/runtime'
import {
  sessionStatusLabel,
  type BriefEventPayload,
  type RuntimeType,
  type SessionStatus,
  type SessionViewMode,
  type WorkspaceSnapshot
} from '@/types/contracts'
import AgentManager from './AgentManager.vue'
import AgentStatusPanel from './AgentStatusPanel.vue'
import AgentPortrait from './AgentPortrait.vue'
import ChatTimeline from './ChatTimeline.vue'
import CollaborationTaskBoard from './CollaborationTaskBoard.vue'
import CollaborationGraphView from './CollaborationGraphView.vue'
import CollaborationLogPanel from './CollaborationLogPanel.vue'
import DebugRuntimeView from './DebugRuntimeView.vue'
import RuntimeModelManager from './RuntimeModelManager.vue'
import SessionSidebar from './SessionSidebar.vue'
import TokenUsageIndicator from './TokenUsageIndicator.vue'
import UiIcon from './UiIcon.vue'
import UserInputBox from './UserInputBox.vue'
import WorkflowRuntimeView from './WorkflowRuntimeView.vue'

const sessionStore = useSessionStore()
const eventStore = useEventStore()
const agentStore = useAgentStore()
const knowledgeStore = useKnowledgeStore()
const localWorkspaceStore = useLocalWorkspaceStore()

const isSendingMessage = ref(false)
const inputError = ref('')
const showAgentPopover = ref(false)
const showCreateSessionDialog = ref(false)
const isCreatingSession = ref(false)
const newSessionInput = ref('')
const selectedSessionAgentIds = ref<string[]>([])
const sessionCreateError = ref('')
const sessionScanStatus = ref<'idle' | 'scanning' | 'completed' | 'failed'>('idle')
const sessionScanSummary = ref<WorkspaceSnapshot | undefined>()
const sessionRuntimeType = ref<RuntimeType | ''>('')
const workspaceDirectoryRequiredMessage = '请先选择本地工作目录'

const sessionRuntimeOptions: { value: RuntimeType | ''; label: string }[] = [
  { value: '', label: '跟随系统默认' },
  { value: 'generic_llm', label: '通用大模型（讨论/分析）' },
  { value: 'codex', label: 'Codex（读写真实代码）' },
  { value: 'claude_code', label: 'Claude Code（读写真实代码）' }
]
const showBriefRevisionDialog = ref(false)
const briefRevisionInput = ref('')
const briefRevisionError = ref('')
const isSubmittingBriefRevision = ref(false)

const showFileReviewDialog = ref(false)
const reviewChanges = ref<ReviewableFileChange[]>([])
const selectedChangePaths = ref<string[]>([])
const isReviewLoading = ref(false)
const isApplyingReview = ref(false)

type FileReviewDiffRow = { kind: 'equal' | 'add' | 'remove'; text: string }

function diffLines(before: string, after: string): FileReviewDiffRow[] {
  const beforeLines = before.replace(/\r\n/g, '\n').split('\n')
  const afterLines = after.replace(/\r\n/g, '\n').split('\n')
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

type WorkspaceSection = 'session' | 'knowledge' | 'settings' | 'models' | 'tools' | 'notifications' | 'agents'

const viewModes: SessionViewMode[] = ['chat', 'workflow', 'collaboration_graph', 'debug']
const activeSection = ref<WorkspaceSection>('session')

const railSections: Array<{ id: WorkspaceSection; label: string; icon: string }> = [
  { id: 'session', label: '工作台', icon: 'message' },
  { id: 'agents', label: 'Agent 管理', icon: 'users' },
  { id: 'knowledge', label: '知识库', icon: 'database' },
  { id: 'settings', label: '设置', icon: 'settings' },
  { id: 'models', label: '模型管理', icon: 'bot' },
  { id: 'tools', label: '工具集成', icon: 'sparkles' },
  { id: 'notifications', label: '通知中心', icon: 'bell' }
]

function isViewMode(value: string | null): value is SessionViewMode {
  return value === 'chat' || value === 'collaboration_graph' || value === 'workflow' || value === 'debug'
}

function viewModeLabel(mode: SessionViewMode) {
  return (
    {
      chat: '对话',
      collaboration_graph: '协同看板',
      workflow: '工作流',
      debug: '审计'
    } satisfies Record<SessionViewMode, string>
  )[mode]
}

function viewModeIcon(mode: SessionViewMode) {
  return (
    {
      chat: 'message',
      collaboration_graph: 'graph',
      workflow: 'workflow',
      debug: 'debug'
    } satisfies Record<SessionViewMode, string>
  )[mode]
}

function activateRailSection(section: WorkspaceSection) {
  activeSection.value = section
}

onMounted(async () => {
  const view = new URLSearchParams(window.location.search).get('view')
  if (isViewMode(view)) {
    sessionStore.switchViewMode(view)
  }

  await Promise.all([
    agentStore.loadAgents(),
    agentStore.loadCapabilities(),
    knowledgeStore.loadKnowledgeBases(),
    sessionStore.loadSessions()
  ])
  await sessionStore.loadSession()
  if (sessionStore.currentSession) {
    await eventStore.loadEvents(sessionStore.currentSession.id)
    eventStore.connectSse(sessionStore.currentSession.id)
  }
})

const currentSessionId = computed(() => sessionStore.currentSession?.id ?? '')
const events = computed(() => eventStore.eventsForSession(currentSessionId.value))
const messages = computed(() => eventStore.chatMessages(currentSessionId.value))
const agents = computed(() =>
  eventStore.agentCards(currentSessionId.value, sessionStore.currentSession?.participatingAgentIds)
)
const tasks = computed(() => eventStore.taskStates(currentSessionId.value))
const activeConfirmation = computed(() => eventStore.activeConfirmation(currentSessionId.value))
const currentMode = computed(() => sessionStore.currentViewMode)
const primaryAgent = computed(() => agents.value[0])
const workspaceLabel = computed(() => sessionStore.currentSession?.title ?? '无活动会话')
const activeAgentIds = computed(() => agentStore.agents.filter((agent) => agent.status === 'active').map((agent) => agent.id))
const runtimeDisplay = computed(() => (runtimeModeLabel === 'mock' ? 'mock' : 'real'))
const currentWorkingDirectory = computed(
  () =>
    localWorkspaceStore.directoryForSession(currentSessionId.value) ??
    sessionStore.currentSession?.workingDirectory ??
    localWorkspaceStore.pendingDirectory
)
const workingDirectoryAddress = computed(() =>
  currentWorkingDirectory.value ? `浏览器本地目录 / ${currentWorkingDirectory.value.name}` : ''
)
const pendingFileChanges = computed(() => localWorkspaceStore.pendingFileChangesForSession(currentSessionId.value))
const pendingFileChangeCount = computed(() =>
  pendingFileChanges.value.reduce((total, item) => total + item.fileChanges.length, 0)
)
const fileApplyResult = computed(() => localWorkspaceStore.applyResultForSession(currentSessionId.value))
const terminalStatuses = new Set<SessionStatus>(['COMPLETED', 'FAILED', 'CANCELLED'])

const activeBriefPayload = computed(() => {
  const briefId = activeConfirmation.value?.relatedBriefId
  if (!briefId) return undefined
  return [...eventStore.eventsForSession(currentSessionId.value)]
    .reverse()
    .map((event) => event.metadata.payload as (BriefEventPayload & Record<string, unknown>) | undefined)
    .find((payload) => payload?.briefId === briefId)
})

const latestBriefPayload = computed(() => {
  return [...eventStore.eventsForSession(currentSessionId.value)]
    .reverse()
    .filter((event) => event.type === 'brief_created' || event.type === 'brief_updated')
    .map((event) => event.metadata.payload as (BriefEventPayload & Record<string, unknown>) | undefined)
    .find((payload) => payload?.goal)
})

const derivedStatus = computed(() => {
  const statusEvent = [...eventStore.eventsForSession(currentSessionId.value)]
    .reverse()
    .find((event) => event.type === 'session_status_changed')
  return (statusEvent?.metadata.payload?.status as SessionStatus | undefined) ?? sessionStore.currentSession?.status
})

const discussion = computed(() => eventStore.discussionProgress(currentSessionId.value))

const completedTaskCount = computed(() => tasks.value.filter((task) => task.status === 'completed').length)
const progressPercent = computed(() => {
  if (!tasks.value.length) return 0
  return Math.round((completedTaskCount.value / tasks.value.length) * 100)
})

async function selectSession(sessionId: string) {
  await sessionStore.loadSession(sessionId)
  await eventStore.loadEvents(sessionId)
  eventStore.connectSse(sessionId)
}

async function deleteSession(sessionId: string) {
  const deletingCurrent = sessionStore.currentSession?.id === sessionId
  await sessionStore.deleteSession(sessionId)
  if (deletingCurrent) {
    eventStore.disconnectSse()
    const nextSessionId = sessionStore.sessions[0]?.id
    if (nextSessionId) {
      await selectSession(nextSessionId)
    }
  }
}

async function createSession(input: string, agentIds: string[], engineeringRuntimeType?: RuntimeType) {
  const workingDirectory = localWorkspaceStore.pendingDirectory
  let workspaceSnapshot: WorkspaceSnapshot | undefined
  if (workingDirectory) {
    sessionScanStatus.value = 'scanning'
    sessionScanSummary.value = undefined
    workspaceSnapshot = await localWorkspaceStore.scanPendingWorkspace()
    sessionScanSummary.value = workspaceSnapshot
    sessionScanStatus.value = 'completed'
  }
  const session = await sessionStore.createSession({
    input,
    agentIds,
    workingDirectory,
    workspaceSnapshot,
    tokenBudget: 30000,
    ...(engineeringRuntimeType ? { engineeringRuntimeType } : {})
  })
  localWorkspaceStore.bindPendingDirectoryToSession(session.id)
  await eventStore.loadEvents(session.id)
  await eventStore.replayLocalFileChanges(session.id)
  eventStore.connectSse(session.id)
}

function openCreateSessionDialog() {
  sessionCreateError.value = ''
  newSessionInput.value = ''
  selectedSessionAgentIds.value = []
  sessionScanStatus.value = 'idle'
  sessionScanSummary.value = undefined
  sessionRuntimeType.value = ''
  localWorkspaceStore.clearPendingDirectory()
  showCreateSessionDialog.value = true
}

async function chooseWorkingDirectory() {
  sessionCreateError.value = ''
  try {
    await localWorkspaceStore.choosePendingDirectory()
    sessionScanStatus.value = 'idle'
    sessionScanSummary.value = undefined
  } catch (error) {
    sessionCreateError.value = error instanceof Error ? error.message : '选择工作目录失败'
  }
}

function toggleSessionAgent(agentId: string) {
  selectedSessionAgentIds.value = selectedSessionAgentIds.value.includes(agentId)
    ? selectedSessionAgentIds.value.filter((id) => id !== agentId)
    : [...selectedSessionAgentIds.value, agentId]
}

async function createSessionFromDialog() {
  const input = newSessionInput.value.trim()
  if (!agentStore.agents.length) {
    sessionCreateError.value = '请先添加 Agent'
    return
  }
  if (!input) {
    sessionCreateError.value = '请填写会话任务'
    return
  }
  if (!selectedSessionAgentIds.value.length) {
    sessionCreateError.value = '请选择至少一个 Agent'
    return
  }
  if (!localWorkspaceStore.pendingDirectory) {
    sessionCreateError.value = workspaceDirectoryRequiredMessage
    return
  }
  isCreatingSession.value = true
  sessionCreateError.value = ''
  try {
    await createSession(input, selectedSessionAgentIds.value, sessionRuntimeType.value || undefined)
    showCreateSessionDialog.value = false
  } catch (error) {
    sessionScanStatus.value = 'failed'
    sessionCreateError.value = error instanceof Error ? error.message : '创建会话失败'
  } finally {
    isCreatingSession.value = false
  }
}

async function sendUserMessage(content: string) {
  inputError.value = ''
  isSendingMessage.value = true
  try {
    if (!sessionStore.currentSession) {
      if (!activeAgentIds.value.length) {
        inputError.value = '请先添加 Agent'
        return
      }
      await createSession(content, activeAgentIds.value)
      return
    }

    if (terminalStatuses.has(sessionStore.currentSession.status)) {
      localWorkspaceStore.reusePendingDirectoryFromSession(sessionStore.currentSession.id)
      await createSession(content, sessionStore.currentSession.participatingAgentIds)
      return
    }

    const sessionId = sessionStore.currentSession.id
    const result = await sessionStore.sendMessage(sessionId, content)
    eventStore.appendEvent(result.event)
    await eventStore.loadEvents(sessionId, { append: true })
  } catch (error) {
    inputError.value = error instanceof Error ? error.message : '发送失败'
  } finally {
    isSendingMessage.value = false
  }
}

async function resolveConfirmation(optionKey: string) {
  if (!sessionStore.currentSession || !activeConfirmation.value) return
  const sessionId = sessionStore.currentSession.id
  if (optionKey === 'approve' && activeConfirmation.value.relatedBriefId) {
    await sessionStore.confirmBrief(sessionId, activeConfirmation.value.relatedBriefId)
    await eventStore.loadEvents(sessionId)
    return
  }

  if (optionKey === 'revise' && activeConfirmation.value.relatedBriefId) {
    openBriefRevisionDialog()
    return
  }

  if (activeConfirmation.value.reason === 'resolve_contract_conflict') {
    if (optionKey === 'resume') {
      await sessionStore.resumeSession(sessionId, activeConfirmation.value.confirmationId)
    } else if (optionKey === 'cancel') {
      await sessionStore.cancelSession(sessionId, activeConfirmation.value.confirmationId)
    }
    await eventStore.loadEvents(sessionId)
    return
  }

  if (activeConfirmation.value.reason === 'confirm_memory_write') {
    if (optionKey === 'approve' && activeConfirmation.value.candidate?.content) {
      await sessionStore.confirmMemory(sessionId, {
        content: activeConfirmation.value.candidate.content,
        confirmationId: activeConfirmation.value.confirmationId,
        sourceEventId: activeConfirmation.value.candidate.sourceEventId,
        confidence: activeConfirmation.value.candidate.confidence
      })
      await eventStore.loadEvents(sessionId)
      return
    }
  }

  if (activeConfirmation.value.reason === 'confirm_feishu_notification') {
    if (optionKey === 'send_notification' || optionKey === 'skip_notification') {
      await sessionStore.decideFeishuNotification(sessionId, {
        confirmationId: activeConfirmation.value.confirmationId,
        notificationDraftArtifactId: activeConfirmation.value.relatedArtifactId,
        decision: optionKey
      })
      await eventStore.loadEvents(sessionId)
      return
    }
  }

  eventStore.appendEvent({
    id: `evt-local-${Date.now()}`,
    sessionId,
    type: 'user_confirmation_resolved',
    toAgentIds: [],
    content: `用户选择了 ${optionKey}`,
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'system_notice',
      payload: {
        confirmationId: activeConfirmation.value.confirmationId,
        status: optionKey === 'approve' ? 'approved' : 'rejected',
        selectedOptionKey: optionKey
      }
    },
    createdAt: new Date().toISOString()
  })
}

function formatBriefForRevision(brief?: BriefEventPayload) {
  if (!brief) {
    return sessionStore.currentSession?.originalInput ?? ''
  }
  return [
    `目标：${brief.goal}`,
    '',
    '范围：',
    ...brief.scope.map((item) => `- ${item}`),
    '',
    '不在范围：',
    ...brief.outOfScope.map((item) => `- ${item}`),
    '',
    '约束：',
    ...brief.constraints.map((item) => `- ${item}`),
    '',
    '验收标准：',
    ...brief.acceptanceCriteria.map((item) => `- ${item}`),
    '',
    '风险：',
    ...brief.risks.map((item) => `- ${item}`),
    '',
    '未决问题：',
    ...brief.openQuestions.map((item) => `- ${item}`),
    '',
    '任务拆分：',
    ...(brief.suggestedTasks ?? []).map((task, index) => `${index + 1}. ${task.title}：${task.description}`)
  ].join('\n')
}

function openBriefRevisionDialog() {
  briefRevisionError.value = ''
  briefRevisionInput.value = formatBriefForRevision(activeBriefPayload.value)
  showBriefRevisionDialog.value = true
}

async function submitBriefRevision() {
  if (!sessionStore.currentSession || !activeConfirmation.value?.relatedBriefId) return
  const userMessage = briefRevisionInput.value.trim()
  if (!userMessage) {
    briefRevisionError.value = '请填写修改后的需求'
    return
  }
  isSubmittingBriefRevision.value = true
  briefRevisionError.value = ''
  try {
    const sessionId = sessionStore.currentSession.id
    await sessionStore.reviseBrief(sessionId, activeConfirmation.value.relatedBriefId, {
      userMessage,
      confirmationId: activeConfirmation.value.confirmationId,
      reason: '用户修改任务契约'
    })
    showBriefRevisionDialog.value = false
    await eventStore.loadEvents(sessionId)
  } catch (error) {
    briefRevisionError.value = error instanceof Error ? error.message : '提交修改失败'
  } finally {
    isSubmittingBriefRevision.value = false
  }
}

async function applyPendingFileChanges() {
  if (!sessionStore.currentSession) return
  isReviewLoading.value = true
  try {
    const changes = await localWorkspaceStore.reviewPendingFileChanges(sessionStore.currentSession.id)
    reviewChanges.value = changes
    // Default selection: everything except conflicts (user can opt back in).
    selectedChangePaths.value = changes.filter((item) => !item.conflict).map((item) => item.change.path)
    showFileReviewDialog.value = true
  } finally {
    isReviewLoading.value = false
  }
}

function toggleReviewPath(path: string) {
  selectedChangePaths.value = selectedChangePaths.value.includes(path)
    ? selectedChangePaths.value.filter((item) => item !== path)
    : [...selectedChangePaths.value, path]
}

function selectAllReviewPaths() {
  selectedChangePaths.value = reviewChanges.value.map((item) => item.change.path)
}

function clearReviewSelection() {
  selectedChangePaths.value = []
}

async function confirmFileReview() {
  if (!sessionStore.currentSession || !selectedChangePaths.value.length) return
  isApplyingReview.value = true
  try {
    await localWorkspaceStore.applySelectedFileChanges(sessionStore.currentSession.id, selectedChangePaths.value)
    showFileReviewDialog.value = false
    reviewChanges.value = []
    selectedChangePaths.value = []
  } finally {
    isApplyingReview.value = false
  }
}

function reviewDiffRows(item: ReviewableFileChange): FileReviewDiffRow[] {
  const before =
    item.change.operation === 'create'
      ? ''
      : item.currentContent ?? item.change.previousContent ?? ''
  const after = item.change.operation === 'delete' ? '' : item.change.content ?? ''
  return diffLines(before, after)
}
</script>

<template>
  <div :class="['workspace-shell', activeSection === 'session' ? `mode-${currentMode}` : 'mode-admin', `section-${activeSection}`]">
    <nav class="app-rail" aria-label="主导航">
      <div class="brand-mark" aria-hidden="true">
        <span v-for="index in 6" :key="index"></span>
      </div>
      <div class="rail-nav">
        <button
          v-for="section in railSections"
          :key="section.id"
          type="button"
          :class="['rail-button', { active: activeSection === section.id }]"
          :title="section.label"
          @click="activateRailSection(section.id)"
        >
          <UiIcon :name="section.icon" :size="24" />
          <span>{{ section.label }}</span>
        </button>
      </div>
      <div class="rail-user">
        <AgentPortrait :tone="4" :label="primaryAgent?.name ?? 'Agent Cluster'" size="sm" />
        <strong>{{ primaryAgent?.name ?? 'Agent Cluster' }}</strong>
        <small>{{ primaryAgent?.status ?? 'idle' }}</small>
      </div>
    </nav>

    <SessionSidebar
      v-if="activeSection === 'session'"
      :sessions="sessionStore.sessions"
      :current-session-id="sessionStore.currentSession?.id"
      :favorite-session-ids="sessionStore.favoriteSessionIds"
      @select="selectSession"
      @create="openCreateSessionDialog"
      @delete="deleteSession"
      @toggle-favorite="sessionStore.toggleFavoriteSession"
    />

    <section v-if="activeSection === 'session'" class="workspace-main">
      <header class="workspace-header">
        <div class="workspace-title">
          <h1>{{ sessionStore.currentSession?.title ?? '多 Agent 协同工作平台' }}</h1>
          <p>{{ sessionStore.currentSession?.originalInput ?? '创建会话或输入任务，启动多 Agent 协作。' }}</p>
        </div>
        <div class="workspace-actions">
          <div v-if="currentMode === 'chat'" class="chat-agent-menu">
            <button class="chat-group-pill" type="button" @click="showAgentPopover = !showAgentPopover">
              <UiIcon name="users" :size="16" />
              群聊 · {{ agents.length }} Agents
            </button>
            <button class="chat-avatar-stack" type="button" aria-label="查看全部 Agent" @click="showAgentPopover = !showAgentPopover">
              <AgentPortrait
                v-for="(agent, index) in agents.slice(0, 5)"
                :key="agent.agentId"
                :tone="(index % 5) + 1"
                :label="agent.name"
                size="sm"
              />
              <b v-if="agents.length > 5">+{{ agents.length - 5 }}</b>
            </button>
            <button class="header-icon-button" type="button" title="查看全部 Agent" @click="showAgentPopover = !showAgentPopover">
              <UiIcon name="users" :size="18" />
              <span>{{ agents.length }}</span>
            </button>
            <section v-if="showAgentPopover" class="agent-popover" aria-label="全部 Agent">
              <header>
                <strong>全部 Agent</strong>
                <span>{{ agents.length }} 个成员</span>
              </header>
              <article v-for="(agent, index) in agents" :key="agent.agentId">
                <AgentPortrait :tone="(index % 5) + 1" :label="agent.name" size="sm" />
                <div>
                  <strong>{{ agent.name }}</strong>
                  <p>{{ agent.role }}</p>
                </div>
                <span :class="['agent-status', agent.status]">{{ agent.status }}</span>
              </article>
            </section>
          </div>
          <span v-if="currentMode !== 'chat'" class="project-chip">会话：{{ workspaceLabel }}</span>
          <span v-if="currentWorkingDirectory" class="workspace-directory-chip" :title="currentWorkingDirectory.name">
            <UiIcon name="folder" :size="15" />
            {{ currentWorkingDirectory.name }}
          </span>
          <button
            v-if="pendingFileChangeCount"
            type="button"
            class="workspace-file-apply-button"
            title="查看聊天中的文件变更预览后写入本地工作区"
            @click="applyPendingFileChanges"
          >
            <UiIcon name="check" :size="15" />
            确认写入 {{ pendingFileChangeCount }} 项
          </button>
          <span
            v-if="fileApplyResult"
            :class="['workspace-file-status', { failed: fileApplyResult.errors.length }]"
            :title="fileApplyResult.errors.join('\n')"
          >
            <UiIcon :name="fileApplyResult.errors.length ? 'x' : 'check'" :size="15" />
            写入 {{ fileApplyResult.applied }}/{{ fileApplyResult.applied + fileApplyResult.skipped }}
          </span>
          <span v-if="currentMode !== 'chat'" class="progress-chip">
            整体进度
            <strong>{{ progressPercent }}%</strong>
            <span><i :style="{ width: `${progressPercent}%` }"></i></span>
          </span>
          <span v-if="derivedStatus" class="session-state">
            {{ sessionStatusLabel[derivedStatus] }}
            <span v-if="derivedStatus === 'AGENT_DISCUSSING' && discussion.messageCount > 0">
              · {{ discussion.agentCount }} 个 Agent 讨论中，已有 {{ discussion.messageCount }} 条意见
            </span>
          </span>
          <span v-if="workingDirectoryAddress" class="workspace-directory-path-chip" :title="workingDirectoryAddress">
            <UiIcon name="folder" :size="15" />
            {{ workingDirectoryAddress }}
          </span>
          <span v-else class="runtime-chip">{{ runtimeDisplay }} · {{ apiBaseUrl }}</span>
          <button
            v-for="mode in viewModes"
            :key="mode"
            type="button"
            :class="['mode-button', { active: currentMode === mode }]"
            @click="sessionStore.switchViewMode(mode)"
          >
            <UiIcon :name="viewModeIcon(mode)" :size="16" />
            {{ viewModeLabel(mode) }}
          </button>
        </div>
      </header>

      <div class="workspace-content">
        <div v-if="currentMode === 'chat'" class="chat-pane">
          <CollaborationTaskBoard
            :brief="activeBriefPayload ?? latestBriefPayload"
            :tasks="tasks"
            :agents="agents"
            :events="events"
            :active-confirmation="activeConfirmation"
            @resolve-confirmation="resolveConfirmation"
          />
          <TokenUsageIndicator :session-id="currentSessionId" />
          <ChatTimeline
            :messages="messages"
            :workspace-snapshot="sessionStore.currentSession?.workspaceSnapshot"
            @resolve-confirmation="resolveConfirmation"
          />
          <UserInputBox :busy="isSendingMessage" :error="inputError" @send="sendUserMessage" />
        </div>
        <CollaborationGraphView
          v-else-if="currentMode === 'collaboration_graph'"
          :events="events"
          :agents="agents"
          :current-mode="currentMode"
          @switch-view="sessionStore.switchViewMode"
        />
        <WorkflowRuntimeView
          v-else-if="currentMode === 'workflow'"
          :events="events"
          :tasks="tasks"
          :agents="agents"
          :active-confirmation="activeConfirmation"
          :status="derivedStatus"
          :session-title="workspaceLabel"
          :current-mode="currentMode"
          @switch-view="sessionStore.switchViewMode"
        />
        <DebugRuntimeView
          v-else
          :session-id="currentSessionId"
          :events="events"
        />
      </div>
    </section>

    <CollaborationLogPanel
      v-if="activeSection === 'session' && (currentMode === 'collaboration_graph' || currentMode === 'workflow' || currentMode === 'debug')"
      :events="events"
      :agents="agents"
      :title="currentMode === 'workflow' ? '对话 / 任务日志（实时）' : currentMode === 'debug' ? '审计事件流' : '对话 / 消息日志'"
    />
    <AgentStatusPanel
      v-else-if="activeSection === 'session'"
      :agents="agents"
      :available-agents="agentStore.agents"
      :capabilities="agentStore.capabilities"
      :tasks="tasks"
      :active-confirmation="activeConfirmation"
      :connected="eventStore.sseConnected"
      @resolve-confirmation="resolveConfirmation"
    />

    <section v-else-if="activeSection === 'agents'" class="workspace-admin">
      <header class="admin-header">
        <div>
          <h1>Agent 管理</h1>
          <p>维护 Agent 列表、职责、标签、能力和启停状态。</p>
        </div>
        <span class="admin-count">{{ agentStore.agents.length }} 个 Agent</span>
      </header>
      <AgentManager :agents="agentStore.agents" :capabilities="agentStore.capabilities" />
    </section>

    <section v-else-if="activeSection === 'knowledge'" class="workspace-admin">
      <header class="admin-header">
        <div>
          <h1>知识库</h1>
          <p>查看当前后端返回的真实知识库，供 Agent 任务检索使用。</p>
        </div>
        <span class="admin-count">{{ knowledgeStore.knowledgeBases.length }} 个知识库</span>
      </header>
      <div class="admin-grid">
        <article v-for="base in knowledgeStore.knowledgeBases" :key="base.id" class="admin-card">
          <header>
            <strong>{{ base.name }}</strong>
            <span>{{ base.scope }}</span>
          </header>
          <p>{{ base.description ?? '暂无描述' }}</p>
          <dl>
            <div>
              <dt>Embedding 模型</dt>
              <dd>{{ base.embeddingModel }}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{{ base.updatedAt }}</dd>
            </div>
          </dl>
        </article>
        <p v-if="!knowledgeStore.knowledgeBases.length" class="admin-empty">暂无知识库数据。</p>
      </div>
    </section>

    <section v-else-if="activeSection === 'settings'" class="workspace-admin">
      <header class="admin-header">
        <div>
          <h1>设置</h1>
          <p>当前工作区运行状态与会话默认参数。</p>
        </div>
      </header>
      <div class="admin-grid compact">
        <article class="admin-card">
          <strong>会话默认配置</strong>
          <dl>
            <div>
              <dt>默认 token 预算</dt>
              <dd>30000</dd>
            </div>
            <div>
              <dt>当前会话</dt>
              <dd>{{ workspaceLabel }}</dd>
            </div>
          </dl>
        </article>
        <article class="admin-card">
          <strong>连接状态</strong>
          <dl>
            <div>
              <dt>SSE</dt>
              <dd>{{ eventStore.sseConnected ? '实时连接' : '未连接' }}</dd>
            </div>
            <div>
              <dt>已加载事件</dt>
              <dd>{{ events.length }}</dd>
            </div>
            <div>
              <dt>运行模式</dt>
              <dd>{{ runtimeDisplay }}</dd>
            </div>
            <div>
              <dt>后端地址</dt>
              <dd>{{ apiBaseUrl }}</dd>
            </div>
          </dl>
        </article>
      </div>
    </section>

    <section v-else-if="activeSection === 'models'" class="workspace-admin">
      <header class="admin-header">
        <div>
          <h1>模型管理</h1>
          <p>切换后续 Generic LLM 调用使用的模型，并查看 Agent 运行时配置。</p>
        </div>
        <span class="admin-count">{{ agentStore.agents.length }} 个 Agent</span>
      </header>
      <RuntimeModelManager
        :agents="agentStore.agents"
        :capability-name="agentStore.capabilityName"
      />
    </section>

    <section v-else-if="activeSection === 'tools'" class="workspace-admin">
      <header class="admin-header">
        <div>
          <h1>工具集成</h1>
          <p>查看后端能力注册表，创建 Agent 时可选择这些能力。</p>
        </div>
        <span class="admin-count">{{ agentStore.capabilities.length }} 个能力</span>
      </header>
      <div class="admin-grid">
        <article v-for="capability in agentStore.capabilities" :key="capability.id" class="admin-card">
          <header>
            <strong>{{ capability.name }}</strong>
            <span>{{ capability.riskLevel }}</span>
          </header>
          <p>{{ capability.description }}</p>
          <dl>
            <div>
              <dt>能力标识</dt>
              <dd>{{ capability.key }}</dd>
            </div>
            <div>
              <dt>风险等级</dt>
              <dd>{{ capability.riskLevel }}</dd>
            </div>
          </dl>
        </article>
        <p v-if="!agentStore.capabilities.length" class="admin-empty">暂无能力数据。</p>
      </div>
    </section>

    <section v-else-if="activeSection === 'notifications'" class="workspace-admin">
      <header class="admin-header">
        <div>
          <h1>通知中心</h1>
          <p>展示当前会话中需要关注的确认、状态和错误事件。</p>
        </div>
        <span class="admin-count">{{ events.length }} 条事件</span>
      </header>
      <div class="admin-list">
        <article
          v-for="event in events.filter((item) => item.priority === 'high' || item.type === 'user_confirmation_requested' || item.type === 'error_reported')"
          :key="event.id"
          class="admin-list-item"
        >
          <strong>{{ event.type }}</strong>
          <p>{{ event.content }}</p>
          <small>{{ event.createdAt }}</small>
        </article>
        <p
          v-if="!events.filter((item) => item.priority === 'high' || item.type === 'user_confirmation_requested' || item.type === 'error_reported').length"
          class="admin-empty"
        >
          暂无需要处理的通知。
        </p>
      </div>
    </section>

    <section v-if="showFileReviewDialog" class="modal-backdrop" aria-label="文件写回审阅">
      <div class="modal-panel session-create-dialog">
        <header>
          <div>
            <h2>审阅文件写回</h2>
            <p>逐项查看 diff，勾选要写入本地工作区的文件。冲突项默认不勾选。</p>
          </div>
          <button type="button" class="modal-close-button" @click="showFileReviewDialog = false">
            <UiIcon name="x" :size="18" />
          </button>
        </header>
        <div class="dialog-field">
          <span>已选 {{ selectedChangePaths.length }} / {{ reviewChanges.length }} 项</span>
          <div style="display:flex; gap:8px;">
            <button type="button" @click="selectAllReviewPaths">全选</button>
            <button type="button" @click="clearReviewSelection">清空</button>
          </div>
        </div>
        <div v-if="isReviewLoading">正在读取磁盘当前内容做冲突检测，稍候。</div>
        <div v-else-if="!reviewChanges.length" class="empty-state">没有待写入的文件变更。</div>
        <ul v-else style="list-style:none; padding:0; margin:0; max-height:60vh; overflow:auto;">
          <li
            v-for="item in reviewChanges"
            :key="`${item.artifactId}::${item.change.path}`"
            style="border:1px solid var(--border, #ddd); border-radius:6px; padding:10px; margin-bottom:10px;"
          >
            <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer;">
              <input
                type="checkbox"
                :checked="selectedChangePaths.includes(item.change.path)"
                @change="toggleReviewPath(item.change.path)"
              />
              <div style="flex:1; min-width:0;">
                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                  <strong style="word-break:break-all;">{{ item.change.path }}</strong>
                  <span class="tag">{{ item.change.operation }}</span>
                  <span v-if="item.conflict" class="tag" style="color:#b00;">磁盘已变化（冲突）</span>
                  <span v-if="item.artifactTitle" class="tag muted">{{ item.artifactTitle }}</span>
                </div>
                <pre
                  style="margin:8px 0 0; padding:8px; background:#0b0b0b08; border-radius:4px; max-height:240px; overflow:auto; font-size:12px; white-space:pre-wrap;"
                ><span
                    v-for="(row, index) in reviewDiffRows(item)"
                    :key="index"
                    :style="{ display:'block', color: row.kind === 'add' ? '#0a7' : row.kind === 'remove' ? '#b00' : 'inherit' }"
                  >{{ row.kind === 'add' ? '+ ' : row.kind === 'remove' ? '- ' : '  ' }}{{ row.text }}</span></pre>
              </div>
            </label>
          </li>
        </ul>
        <footer class="form-actions">
          <button type="button" @click="showFileReviewDialog = false">取消</button>
          <button
            type="button"
            class="primary"
            :disabled="!selectedChangePaths.length || isApplyingReview"
            @click="confirmFileReview"
          >
            {{ isApplyingReview ? '写入中' : `写入 ${selectedChangePaths.length} 项` }}
          </button>
        </footer>
      </div>
    </section>

    <section v-if="showCreateSessionDialog" class="modal-backdrop" aria-label="新建会话">
      <form class="modal-panel session-create-dialog" @submit.prevent="createSessionFromDialog">
        <header>
          <div>
            <h2>新建会话</h2>
            <p>选择真实 Agent，并输入本次协作任务。</p>
          </div>
          <button type="button" class="modal-close-button" @click="showCreateSessionDialog = false">
            <UiIcon name="x" :size="18" />
          </button>
        </header>
        <label class="dialog-field">
          <span>任务</span>
          <textarea v-model="newSessionInput" rows="4" placeholder="描述要让 Agent 协作完成的目标" />
        </label>
        <div class="dialog-directory-picker">
          <span>本地工作目录</span>
          <button type="button" @click="chooseWorkingDirectory">
            <UiIcon name="folder" :size="16" />
            {{ localWorkspaceStore.pendingDirectory ? '更换目录' : '选择目录' }}
          </button>
          <strong v-if="localWorkspaceStore.pendingDirectory" :title="localWorkspaceStore.pendingDirectory.name">
            {{ localWorkspaceStore.pendingDirectory.name }}
          </strong>
          <small v-else-if="!localWorkspaceStore.supportsDirectoryPicker">
            当前浏览器不支持选择本地目录
          </small>
          <small v-else class="directory-required-message">
            {{ workspaceDirectoryRequiredMessage }}
          </small>
        </div>
        <label class="dialog-field">
          <span>执行运行时</span>
          <select v-model="sessionRuntimeType">
            <option v-for="option in sessionRuntimeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <small v-if="sessionRuntimeType === 'codex' || sessionRuntimeType === 'claude_code'">
            该运行时可读取并真实修改所选目录里的文件，需后端启用对应开关，高风险操作仍需确认。
          </small>
        </label>
        <section
          v-if="localWorkspaceStore.pendingDirectory || sessionScanStatus !== 'idle'"
          class="workspace-scan-summary"
        >
          <header>
            <strong>工作区读取</strong>
            <span :class="['status-pill', sessionScanStatus]">
              {{
                sessionScanStatus === 'scanning'
                  ? '扫描中'
                  : sessionScanStatus === 'completed'
                    ? '已完成'
                    : sessionScanStatus === 'failed'
                      ? '失败'
                      : '待创建时扫描'
              }}
            </span>
          </header>
          <p v-if="sessionScanStatus === 'idle'">
            创建会话时会先读取目录结构、可读文本文件、技术栈信号和跳过原因，再下发给 Coordinator。
          </p>
          <p v-else-if="sessionScanStatus === 'scanning'">正在读取工作区上下文，稍等一下。</p>
          <dl v-if="sessionScanSummary">
            <div>
              <dt>工作区</dt>
              <dd>{{ sessionScanSummary.rootName }}</dd>
            </div>
            <div>
              <dt>扫描条目</dt>
              <dd>{{ sessionScanSummary.fileCount }}</dd>
            </div>
            <div>
              <dt>可读文件</dt>
              <dd>{{ sessionScanSummary.files.length }}</dd>
            </div>
            <div>
              <dt>跳过</dt>
              <dd>{{ sessionScanSummary.skipped.length }}</dd>
            </div>
            <div>
              <dt>技术栈</dt>
              <dd>{{ sessionScanSummary.detectedStack?.join(', ') || '未识别' }}</dd>
            </div>
          </dl>
          <p v-if="sessionScanSummary?.skipped.some((file) => file.reason === 'sensitive')" class="scan-warning">
            已跳过 .env、密钥、证书等敏感文件。
          </p>
        </section>
        <div class="dialog-agent-picker">
          <span>参与 Agent</span>
          <p v-if="!agentStore.agents.length" class="empty-state">暂无 Agent，请先到 Agent 管理添加 Agent。</p>
          <button
            v-for="agent in agentStore.agents"
            :key="agent.id"
            type="button"
            :class="{ selected: selectedSessionAgentIds.includes(agent.id) }"
            @click="toggleSessionAgent(agent.id)"
          >
            <strong>{{ agent.name }}</strong>
            <small>{{ agent.role }}</small>
          </button>
        </div>
        <p v-if="sessionCreateError" class="form-error">{{ sessionCreateError }}</p>
        <footer class="form-actions">
          <button type="button" @click="showCreateSessionDialog = false">取消</button>
          <button type="submit" class="primary" :disabled="isCreatingSession">
            {{ isCreatingSession ? '创建中' : '创建会话' }}
          </button>
        </footer>
      </form>
    </section>

    <section v-if="showBriefRevisionDialog" class="modal-backdrop" aria-label="修改任务契约">
      <form class="modal-panel brief-revision-dialog" @submit.prevent="submitBriefRevision">
        <header>
          <div>
            <h2>修改任务契约</h2>
            <p>基于 Coordinator 输出的需求理解和拆分调整，提交后会重新组织 Agent 讨论。</p>
          </div>
          <button type="button" class="modal-close-button" @click="showBriefRevisionDialog = false">
            <UiIcon name="x" :size="18" />
          </button>
        </header>
        <label class="dialog-field">
          <span>修改后的需求</span>
          <textarea v-model="briefRevisionInput" rows="14" />
        </label>
        <p v-if="briefRevisionError" class="form-error">{{ briefRevisionError }}</p>
        <footer class="form-actions">
          <button type="button" @click="showBriefRevisionDialog = false">取消</button>
          <button type="submit" class="primary" :disabled="isSubmittingBriefRevision">
            {{ isSubmittingBriefRevision ? '提交中' : '提交修改' }}
          </button>
        </footer>
      </form>
    </section>
  </div>
</template>
