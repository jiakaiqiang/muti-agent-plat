<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import { useEventStore } from '@/stores/event'
import { useLocalWorkspaceStore } from '@/stores/localWorkspace'
import type { ReviewableFileChange } from '@/stores/localWorkspace'
import { useSessionStore } from '@/stores/session'
import { useRuntimeModelStore } from '@/stores/runtimeModel'
import { useWorkspaceUiStore } from '@/stores/workspaceUi'
import { apiBaseUrl, runtimeModeLabel } from '@/config/runtime'
import {
  sessionStatusLabel,
  type BriefEventPayload,
  type PostReviewAction,
  type RuntimeType,
  type SessionStatus,
  type SessionWorkingDirectory,
  type SessionViewMode,
  type WorkspaceSnapshot
} from '@/types/contracts'
import AgentStatusPanel from './AgentStatusPanel.vue'
import AgentPortrait from './AgentPortrait.vue'
import ChatTimeline from './ChatTimeline.vue'
import CollaborationTaskBoard from './CollaborationTaskBoard.vue'
import CollaborationGraphView from './CollaborationGraphView.vue'
import CollaborationLogPanel from './CollaborationLogPanel.vue'
import DebugRuntimeView from './DebugRuntimeView.vue'
import SessionSidebar from './SessionSidebar.vue'
import TokenUsageIndicator from './TokenUsageIndicator.vue'
import UiIcon from './UiIcon.vue'
import UserInputBox from './UserInputBox.vue'
import WorkflowRuntimeView from './WorkflowRuntimeView.vue'
import { findLatestBriefPayload } from './briefEventPayload'
import { resolveSessionWorkspacePostReviewAction } from './session-workspace-post-review-action'

const sessionStore = useSessionStore()
const eventStore = useEventStore()
const agentStore = useAgentStore()
const localWorkspaceStore = useLocalWorkspaceStore()
const runtimeModelStore = useRuntimeModelStore()
const workspaceUiStore = useWorkspaceUiStore()
const route = useRoute()
const router = useRouter()

const { deletingSessionIds } = storeToRefs(sessionStore)
const {
  isSendingMessage,
  showAgentPopover,
  showCreateSessionDialog,
  showCreateConfirmDialog,
  isCreatingSession,
  newSessionInput,
  selectedSessionAgentIds,
  sessionCreateError,
  pendingCreateInput,
  uiMessage,
  sessionScanStatus,
  sessionScanSummary,
  sessionRuntimeType,
  sessionModelId,
  sessionWorkspaceKind,
  sessionServerWorkspacePath,
  showBriefRevisionDialog,
  briefRevisionInput,
  briefRevisionError,
  isSubmittingBriefRevision,
  showWorkflowStepRevisionDialog,
  workflowStepRevisionInput,
  workflowStepRevisionError,
  isSubmittingWorkflowStepRevision,
  showFileReviewDialog,
  reviewChanges,
  selectedChangePaths,
  isReviewLoading,
  isApplyingReview
} = storeToRefs(workspaceUiStore)
const selectedWorkspaceProviderKind = computed(() =>
  sessionWorkspaceKind.value === 'server_local' ? 'server_local' : 'browser_broker'
)
const hasSelectedWorkingDirectory = computed(() =>
  sessionWorkspaceKind.value === 'server_local'
    ? Boolean(sessionServerWorkspacePath.value.trim())
    : Boolean(localWorkspaceStore.pendingDirectory)
)
const selectedWorkingDirectoryLabel = computed(() =>
  sessionWorkspaceKind.value === 'server_local'
    ? sessionServerWorkspacePath.value.trim()
    : localWorkspaceStore.pendingDirectory?.name ?? ''
)
const workspaceDirectoryRequiredMessage = computed(() =>
  sessionWorkspaceKind.value === 'server_local'
    ? '请输入服务器本地工作目录'
    : '请先选择本地工作目录'
)

const sessionRuntimeOptions: { value: RuntimeType | ''; label: string }[] = [
  { value: '', label: '跟随系统默认' },
  { value: 'generic_llm', label: '通用大模型（讨论/分析）' },
  { value: 'codex', label: 'Codex（读写真实代码）' },
  { value: 'claude_code', label: 'Claude Code（读写真实代码）' }
]
const sessionFallbackRuntimeTypes = ref<RuntimeType[]>([])
const sessionFallbackRuntimeOptions = computed(() =>
  sessionRuntimeOptions.filter(
    (option): option is { value: RuntimeType; label: string } =>
      Boolean(option.value && option.value !== sessionRuntimeType.value)
  )
)
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

const viewModes: SessionViewMode[] = ['chat', 'workflow', 'collaboration_graph', 'debug']

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

function routeSessionId() {
  return typeof route.params.sessionId === 'string' ? route.params.sessionId : undefined
}

function routeViewMode() {
  return typeof route.query.view === 'string' && isViewMode(route.query.view) ? route.query.view : undefined
}

async function switchWorkspaceView(mode: SessionViewMode) {
  sessionStore.switchViewMode(mode)
  await router.replace({
    query: {
      ...route.query,
      ...(mode === 'chat' ? { view: undefined } : { view: mode })
    }
  })
}

onMounted(async () => {
  const view = routeViewMode()
  if (view) {
    sessionStore.switchViewMode(view)
  }

  try {
    await sessionStore.loadRuntimeHealth(true)
    if (!sessionStore.backendCompatible) {
      showMessage(sessionStore.runtimeHealthError ?? '后端版本不兼容，已禁止加载会话。', 'error')
      return
    }
    await Promise.all([
      agentStore.loadAgents(),
      agentStore.loadCapabilities(),
      sessionStore.loadSessions(),
      runtimeModelStore.loadAvailability()
    ])
    await sessionStore.loadSession(routeSessionId())
  } catch (error) {
    showErrorMessage(error, '后端健康检查失败，已禁止加载会话。')
    return
  }
  if (sessionStore.currentSession) {
    await eventStore.loadEvents(sessionStore.currentSession.id)
    eventStore.connectSse(sessionStore.currentSession.id)
    if (!routeSessionId()) {
      await router.replace({
        name: 'workspace-session',
        params: { sessionId: sessionStore.currentSession.id },
        query: route.query
      })
    }
  }
})

watch(
  () => route.params.sessionId,
  async (value) => {
    const sessionId = typeof value === 'string' ? value : undefined
    if (!sessionId || sessionStore.currentSession?.id === sessionId) return
    await selectSession(sessionId, false)
  }
)

watch(
  () => route.query.view,
  (value) => {
    const mode = typeof value === 'string' && isViewMode(value) ? value : 'chat'
    if (sessionStore.currentViewMode !== mode) sessionStore.switchViewMode(mode)
  }
)

onBeforeUnmount(() => {
  eventStore.disconnectSse()
})

function showMessage(text: string, type: 'success' | 'warning' | 'error' | 'info' = 'info') {
  workspaceUiStore.showMessage(text, type)
}

function showErrorMessage(error: unknown, fallback: string) {
  showMessage(error instanceof Error ? error.message : fallback, 'error')
}

const currentSessionId = computed(() => sessionStore.currentSession?.id ?? '')
const backendDisconnected = computed(
  () => Boolean(currentSessionId.value) && eventStore.sseConnectionState === 'disconnected'
)
const reconnectingBackend = ref(false)
const events = computed(() => eventStore.eventsForSession(currentSessionId.value))
const messages = computed(() => eventStore.chatMessages(currentSessionId.value))
const agents = computed(() =>
  eventStore.agentCards(currentSessionId.value, sessionStore.currentSession?.participatingAgentIds)
)
const tasks = computed(() => eventStore.taskStates(currentSessionId.value))
const activeConfirmation = computed(() => eventStore.activeConfirmation(currentSessionId.value))
const currentMode = computed(() => sessionStore.currentViewMode)
const workspaceLabel = computed(() => sessionStore.currentSession?.title ?? '无活动会话')
const activeAgentIds = computed(() => agentStore.agents.filter((agent) => agent.status === 'active').map((agent) => agent.id))
const participatingAgents = computed(() => {
  const session = sessionStore.currentSession
  if (!session) return []
  return agentStore.agents.filter((agent) => session.participatingAgentIds.includes(agent.id))
})
const runtimeDisplay = computed(() => (runtimeModeLabel === 'mock' ? 'mock' : 'real'))
const currentWorkingDirectory = computed(
  () =>
    localWorkspaceStore.directoryForSession(currentSessionId.value) ??
    sessionStore.currentSession?.workingDirectory ??
    localWorkspaceStore.pendingDirectory
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
  return findLatestBriefPayload(eventStore.eventsForSession(currentSessionId.value), briefId)
})

const latestBriefPayload = computed(() => findLatestBriefPayload(eventStore.eventsForSession(currentSessionId.value)))

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

async function selectSession(sessionId: string, navigate = true) {
  try {
    await sessionStore.loadSession(sessionId)
    await eventStore.loadEvents(sessionId)
    eventStore.connectSse(sessionId)
    if (navigate) {
      await router.push({
        name: 'workspace-session',
        params: { sessionId },
        query: route.query
      })
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Session not found')) {
      sessionStore.removeSessionFromState(sessionId)
      showMessage('会话已不存在，已从列表移除', 'warning')
      return
    }
    showErrorMessage(error, '加载会话失败')
  }
}

async function deleteSession(sessionId: string) {
  if (deletingSessionIds.value.includes(sessionId)) return
  const deletingCurrent = sessionStore.currentSession?.id === sessionId
  try {
    const deleted = await sessionStore.deleteSession(sessionId)
    if (!deleted) return
    if (deletingCurrent) {
      eventStore.disconnectSse()
    }
    localWorkspaceStore.releaseSessionWorkspace(sessionId)
    if (deletingCurrent) {
      const nextSessionId = sessionStore.sessions[0]?.id
      if (nextSessionId) {
        await selectSession(nextSessionId)
      } else {
        await router.replace({ name: 'workspace' })
      }
    }
    showMessage('会话已删除', 'success')
  } catch (error) {
    showErrorMessage(error, '删除会话失败')
  }
}

async function reconnectBackend() {
  if (!currentSessionId.value || reconnectingBackend.value) return
  reconnectingBackend.value = true
  try {
    await sessionStore.loadRuntimeHealth(true)
    if (!sessionStore.backendCompatible) {
      throw new Error(sessionStore.runtimeHealthError ?? '后端版本不兼容。')
    }
    await sessionStore.loadSession(currentSessionId.value)
    await eventStore.loadEvents(currentSessionId.value, { append: true })
    eventStore.connectSse(currentSessionId.value)
    showMessage('后端已恢复连接，正在同步会话状态。', 'success')
  } catch (error) {
    showErrorMessage(error, '后端仍不可用，请检查 8099 服务。')
  } finally {
    reconnectingBackend.value = false
  }
}

async function createSession(
  input: string,
  agentIds: string[],
  preferredRuntimeType?: RuntimeType,
  preferredModelId?: string,
  workingDirectoryOverride?: SessionWorkingDirectory,
  fallbackRuntimeTypes: RuntimeType[] = []
) {
  const workingDirectory = workingDirectoryOverride ?? localWorkspaceStore.pendingDirectory
  let workspaceSnapshot: WorkspaceSnapshot | undefined
  if (workingDirectory?.kind === 'browser_local') {
    sessionScanStatus.value = 'scanning'
    sessionScanSummary.value = undefined
    workspaceSnapshot = await localWorkspaceStore.scanPendingWorkspace()
    sessionScanSummary.value = workspaceSnapshot
    sessionScanStatus.value = 'completed'
  }
  const effectivePreferredRuntime = preferredRuntimeType || (preferredModelId ? 'generic_llm' : undefined)
  const allowedRuntimeTypes = effectivePreferredRuntime
    ? Array.from(new Set([effectivePreferredRuntime, ...fallbackRuntimeTypes]))
    : []
  const runtimePreference = effectivePreferredRuntime
    ? {
        preferredRuntimeType: effectivePreferredRuntime,
        allowedRuntimeTypes,
        ...(preferredModelId ? { preferredModelId } : {})
      }
    : undefined
  const session = await sessionStore.createSession({
    input,
    agentIds,
    workingDirectory,
    workspaceSnapshot,
    ...(runtimePreference ? { runtimePreference } : {})
  })
  if (workingDirectory?.kind === 'browser_local') {
    localWorkspaceStore.bindPendingDirectoryToSession(session.id)
  } else if (workingDirectory?.kind === 'server_local') {
    sessionScanSummary.value = session.workspaceSnapshot
    sessionScanStatus.value = 'completed'
  }
  await eventStore.loadEvents(session.id)
  await eventStore.replayLocalFileChanges(session.id)
  eventStore.connectSse(session.id)
  await router.replace({
    name: 'workspace-session',
    params: { sessionId: session.id },
    query: route.query
  })
}

function openCreateSessionDialog() {
  workspaceUiStore.openCreateSession()
  localWorkspaceStore.clearPendingDirectory()
  if (sessionStore.currentSession?.workingDirectory?.kind === 'browser_local') {
    localWorkspaceStore.reusePendingDirectoryFromSession(sessionStore.currentSession.id)
  }
  if (!runtimeModelStore.config) {
    void runtimeModelStore.loadConfig().catch(() => undefined)
  }
  void runtimeModelStore.loadAvailability().catch(() => undefined)
}

function closeCreateSessionDialog() {
  workspaceUiStore.closeCreateSession()
  localWorkspaceStore.clearPendingDirectory()
}

function handleRuntimePreferenceChange() {
  sessionCreateError.value = ''
  if (sessionRuntimeType.value === 'codex' || sessionRuntimeType.value === 'claude_code') {
    sessionModelId.value = ''
  }
  const recommendedFallbacks: Partial<Record<RuntimeType, RuntimeType[]>> = {
    claude_code: ['codex', 'generic_llm'],
    codex: ['claude_code', 'generic_llm'],
    generic_llm: ['codex', 'claude_code']
  }
  sessionFallbackRuntimeTypes.value = (recommendedFallbacks[sessionRuntimeType.value as RuntimeType] ?? [])
    .filter((runtimeType) => {
      const status = runtimeModelStore.availabilityFor(runtimeType)
      return Boolean(status?.available && status.supportedWorkspaceProviderKinds.includes(selectedWorkspaceProviderKind.value))
    })
}

function selectSessionWorkspaceKind(kind: 'browser_local' | 'server_local') {
  workspaceUiStore.setSessionWorkspaceKind(kind)
}

function serverWorkingDirectory(): SessionWorkingDirectory | undefined {
  const path = sessionServerWorkspacePath.value.trim()
  if (!path) return undefined
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
  return {
    kind: 'server_local',
    id: crypto.randomUUID(),
    name,
    path,
    selectedAt: new Date().toISOString()
  }
}

function selectedWorkingDirectory() {
  return sessionWorkspaceKind.value === 'server_local'
    ? serverWorkingDirectory()
    : localWorkspaceStore.pendingDirectory
}

async function chooseWorkingDirectory() {
  sessionCreateError.value = ''
  try {
    await localWorkspaceStore.choosePendingDirectory()
    sessionScanStatus.value = 'idle'
    sessionScanSummary.value = undefined
  } catch (error) {
    sessionCreateError.value = error instanceof Error ? error.message : '选择工作目录失败'
    showErrorMessage(error, '选择工作目录失败')
  }
}

function toggleSessionAgent(agentId: string) {
  workspaceUiStore.toggleSessionAgent(agentId)
}

async function createSessionFromDialog() {
  const input = newSessionInput.value.trim()
  if (!agentStore.agents.length) {
    sessionCreateError.value = '请先添加 Agent'
    showMessage(sessionCreateError.value, 'warning')
    return
  }
  if (!input) {
    sessionCreateError.value = '请填写会话任务'
    showMessage(sessionCreateError.value, 'warning')
    return
  }
  if (!selectedSessionAgentIds.value.length) {
    sessionCreateError.value = '请选择至少一个 Agent'
    showMessage(sessionCreateError.value, 'warning')
    return
  }
  if (sessionRuntimeType.value && !runtimeModelStore.isRuntimeAvailable(sessionRuntimeType.value)) {
    const status = runtimeModelStore.availabilityFor(sessionRuntimeType.value)
    sessionCreateError.value = status?.reason || `${sessionRuntimeType.value} Runtime 当前不可用`
    showMessage(sessionCreateError.value, 'warning')
    return
  }
  const runtimeStatus = sessionRuntimeType.value
    ? runtimeModelStore.availabilityFor(sessionRuntimeType.value)
    : undefined
  if (
    runtimeStatus &&
    !runtimeStatus.supportedWorkspaceProviderKinds.includes(selectedWorkspaceProviderKind.value)
  ) {
    sessionCreateError.value = `${sessionRuntimeType.value} Runtime 不支持当前工作区模式`
    showMessage(sessionCreateError.value, 'warning')
    return
  }
  if (!selectedWorkingDirectory()) {
    sessionCreateError.value = workspaceDirectoryRequiredMessage.value
    showMessage(sessionCreateError.value, 'warning')
    return
  }
  sessionCreateError.value = ''
  pendingCreateInput.value = input
  showCreateConfirmDialog.value = true
}

async function confirmCreateSessionFromDialog() {
  const input = pendingCreateInput.value || newSessionInput.value.trim()
  if (!input) {
    showCreateConfirmDialog.value = false
    showMessage('请填写会话任务', 'warning')
    return
  }
  isCreatingSession.value = true
  sessionCreateError.value = ''
  try {
    await createSession(
      input,
      selectedSessionAgentIds.value,
      sessionRuntimeType.value || undefined,
      sessionModelId.value || undefined,
      selectedWorkingDirectory(),
      sessionFallbackRuntimeTypes.value
    )
    workspaceUiStore.closeCreateSession()
    showMessage('会话已保存并创建', 'success')
  } catch (error) {
    sessionScanStatus.value = 'failed'
    sessionCreateError.value = error instanceof Error ? error.message : '创建会话失败'
    showErrorMessage(error, '创建会话失败')
  } finally {
    isCreatingSession.value = false
  }
}

function resolveMentionedAgentIds(content: string): string[] {
  const ids = new Set<string>()
  for (const agent of participatingAgents.value) {
    if (content.includes(`@${agent.key}`) || content.includes(`@${agent.name}`)) {
      ids.add(agent.id)
    }
  }
  return [...ids]
}

async function sendUserMessage(content: string) {
  isSendingMessage.value = true
  try {
    if (!sessionStore.currentSession) {
      if (!activeAgentIds.value.length) {
        showMessage('请先添加 Agent', 'warning')
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
    const mentionedAgentIds = resolveMentionedAgentIds(content)
    const result = await sessionStore.sendMessage(sessionId, content, mentionedAgentIds)
    eventStore.appendEvent(result.event)
    await eventStore.loadEvents(sessionId, { append: true })
  } catch (error) {
    showErrorMessage(error, '发送失败')
  } finally {
    isSendingMessage.value = false
  }
}

async function resolveConfirmation(optionKey: string) {
  if (!sessionStore.currentSession || !activeConfirmation.value) return
  const sessionId = sessionStore.currentSession.id
  if (activeConfirmation.value.reason === 'initialize_empty_workspace') {
    if (optionKey === 'reselect_workspace') {
      await sessionStore.resolveEmptyWorkspaceDecision(sessionId, {
        confirmationId: activeConfirmation.value.confirmationId,
        decision: 'reselect_workspace'
      })
      localWorkspaceStore.reusePendingDirectoryFromSession(sessionId)
      await eventStore.loadEvents(sessionId)
      return
    }
    if (optionKey === 'initialize_project' || optionKey === 'cancel') {
      await sessionStore.resolveEmptyWorkspaceDecision(sessionId, {
        confirmationId: activeConfirmation.value.confirmationId,
        decision: optionKey
      })
      await eventStore.loadEvents(sessionId)
      return
    }
  }
  if (activeConfirmation.value.reason === 'select_workflow') {
    if (optionKey === 'manage_workflows') {
      await router.push({ name: 'workflows' })
      return
    }
    if (optionKey.startsWith('workflow:')) {
      const [, workflowId, versionText] = optionKey.split(':')
      const confirmationId = activeConfirmation.value.confirmationId
      const optimisticEventId = appendOptimisticConfirmationResolution(sessionId, confirmationId, optionKey)
      try {
        await sessionStore.selectWorkflow(sessionId, {
          confirmationId,
          workflowId,
          workflowVersion: Number(versionText)
        })
      } catch (error) {
        eventStore.removeEvent(sessionId, optimisticEventId)
        await eventStore.loadEvents(sessionId).catch(() => undefined)
        showErrorMessage(error, '工作流选择失败')
        return
      }
      await eventStore.loadEvents(sessionId).catch(() => undefined)
      return
    }
  }

  if (
    activeConfirmation.value.reason === 'confirm_workflow_human_gate' &&
    activeConfirmation.value.workflowRunId &&
    activeConfirmation.value.workflowNodeRunId
  ) {
    if (optionKey === 'revise') {
      workspaceUiStore.openWorkflowStepRevision()
      return
    }
    if (optionKey === 'approve' || optionKey === 'cancel') {
      await sessionStore.resolveWorkflowHumanDecision(
        sessionId,
        activeConfirmation.value.workflowRunId,
        activeConfirmation.value.workflowNodeRunId,
        {
          confirmationId: activeConfirmation.value.confirmationId,
          expectedRunRevision: activeConfirmation.value.expectedRunRevision,
          decision: optionKey
        }
      )
      await eventStore.loadEvents(sessionId)
      return
    }
  }

  if (activeConfirmation.value.reason === 'confirm_workflow_step' && activeConfirmation.value.relatedTaskId) {
    if (optionKey === 'approve') {
      await sessionStore.resolveWorkflowStep(sessionId, activeConfirmation.value.relatedTaskId, {
        confirmationId: activeConfirmation.value.confirmationId,
        decision: 'approve'
      })
      await eventStore.loadEvents(sessionId)
      return
    }
    if (optionKey === 'revise') {
      workspaceUiStore.openWorkflowStepRevision()
      return
    }
  }
  if (activeConfirmation.value.actions?.length) {
    const resolveAction = async (action: PostReviewAction) => {
      await sessionStore.resolvePostReviewAction(sessionId, {
        confirmationId: activeConfirmation.value!.confirmationId,
        action: action.action
      })
    }
    const handled = await resolveSessionWorkspacePostReviewAction(
      optionKey,
      activeConfirmation.value.actions,
      {
        requestWorkspaceContext: resolveAction,
        deliverWithLimitations: resolveAction,
        saveProgress: resolveAction,
        cancel: resolveAction
      }
    )
    if (handled) {
      await eventStore.loadEvents(sessionId)
      return
    }
  }
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

  if (activeConfirmation.value.reason === 'confirm_local_report_save') {
    if (
      (optionKey === 'save_local' || optionKey === 'keep_in_session') &&
      activeConfirmation.value.relatedArtifactId
    ) {
      await sessionStore.decideLocalReportSave(sessionId, {
        confirmationId: activeConfirmation.value.confirmationId,
        artifactId: activeConfirmation.value.relatedArtifactId,
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

function appendOptimisticConfirmationResolution(sessionId: string, confirmationId: string, optionKey: string) {
  const eventId = `evt-local-confirmation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  eventStore.appendEvent({
    id: eventId,
    sessionId,
    type: 'user_confirmation_resolved',
    toAgentIds: [],
    content: `用户选择了 ${optionKey}`,
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'system_notice',
      payload: {
        confirmationId,
        status: 'approved',
        selectedOptionKey: optionKey
      }
    },
    createdAt: new Date().toISOString()
  })
  return eventId
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
  workspaceUiStore.openBriefRevision(formatBriefForRevision(activeBriefPayload.value))
  selectedRevisionAgentKeys.value = []
}

const selectedRevisionAgentKeys = ref<string[]>([])

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
      reason: '用户修改任务契约',
      assignedAgentKeys: selectedRevisionAgentKeys.value.length > 0 ? selectedRevisionAgentKeys.value : undefined
    })
    workspaceUiStore.closeBriefRevision()
    await eventStore.loadEvents(sessionId)
  } catch (error) {
    briefRevisionError.value = error instanceof Error ? error.message : '提交修改失败'
  } finally {
    isSubmittingBriefRevision.value = false
  }
}

async function submitWorkflowStepRevision() {
  if (!sessionStore.currentSession || !activeConfirmation.value) return
  const instruction = workflowStepRevisionInput.value.trim()
  if (!instruction) {
    workflowStepRevisionError.value = '请填写本环节的修改要求'
    return
  }
  isSubmittingWorkflowStepRevision.value = true
  workflowStepRevisionError.value = ''
  try {
    const sessionId = sessionStore.currentSession.id
    if (
      activeConfirmation.value.reason === 'confirm_workflow_human_gate' &&
      activeConfirmation.value.workflowRunId &&
      activeConfirmation.value.workflowNodeRunId
    ) {
      await sessionStore.resolveWorkflowHumanDecision(
        sessionId,
        activeConfirmation.value.workflowRunId,
        activeConfirmation.value.workflowNodeRunId,
        {
          confirmationId: activeConfirmation.value.confirmationId,
          expectedRunRevision: activeConfirmation.value.expectedRunRevision,
          decision: 'revise',
          instruction
        }
      )
    } else if (activeConfirmation.value.relatedTaskId) {
      await sessionStore.resolveWorkflowStep(sessionId, activeConfirmation.value.relatedTaskId, {
        confirmationId: activeConfirmation.value.confirmationId,
        decision: 'revise',
        instruction
      })
    }
    workspaceUiStore.closeWorkflowStepRevision()
    await eventStore.loadEvents(sessionId)
  } catch (error) {
    workflowStepRevisionError.value = error instanceof Error ? error.message : '提交修改要求失败'
  } finally {
    isSubmittingWorkflowStepRevision.value = false
  }
}

async function applyPendingFileChanges() {
  if (!sessionStore.currentSession) return
  isReviewLoading.value = true
  try {
    const changes = await localWorkspaceStore.reviewPendingFileChanges(sessionStore.currentSession.id)
    workspaceUiStore.openFileReview(changes)
  } finally {
    isReviewLoading.value = false
  }
}

function toggleReviewPath(path: string) {
  workspaceUiStore.toggleReviewPath(path)
}

function selectAllReviewPaths() {
  workspaceUiStore.selectAllReviewPaths()
}

function clearReviewSelection() {
  workspaceUiStore.clearReviewSelection()
}

async function confirmFileReview() {
  if (!sessionStore.currentSession || !selectedChangePaths.value.length) return
  const sessionId = sessionStore.currentSession.id
  const workspaceId = sessionStore.currentSession.workingDirectory?.id
  isApplyingReview.value = true
  try {
    const result = await localWorkspaceStore.applySelectedFileChanges(sessionId, selectedChangePaths.value)
    if (result?.applied && workspaceId) {
      const workspaceSnapshot = await localWorkspaceStore.scanSessionWorkspace(sessionId)
      if (workspaceSnapshot) {
        await sessionStore.refreshWorkspaceSnapshot(sessionId, workspaceId, workspaceSnapshot)
      }
    }
    if (result?.errors.length) throw new Error(result.errors.join('\n'))
    workspaceUiStore.closeFileReview()
    showMessage(`宸插啓鍏?${result?.applied ?? 0} 椤瑰彉鏇达紝宸ヤ綔鍖哄揩鐓у凡鍒锋柊`, 'success')
  } catch (error) {
    showErrorMessage(error, '鏂囦欢鍐欏洖澶辫触')
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
  <div :class="['workspace-shell', `mode-${currentMode}`]">
    <teleport to="body">
      <transition name="el-message-fade">
        <div v-if="uiMessage" :key="uiMessage.id" :class="['el-style-message', uiMessage.type]">
          <UiIcon name="message" :size="17" />
          <span>{{ uiMessage.text }}</span>
        </div>
      </transition>
    </teleport>

    <SessionSidebar
      :sessions="sessionStore.sessions"
      :current-session-id="sessionStore.currentSession?.id"
      :favorite-session-ids="sessionStore.favoriteSessionIds"
      :deleting-session-ids="deletingSessionIds"
      @select="selectSession"
      @create="openCreateSessionDialog"
      @delete="deleteSession"
      @toggle-favorite="sessionStore.toggleFavoriteSession"
    />

    <section class="workspace-main">
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
          <span v-if="!currentWorkingDirectory" class="runtime-chip">{{ runtimeDisplay }} · {{ apiBaseUrl }}</span>
          <button
            v-for="mode in viewModes"
            :key="mode"
            type="button"
            :class="['mode-button', { active: currentMode === mode }]"
            @click="switchWorkspaceView(mode)"
          >
            <UiIcon :name="viewModeIcon(mode)" :size="16" />
            {{ viewModeLabel(mode) }}
          </button>
        </div>
      </header>

      <div :class="['workspace-content', { 'has-backend-alert': backendDisconnected }]">
        <div v-if="backendDisconnected" class="backend-offline-alert" role="alert" aria-live="assertive">
          <div>
            <strong>后端连接已中断</strong>
            <span>当前画面是最后一次同步结果，Agent 实际执行状态未知。请恢复 8099 服务后重新连接。</span>
          </div>
          <button type="button" :disabled="reconnectingBackend" @click="reconnectBackend">
            {{ reconnectingBackend ? '正在重连…' : '重新连接' }}
          </button>
        </div>
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
          <UserInputBox
            :busy="isSendingMessage"
            :disabled="backendDisconnected"
            :placeholder="backendDisconnected ? '后端离线，恢复连接后可继续发送' : undefined"
            @send="sendUserMessage"
          />
        </div>
        <CollaborationGraphView
          v-else-if="currentMode === 'collaboration_graph'"
          :events="events"
          :agents="agents"
          :current-mode="currentMode"
          @switch-view="switchWorkspaceView"
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
          @switch-view="switchWorkspaceView"
        />
        <DebugRuntimeView
          v-else
          :session-id="currentSessionId"
          :events="events"
        />
      </div>
    </section>

    <CollaborationLogPanel
      v-if="currentMode === 'collaboration_graph' || currentMode === 'workflow' || currentMode === 'debug'"
      :events="events"
      :agents="agents"
      :title="currentMode === 'workflow' ? '对话 / 任务日志（实时）' : currentMode === 'debug' ? '审计事件流' : '对话 / 消息日志'"
    />
    <AgentStatusPanel
      v-else
      :agents="agents"
      :available-agents="agentStore.agents"
      :capabilities="agentStore.capabilities"
      :tasks="tasks"
      :active-confirmation="activeConfirmation"
      :connected="eventStore.sseConnected"
      @resolve-confirmation="resolveConfirmation"
    />

    <section v-if="showFileReviewDialog" class="modal-backdrop" aria-label="文件写回审阅">
      <div class="modal-panel session-create-dialog">
        <header>
          <div>
            <h2>审阅文件写回</h2>
            <p>逐项查看 diff，勾选要写入本地工作区的文件。冲突项默认不勾选。</p>
          </div>
          <button type="button" class="modal-close-button" @click="workspaceUiStore.closeFileReview">
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
                :disabled="item.conflict"
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
          <button type="button" @click="workspaceUiStore.closeFileReview">取消</button>
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
          <button type="button" class="modal-close-button" @click="closeCreateSessionDialog">
            <UiIcon name="x" :size="18" />
          </button>
        </header>
        <label class="dialog-field">
          <span>任务</span>
          <textarea v-model="newSessionInput" rows="4" placeholder="描述要让 Agent 协作完成的目标" />
        </label>
        <div class="workspace-mode-switch" aria-label="工作区模式">
          <button
            type="button"
            :class="{ selected: sessionWorkspaceKind === 'browser_local' }"
            @click="selectSessionWorkspaceKind('browser_local')"
          >
            浏览器目录
          </button>
          <button
            type="button"
            :class="{ selected: sessionWorkspaceKind === 'server_local' }"
            @click="selectSessionWorkspaceKind('server_local')"
          >
            服务器路径
          </button>
        </div>
        <div v-if="sessionWorkspaceKind === 'browser_local'" class="dialog-directory-picker">
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
        <label v-else class="dialog-field">
          <span>服务器本地工作目录</span>
          <input v-model="sessionServerWorkspacePath" type="text" placeholder="D:\\demo\\ai-langchain" />
          <small>路径由后端扫描并直接提供给 Codex/Claude Code。</small>
        </label>
        <label class="dialog-field">
          <span>Runtime 偏好</span>
          <select v-model="sessionRuntimeType" @change="handleRuntimePreferenceChange">
            <option
              v-for="option in sessionRuntimeOptions"
              :key="option.value"
              :value="option.value"
              :disabled="Boolean(option.value && !runtimeModelStore.isRuntimeAvailable(option.value))"
            >
              {{ option.label }}{{ option.value && !runtimeModelStore.isRuntimeAvailable(option.value) ? '（不可用）' : '' }}
            </option>
          </select>
          <small v-if="sessionRuntimeType === 'codex' || sessionRuntimeType === 'claude_code'">
            浏览器目录通过隔离镜像执行，文件变更确认后写回；服务器路径直接作为 Runtime 工作目录。
          </small>
        </label>
        <fieldset v-if="sessionRuntimeType" class="dialog-field runtime-fallback-field">
          <legend>备用 Runtime</legend>
          <label v-for="option in sessionFallbackRuntimeOptions" :key="option.value" class="runtime-fallback-option">
            <input
              v-model="sessionFallbackRuntimeTypes"
              type="checkbox"
              :value="option.value"
              :disabled="!runtimeModelStore.isRuntimeAvailable(option.value)"
            />
            <span>{{ option.label }}</span>
          </label>
          <small>Provider 临时超时会重试一次，再按勾选顺序切换；不会使用未授权的 Runtime。</small>
        </fieldset>
        <label v-if="sessionRuntimeType === 'generic_llm' || sessionRuntimeType === ''" class="dialog-field">
          <span>模型偏好</span>
          <select v-model="sessionModelId">
            <option value="">跟随调用时可用的默认模型</option>
            <option v-for="model in runtimeModelStore.availableModels" :key="model.id" :value="model.id">
              {{ model.label }}
            </option>
          </select>
          <small>模型仅作为路由偏好，不绕过 Runtime 可用性、Tool Authority 或 Workspace 检查。</small>
        </label>
        <section
          v-if="hasSelectedWorkingDirectory || sessionScanStatus !== 'idle'"
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
          <button type="button" @click="closeCreateSessionDialog">取消</button>
          <button type="submit" class="primary" :disabled="isCreatingSession">
            {{ isCreatingSession ? '保存中' : '保存' }}
          </button>
        </footer>
      </form>
    </section>

    <section v-if="showCreateConfirmDialog" class="modal-backdrop element-confirm-backdrop" aria-label="确认保存会话">
      <article class="element-confirm-box">
        <header>
          <span class="element-confirm-icon">
            <UiIcon name="message" :size="20" />
          </span>
          <div>
            <h2>确认保存会话</h2>
            <p>将使用当前任务、Agent 和工作目录创建新会话。</p>
          </div>
        </header>
        <dl>
          <div>
            <dt>任务</dt>
            <dd>{{ pendingCreateInput }}</dd>
          </div>
          <div>
            <dt>Agent 数量</dt>
            <dd>{{ selectedSessionAgentIds.length }} 个</dd>
          </div>
          <div>
            <dt>工作目录</dt>
            <dd>{{ selectedWorkingDirectoryLabel || '未选择' }}</dd>
          </div>
          <div v-if="sessionRuntimeType">
            <dt>Runtime 偏好</dt>
            <dd>{{ sessionRuntimeOptions.find(opt => opt.value === sessionRuntimeType)?.label ?? sessionRuntimeType }}</dd>
          </div>
          <div v-if="sessionModelId">
            <dt>模型偏好</dt>
            <dd>{{ runtimeModelStore.config?.availableModels?.find(m => m.id === sessionModelId)?.label ?? sessionModelId }}</dd>
          </div>
          <div v-if="sessionFallbackRuntimeTypes.length">
            <dt>备用 Runtime</dt>
            <dd>{{ sessionFallbackRuntimeTypes.map(type => sessionRuntimeOptions.find(opt => opt.value === type)?.label ?? type).join(' → ') }}</dd>
          </div>
        </dl>
        <footer>
          <button type="button" @click="showCreateConfirmDialog = false">取消</button>
          <button type="button" class="primary" :disabled="isCreatingSession" @click="confirmCreateSessionFromDialog">
            {{ isCreatingSession ? '保存中' : '确认保存' }}
          </button>
        </footer>
      </article>
    </section>

    <section v-if="showBriefRevisionDialog" class="modal-backdrop" aria-label="修改任务契约">
      <form class="modal-panel brief-revision-dialog" @submit.prevent="submitBriefRevision">
        <header>
          <div>
            <h2>修改任务契约</h2>
            <p>基于 Coordinator 输出的需求理解和拆分调整，提交后会重新组织 Agent 讨论。</p>
          </div>
          <button type="button" class="modal-close-button" @click="workspaceUiStore.closeBriefRevision">
            <UiIcon name="x" :size="18" />
          </button>
        </header>
        <label class="dialog-field">
          <span>修改后的需求</span>
          <textarea v-model="briefRevisionInput" rows="14" />
        </label>
        <label class="dialog-field">
          <span>指定处理 Agent（可选，默认不选则直接由 Coordinator 定稿）</span>
          <div class="agent-selector">
            <label v-for="agent in participatingAgents" :key="agent.id" class="agent-checkbox">
              <input
                type="checkbox"
                :value="agent.key"
                v-model="selectedRevisionAgentKeys"
              />
              <span>{{ agent.name }}</span>
            </label>
          </div>
        </label>
        <p v-if="briefRevisionError" class="form-error">{{ briefRevisionError }}</p>
        <footer class="form-actions">
          <button type="button" @click="workspaceUiStore.closeBriefRevision">取消</button>
          <button type="submit" class="primary" :disabled="isSubmittingBriefRevision">
            {{ isSubmittingBriefRevision ? '提交中' : '提交修改' }}
          </button>
        </footer>
      </form>
    </section>

    <section v-if="showWorkflowStepRevisionDialog" class="modal-backdrop" aria-label="修改工作流环节">
      <form class="modal-panel brief-revision-dialog" @submit.prevent="submitWorkflowStepRevision">
        <header>
          <div>
            <h2>修改当前环节</h2>
            <p>修改要求会写入群聊，并交回当前 Agent 重新处理。</p>
          </div>
          <button type="button" class="modal-close-button" @click="workspaceUiStore.closeWorkflowStepRevision">
            <UiIcon name="x" :size="18" />
          </button>
        </header>
        <label class="dialog-field">
          <span>修改要求</span>
          <textarea v-model="workflowStepRevisionInput" rows="8" />
        </label>
        <p v-if="workflowStepRevisionError" class="form-error">{{ workflowStepRevisionError }}</p>
        <footer class="form-actions">
          <button type="button" @click="workspaceUiStore.closeWorkflowStepRevision">取消</button>
          <button type="submit" class="primary" :disabled="isSubmittingWorkflowStepRevision">
            {{ isSubmittingWorkflowStepRevision ? '提交中' : '提交修改' }}
          </button>
        </footer>
      </form>
    </section>
  </div>
</template>
