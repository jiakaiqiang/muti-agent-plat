<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { useAgentStore } from '@/stores/agent'
import { useEventStore } from '@/stores/event'
import { useLocalRuntimeStore } from '@/stores/localRuntime'
import { useSessionStore } from '@/stores/session'
import { useRuntimeModelStore } from '@/stores/runtimeModel'
import { useWorkspaceUiStore } from '@/stores/workspaceUi'
import type { WorkspaceKind } from '@/stores/workspaceUi'
import { apiBaseUrl, runtimeModeLabel } from '@/config/runtime'
import { ApiRequestError, isAbortError } from '@/api/client'
import {
  sessionStatusLabel,
  type BriefEventPayload,
  type PostReviewAction,
  type RuntimeType,
  type SessionStatus,
  type SessionWorkingDirectory,
  type SessionViewMode,
  type WorkspaceWritebackRecord,
  type WorkspaceWritebackResolutionAction
} from '@/types/contracts'
import AgentStatusPanel from './AgentStatusPanel.vue'
import AgentPortrait from './AgentPortrait.vue'
import ChatTimeline from './ChatTimeline.vue'
import CollaborationTaskBoard from './CollaborationTaskBoard.vue'
import CollaborationGraphView from './CollaborationGraphView.vue'
import CollaborationLogPanel from './CollaborationLogPanel.vue'
import DebugRuntimeView from './DebugRuntimeView.vue'
import FileRevisionCandidateEditor from './FileRevisionCandidateEditor.vue'
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
const localRuntimeStore = useLocalRuntimeStore()
const runtimeModelStore = useRuntimeModelStore()
const workspaceUiStore = useWorkspaceUiStore()
const route = useRoute()
const router = useRouter()

const { deletingSessionIds } = storeToRefs(sessionStore)
const pendingDeleteSessionId = ref<string>()
const deleteSessionError = ref('')
const isSessionControlBusy = ref(false)
const backendReachability = ref<'unknown' | 'reachable' | 'unreachable'>('unknown')
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
  sessionBindingStatus,
  sessionRuntimeType,
  sessionModelId,
  sessionWorkspaceKind,
  sessionServerWorkspacePath,
  sessionLocalRuntimeWorkspaceId,
  showBriefRevisionDialog,
  briefRevisionInput,
  briefRevisionError,
  isSubmittingBriefRevision,
  showWorkflowStepRevisionDialog,
  workflowStepRevisionInput,
  workflowStepRevisionError,
  isSubmittingWorkflowStepRevision,
  showFileRevisionDialog,
  fileRevisionPath,
  selectedFileRevisionBaselineId,
  selectedFileRevisionAgentIds,
  fileRevisionInstruction,
  fileRevisionError,
  isSubmittingFileRevision
} = storeToRefs(workspaceUiStore)
const pendingDeleteSession = computed(() =>
  sessionStore.sessions.find((session) => session.id === pendingDeleteSessionId.value)
)
const isPendingSessionDeleting = computed(() =>
  Boolean(pendingDeleteSessionId.value && deletingSessionIds.value.includes(pendingDeleteSessionId.value))
)
const selectedLocalRuntimeWorkspace = computed(() =>
  localRuntimeStore.workspaceById(sessionLocalRuntimeWorkspaceId.value)
)
const selectedWorkspaceProviderKind = computed(() =>
  sessionWorkspaceKind.value === 'server_local' ? 'server_local' : 'local_bridge'
)
const hasSelectedWorkingDirectory = computed(() =>
  sessionWorkspaceKind.value === 'server_local'
    ? Boolean(sessionServerWorkspacePath.value.trim())
    : Boolean(selectedLocalRuntimeWorkspace.value)
)
const selectedWorkingDirectoryLabel = computed(() =>
  sessionWorkspaceKind.value === 'server_local'
    ? sessionServerWorkspacePath.value.trim()
    : selectedLocalRuntimeWorkspace.value?.displayName ?? ''
)
const workspaceDirectoryRequiredMessage = computed(() =>
  sessionWorkspaceKind.value === 'server_local'
    ? '请输入服务器本地工作目录'
    : '请先选择已连接的本地 Runtime 工作区'
)
const localRuntimeConnectionLabel = computed(() => {
  const capabilitySummary = localRuntimeStore.runtimeCapabilities.map((capability) => {
    const name = capability.runtimeType === 'codex' ? 'Codex' : 'Claude Code'
    const status = capability.status === 'ready'
      ? '可用'
      : capability.status === 'not_found' ? '未安装' : '探测失败'
    return `${name} ${status}`
  }).join('，')
  const labels = {
    idle: '等待检测本地助手',
    checking: '正在检测本地助手...',
    waking: '正在唤醒本地助手...',
    probing: '正在探测 Codex / Claude Code...',
    ready: capabilitySummary ? `本地助手已连接：${capabilitySummary}` : '本地助手已连接',
    failed: localRuntimeStore.connectionError || '本地助手连接失败'
  }
  return labels[localRuntimeStore.connectionState]
})

function isRuntimeAvailableForWorkspace(runtimeType: RuntimeType) {
  if (sessionWorkspaceKind.value === 'local_bridge') {
    return selectedLocalRuntimeWorkspace.value?.runtimeTypes?.includes(runtimeType) === true
  }
  return runtimeModelStore.isRuntimeAvailable(runtimeType)
}

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
  window.addEventListener('beforeunload', cancelLocalRuntimeAuthorizationOnPageExit)
  window.addEventListener('pagehide', cancelLocalRuntimeAuthorizationOnPageExit)
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
    backendReachability.value = 'reachable'
    await sessionStore.loadFileRevisions(sessionStore.currentSession.id)
    await syncSessionEventConnection(sessionStore.currentSession.id, sessionStore.currentSession.status)
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
  window.removeEventListener('beforeunload', cancelLocalRuntimeAuthorizationOnPageExit)
  window.removeEventListener('pagehide', cancelLocalRuntimeAuthorizationOnPageExit)
  eventStore.disconnectSse()
  void localRuntimeStore.cancelWorkspaceAuthorization().catch(() => undefined)
})

function cancelLocalRuntimeAuthorizationOnPageExit() {
  void localRuntimeStore.cancelWorkspaceAuthorization({ keepalive: true }).catch(() => undefined)
}

function showMessage(text: string, type: 'success' | 'warning' | 'error' | 'info' = 'info') {
  workspaceUiStore.showMessage(text, type)
}

function showErrorMessage(error: unknown, fallback: string) {
  if (isAbortError(error)) return
  showMessage(error instanceof Error ? error.message : fallback, 'error')
}

const currentSessionId = computed(() => sessionStore.currentSession?.id ?? '')
const backendDisconnected = computed(() => Boolean(currentSessionId.value) && (
  sessionStore.currentSession?.status === 'INTERRUPTED' || backendReachability.value === 'unreachable'
))
const backendConnectionNotice = computed(() => {
  if (!currentSessionId.value) return undefined
  if (sessionStore.currentSession?.status === 'INTERRUPTED') {
    return {
      tone: 'failed',
      title: '会话已中断',
      detail: '系统不会自动重新连接或续跑；手动连接与会话唤醒将在后续计划中提供。'
    }
  }
  if (eventStore.sseConnectionState === 'connecting') {
    return { tone: 'progress', title: '正在建立实时连接', detail: '正在同步会话事件。' }
  }
  if (backendReachability.value === 'unreachable') {
    return {
      tone: 'failed',
      title: '后端暂不可达',
      detail: '当前操作无法送达服务端，实时连接会继续尝试恢复。'
    }
  }
  if (eventStore.sseConnectionState === 'reconnecting') {
    return { tone: 'progress', title: '实时连接正在恢复', detail: '后端任务不会因为连接中断而停止。' }
  }
  if (eventStore.sseConnectionState === 'degraded') {
    return {
      tone: 'warning',
      title: '实时更新暂不可用',
      detail: '后端任务可能仍在运行，系统将每 30 秒继续恢复连接。'
    }
  }
  return undefined
})
const events = computed(() => eventStore.eventsForSession(currentSessionId.value))
const messages = computed(() => eventStore.chatMessages(currentSessionId.value))
const agents = computed(() =>
  eventStore.agentCards(currentSessionId.value, sessionStore.currentSession?.participatingAgentIds)
)
const tasks = computed(() => eventStore.taskStates(currentSessionId.value))
const activeConfirmation = computed(() => eventStore.activeConfirmation(currentSessionId.value))
const activeWorkItem = computed(() => sessionStore.activeWorkItem)
const pendingIntentRoutingCount = computed(() =>
  currentSessionId.value ? sessionStore.pendingIntentRoutingCount(currentSessionId.value) : 0
)
const activeWorkspaceWritebacks = computed(() =>
  (sessionStore.currentSession?.workspaceWritebacks ?? [])
    .filter((writeback) => writeback.status === 'conflicted' || writeback.status === 'failed')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
)
const workspaceWritebackBusy = ref(false)
const workspaceWritebackError = ref('')
const currentMode = computed(() => sessionStore.currentViewMode)
const workspaceLabel = computed(() => sessionStore.currentSession?.title ?? '无活动会话')
const activeAgentIds = computed(() => agentStore.agents.filter((agent) => agent.status === 'active').map((agent) => agent.id))
const participatingAgents = computed(() => {
  const session = sessionStore.currentSession
  if (!session) return []
  return agentStore.agents.filter((agent) => session.participatingAgentIds.includes(agent.id))
})
const fileRevisionAgents = computed(() =>
  participatingAgents.value.filter((agent) => agent.status === 'active' && agent.key !== 'coordinator')
)
const fileRevisionBaselines = computed(() => sessionStore.fileRevisionState.baselines)
const activeFileRevisionChain = computed(() =>
  sessionStore.fileRevisionState.chains.find((chain) => !['applied', 'abandoned'].includes(chain.status))
)
const activeFileRevisionRun = computed(() => {
  const chain = activeFileRevisionChain.value
  return chain
    ? sessionStore.fileRevisionState.runs.find((run) => run.id === chain.latestRevisionId)
    : undefined
})
const activeFileRevisionCandidate = computed(() => {
  const run = activeFileRevisionRun.value
  return run ? sessionStore.fileRevisionCandidateFor(currentSessionId.value, run.id) : undefined
})
const activeFileRevisionDraft = computed(() => {
  const run = activeFileRevisionRun.value
  return run ? sessionStore.fileRevisionDraftFor(currentSessionId.value, run.id) : undefined
})
const fileRevisionEditorBusyBySession = ref<Record<string, boolean>>({})
const fileRevisionEditorErrorBySession = ref<Record<string, string>>({})
const fileRevisionEditorBusy = computed(() => Boolean(fileRevisionEditorBusyBySession.value[currentSessionId.value]))
const fileRevisionEditorError = computed(() => fileRevisionEditorErrorBySession.value[currentSessionId.value] ?? '')

async function resolveWorkspaceWriteback(
  writeback: WorkspaceWritebackRecord,
  action: WorkspaceWritebackResolutionAction
) {
  const sessionId = currentSessionId.value
  if (!sessionId || workspaceWritebackBusy.value) return
  if (action === 'use_session' && !window.confirm('采用会话版本会覆盖当前目录中冲突文件的内容，确认继续吗？')) return
  workspaceWritebackBusy.value = true
  workspaceWritebackError.value = ''
  try {
    await sessionStore.resolveWorkspaceWriteback(sessionId, writeback.id, {
      action,
      ...(action === 'use_session' ? { confirmationId: writeback.id } : {})
    })
    showMessage(action === 'resolve_with_agent' ? '已创建冲突修复任务' : '写回处理已完成', 'success')
  } catch (error) {
    workspaceWritebackError.value = error instanceof Error ? error.message : '处理工作区写回失败'
    showErrorMessage(error, '处理工作区写回失败')
  } finally {
    workspaceWritebackBusy.value = false
  }
}

function setFileRevisionEditorBusy(sessionId: string, busy: boolean) {
  fileRevisionEditorBusyBySession.value[sessionId] = busy
}

function setFileRevisionEditorError(sessionId: string, error: string) {
  fileRevisionEditorErrorBySession.value[sessionId] = error
}
const selectedFileRevisionBaseline = computed(() =>
  fileRevisionBaselines.value.find((baseline) => baseline.id === selectedFileRevisionBaselineId.value)
)
const runtimeDisplay = computed(() => (runtimeModeLabel === 'mock' ? 'mock' : 'real'))
const currentWorkingDirectory = computed(() => sessionStore.currentSession?.workingDirectory)
const activeBriefPayload = computed(() => {
  const briefId = activeConfirmation.value?.relatedBriefId
  if (!briefId) return undefined
  return findLatestBriefPayload(eventStore.eventsForSession(currentSessionId.value), briefId)
})

const latestBriefPayload = computed(() => findLatestBriefPayload(eventStore.eventsForSession(currentSessionId.value)))
const terminalSessionStatuses = new Set<SessionStatus>(['INTERRUPTED', 'COMPLETED', 'FAILED', 'CANCELLED'])

const derivedStatus = computed(() => {
  const statusEvent = [...eventStore.eventsForSession(currentSessionId.value)]
    .reverse()
    .find((event) => (
      event.type === 'session_status_changed' ||
      (event.type === 'error_reported' && terminalSessionStatuses.has(event.metadata.payload?.status as SessionStatus))
    ))
  return (statusEvent?.metadata.payload?.status as SessionStatus | undefined) ?? sessionStore.currentSession?.status
})
const stoppableSessionStatuses = new Set<SessionStatus>([
  'AGENT_DISCUSSING',
  'REVISING_BRIEF',
  'EXECUTING',
  'POST_REVIEW',
  'REWORKING'
])
const canStopSession = computed(() => Boolean(
  currentSessionId.value && derivedStatus.value && stoppableSessionStatuses.has(derivedStatus.value)
))
const canResumeStoppedSession = computed(() => Boolean(
  currentSessionId.value && derivedStatus.value === 'PAUSED'
))

watch(
  () => [eventStore.sseConnectionState, eventStore.lastSseErrorAt] as const,
  ([state]) => {
    if (state === 'connected') {
      backendReachability.value = 'reachable'
      return
    }
    if (state === 'reconnecting' || state === 'degraded') void probeBackendReachability()
  }
)

watch(derivedStatus, (status, previousStatus) => {
  const sessionId = currentSessionId.value
  if (!sessionId || !status || status === previousStatus || !terminalSessionStatuses.has(status)) return
  sessionStore.setCurrentStatus(sessionId, status)
  void eventStore.finalizeSessionEvents(sessionId).catch(() => undefined)
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
    await sessionStore.loadFileRevisions(sessionId)
    backendReachability.value = 'reachable'
    await syncSessionEventConnection(sessionId, sessionStore.currentSession?.status)
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

async function syncActiveFileRevisionContent() {
  if (fileRevisionEditorBusy.value) return
  const sessionId = currentSessionId.value
  const run = activeFileRevisionRun.value
  if (!sessionId || !run?.candidateHash || !['awaiting_confirmation', 'stale', 'failed'].includes(run.status)) return
  try {
    await sessionStore.loadFileRevisionCandidate(sessionId, run.id)
    const draft = sessionStore.fileRevisionState.drafts.find((item) => item.sourceRevisionId === run.id)
    if (draft) await sessionStore.loadFileRevisionDraft(sessionId, run.id)
  } catch (error) {
    if (!(error instanceof ApiRequestError && error.status === 404)) {
      setFileRevisionEditorError(sessionId, error instanceof Error ? error.message : '加载候选失败')
    }
  }
}

watch(
  () => [currentSessionId.value, activeFileRevisionRun.value?.id, activeFileRevisionRun.value?.status] as const,
  () => void syncActiveFileRevisionContent(),
  { immediate: true }
)

watch(fileRevisionEditorBusy, (busy, wasBusy) => {
  if (wasBusy && !busy) void syncActiveFileRevisionContent()
})

watch(
  () => events.value.at(-1)?.id,
  () => {
    const latest = events.value.at(-1)
    if (!latest || (!latest.type.startsWith('file_revision_') && latest.type !== 'user_confirmation_requested')) return
    const sessionId = currentSessionId.value
    if (!sessionId) return
    void sessionStore.loadFileRevisions(sessionId).then(syncActiveFileRevisionContent).catch(() => undefined)
  }
)

async function syncSessionEventConnection(sessionId: string, status?: SessionStatus) {
  if (status && terminalSessionStatuses.has(status)) {
    await eventStore.finalizeSessionEvents(sessionId)
    return
  }
  await eventStore.ensureConnectedAndReconcile(sessionId)
}

async function reconcileSessionEvents(sessionId: string) {
  const status = sessionStore.currentSession?.id === sessionId ? sessionStore.currentSession.status : undefined
  await syncSessionEventConnection(sessionId, status)
}

async function stopCurrentSession() {
  const sessionId = currentSessionId.value
  if (!sessionId || !canStopSession.value || isSessionControlBusy.value) return
  isSessionControlBusy.value = true
  try {
    await sessionStore.pauseSession(sessionId)
    await reconcileSessionEvents(sessionId)
    showMessage('会话已停止，可以稍后继续', 'success')
  } catch (error) {
    showErrorMessage(error, '停止会话失败')
  } finally {
    isSessionControlBusy.value = false
  }
}

async function resumeStoppedSession() {
  const sessionId = currentSessionId.value
  if (!sessionId || !canResumeStoppedSession.value || isSessionControlBusy.value) return
  isSessionControlBusy.value = true
  try {
    await sessionStore.resumeSession(sessionId)
    await reconcileSessionEvents(sessionId)
    showMessage('会话已继续执行', 'success')
  } catch (error) {
    showErrorMessage(error, '继续会话失败')
  } finally {
    isSessionControlBusy.value = false
  }
}

async function probeBackendReachability() {
  try {
    await eventStore.probeBackendReachability()
    backendReachability.value = 'reachable'
  } catch {
    backendReachability.value = 'unreachable'
  }
}

function requestDeleteSession(sessionId: string) {
  if (deletingSessionIds.value.includes(sessionId)) return
  deleteSessionError.value = ''
  pendingDeleteSessionId.value = sessionId
}

function cancelDeleteSession() {
  if (isPendingSessionDeleting.value) return
  pendingDeleteSessionId.value = undefined
  deleteSessionError.value = ''
}

async function confirmDeleteSession() {
  const sessionId = pendingDeleteSessionId.value
  if (!sessionId || deletingSessionIds.value.includes(sessionId)) return
  const deletingCurrent = sessionStore.currentSession?.id === sessionId
  deleteSessionError.value = ''
  try {
    const deleted = await sessionStore.deleteSession(sessionId)
    if (!deleted) return
    pendingDeleteSessionId.value = undefined
    if (deletingCurrent) {
      eventStore.disconnectSse()
    }
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
    deleteSessionError.value = error instanceof Error ? error.message : '删除会话失败'
    showErrorMessage(error, '删除会话失败')
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
  const workingDirectory = workingDirectoryOverride
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
    ...(runtimePreference ? { runtimePreference } : {})
  })
  if (workingDirectory) {
    sessionBindingStatus.value = 'bound'
  }
  backendReachability.value = 'reachable'
  await syncSessionEventConnection(session.id, session.status)
  await router.replace({
    name: 'workspace-session',
    params: { sessionId: session.id },
    query: route.query
  })
}

function openCreateSessionDialog() {
  workspaceUiStore.openCreateSession()
  if (!runtimeModelStore.config) {
    void runtimeModelStore.loadConfig().catch(() => undefined)
  }
  void runtimeModelStore.loadAvailability().catch(() => undefined)
  if (sessionWorkspaceKind.value === 'local_bridge') void ensureLocalRuntimeReady()
}

function closeCreateSessionDialog() {
  localRuntimeStore.cancelConnectionCheck()
  void localRuntimeStore.cancelWorkspaceAuthorization().catch(() => undefined)
  sessionLocalRuntimeWorkspaceId.value = ''
  sessionBindingStatus.value = 'idle'
  sessionCreateError.value = ''
  workspaceUiStore.closeCreateSession()
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
      if (sessionWorkspaceKind.value === 'local_bridge') {
        return isRuntimeAvailableForWorkspace(runtimeType)
      }
      const status = runtimeModelStore.availabilityFor(runtimeType)
      return Boolean(status?.available && status.supportedWorkspaceProviderKinds.includes(selectedWorkspaceProviderKind.value))
    })
}

function reconcileLocalRuntimePreference() {
  if (sessionWorkspaceKind.value !== 'local_bridge') return
  const availableRuntimeTypes = selectedLocalRuntimeWorkspace.value?.runtimeTypes
    .filter((runtimeType): runtimeType is Extract<RuntimeType, 'codex' | 'claude_code'> => (
      runtimeType === 'codex' || runtimeType === 'claude_code'
    )) ?? []
  const selectedRuntimeType = sessionRuntimeType.value
  if (
    !selectedRuntimeType ||
    (selectedRuntimeType !== 'codex' && selectedRuntimeType !== 'claude_code') ||
    !availableRuntimeTypes.includes(selectedRuntimeType)
  ) {
    sessionRuntimeType.value = availableRuntimeTypes[0] ?? ''
  }
}

function selectSessionWorkspaceKind(kind: WorkspaceKind) {
  if (kind !== 'local_bridge') {
    void localRuntimeStore.cancelWorkspaceAuthorization().catch(() => undefined)
    sessionLocalRuntimeWorkspaceId.value = ''
    sessionBindingStatus.value = 'idle'
  }
  workspaceUiStore.setSessionWorkspaceKind(kind)
  sessionCreateError.value = ''
  sessionFallbackRuntimeTypes.value = []
  if (kind === 'local_bridge') void ensureLocalRuntimeReady()
}

async function ensureLocalRuntimeReady() {
  sessionCreateError.value = ''
  try {
    const workspaces = await localRuntimeStore.ensureConnected()
    if (!workspaces.some((workspace) => workspace.workspaceId === sessionLocalRuntimeWorkspaceId.value)) {
      sessionLocalRuntimeWorkspaceId.value = workspaces[0]?.workspaceId ?? ''
    }
    reconcileLocalRuntimePreference()
    handleRuntimePreferenceChange()
    return workspaces
  } catch (error) {
    if (isAbortError(error)) return []
    sessionCreateError.value = error instanceof Error ? error.message : '读取本地 Runtime 工作区失败'
    return []
  }
}

async function authorizeLocalRuntimeWorkspace() {
  sessionCreateError.value = ''
  try {
    if (localRuntimeStore.connectionState !== 'ready') {
      await localRuntimeStore.ensureConnected()
    }
    const workspace = await localRuntimeStore.authorizeWorkspace()
    sessionLocalRuntimeWorkspaceId.value = workspace.workspaceId
    reconcileLocalRuntimePreference()
    handleRuntimePreferenceChange()
  } catch (error) {
    if (isAbortError(error)) return
    sessionCreateError.value = error instanceof Error ? error.message : '本机工作目录授权失败'
  }
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

function localRuntimeWorkingDirectory(): SessionWorkingDirectory | undefined {
  const workspace = selectedLocalRuntimeWorkspace.value
  if (!workspace) return undefined
  return {
    kind: 'local_bridge',
    id: workspace.workspaceId,
    name: workspace.displayName,
    selectedAt: new Date().toISOString()
  }
}

function selectedWorkingDirectory() {
  if (sessionWorkspaceKind.value === 'server_local') return serverWorkingDirectory()
  return localRuntimeWorkingDirectory()
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
  if (sessionWorkspaceKind.value === 'local_bridge' && localRuntimeStore.connectionState !== 'ready') {
    await ensureLocalRuntimeReady()
    if (!localRuntimeStore.isConnected || localRuntimeStore.connectionError) return
  }
  if (sessionWorkspaceKind.value === 'local_bridge' && !sessionRuntimeType.value) {
    sessionCreateError.value = '当前设备没有可用于创建会话的 Codex 或 Claude Code'
    showMessage(sessionCreateError.value, 'warning')
    return
  }
  if (sessionRuntimeType.value && !isRuntimeAvailableForWorkspace(sessionRuntimeType.value)) {
    const status = runtimeModelStore.availabilityFor(sessionRuntimeType.value)
    sessionCreateError.value = sessionWorkspaceKind.value === 'local_bridge'
      ? `${sessionRuntimeType.value} 未在所选本地 Runtime 设备上运行`
      : status?.reason || `${sessionRuntimeType.value} Runtime 当前不可用`
    showMessage(sessionCreateError.value, 'warning')
    return
  }
  const runtimeStatus = sessionRuntimeType.value
    ? runtimeModelStore.availabilityFor(sessionRuntimeType.value)
    : undefined
  if (
    sessionWorkspaceKind.value !== 'local_bridge' &&
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
    sessionBindingStatus.value = 'failed'
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
      openCreateSessionDialog()
      newSessionInput.value = content
      selectedSessionAgentIds.value = [...activeAgentIds.value]
      return
    }

    const sessionId = sessionStore.currentSession.id
    const mentionedAgentIds = resolveMentionedAgentIds(content)
    const result = await sessionStore.sendMessage(sessionId, content, mentionedAgentIds)
    eventStore.appendEvent(result.event)
    await reconcileSessionEvents(sessionId)
  } catch (error) {
    showErrorMessage(error, '发送失败')
  } finally {
    isSendingMessage.value = false
  }
}

async function openFileRevisionDialog() {
  const session = sessionStore.currentSession
  if (!session) return
  try {
    await sessionStore.loadFileRevisions(session.id)
    selectedFileRevisionBaselineId.value = fileRevisionBaselines.value[0]?.id ?? ''
    selectedFileRevisionAgentIds.value = []
    workspaceUiStore.openFileRevision()
  } catch (error) {
    showErrorMessage(error, '加载文件修订状态失败')
  }
}

async function captureFileRevisionBaseline() {
  const session = sessionStore.currentSession
  if (!session || !fileRevisionPath.value.trim()) {
    fileRevisionError.value = '请输入工作区内的文件路径。'
    return
  }
  isSubmittingFileRevision.value = true
  fileRevisionError.value = ''
  try {
    const baseline = await sessionStore.captureFileRevisionBaseline(session.id, fileRevisionPath.value.trim())
    selectedFileRevisionBaselineId.value = baseline.id
    showMessage('已记录修改前版本', 'success')
  } catch (error) {
    fileRevisionError.value = error instanceof Error ? error.message : '记录基线失败'
  } finally {
    isSubmittingFileRevision.value = false
  }
}

async function submitFileRevision() {
  const session = sessionStore.currentSession
  if (!session || !selectedFileRevisionBaselineId.value) {
    fileRevisionError.value = '请先选择修改前版本。'
    return
  }
  if (!selectedFileRevisionAgentIds.value.length) {
    fileRevisionError.value = '请至少选择一个处理 Agent。'
    return
  }
  isSubmittingFileRevision.value = true
  fileRevisionError.value = ''
  try {
    await sessionStore.startFileRevision(
      session.id,
      selectedFileRevisionBaselineId.value,
      selectedFileRevisionAgentIds.value,
      fileRevisionInstruction.value
    )
    workspaceUiStore.closeFileRevision()
    await reconcileSessionEvents(session.id)
    showMessage('文件修订已交给 Agent 处理', 'success')
  } catch (error) {
    fileRevisionError.value = error instanceof Error ? error.message : '启动文件修订失败'
  } finally {
    isSubmittingFileRevision.value = false
  }
}

async function saveActiveFileRevisionDraft(content: string) {
  const run = activeFileRevisionRun.value
  const candidate = activeFileRevisionCandidate.value
  const sessionId = currentSessionId.value
  if (!run || !candidate || !sessionId) return undefined
  setFileRevisionEditorBusy(sessionId, true)
  setFileRevisionEditorError(sessionId, '')
  try {
    const draft = await sessionStore.saveFileRevisionDraft(
      sessionId,
      run.id,
      candidate.candidateHash,
      content
    )
    showMessage('草稿已保存', 'success')
    return draft
  } catch (error) {
    setFileRevisionEditorError(sessionId, error instanceof Error ? error.message : '保存草稿失败')
    return undefined
  } finally {
    setFileRevisionEditorBusy(sessionId, false)
  }
}

async function submitActiveFileRevision(content: string) {
  const run = activeFileRevisionRun.value
  const chain = activeFileRevisionChain.value
  const candidate = activeFileRevisionCandidate.value
  const sessionId = currentSessionId.value
  if (!run || !chain || !candidate || !sessionId) return
  setFileRevisionEditorBusy(sessionId, true)
  setFileRevisionEditorError(sessionId, '')
  try {
    const draft = await sessionStore.saveFileRevisionDraft(
      sessionId,
      run.id,
      candidate.candidateHash,
      content
    )
    await sessionStore.reprocessFileRevision(sessionId, run.id, {
      draftHash: draft.contentHash,
      expectedCandidateHash: candidate.candidateHash,
      expectedStateVersion: chain.stateVersion
    })
    await reconcileSessionEvents(sessionId)
    showMessage(`已提交第 ${run.iteration + 1} 轮处理`, 'success')
  } catch (error) {
    setFileRevisionEditorError(sessionId, error instanceof Error ? error.message : '提交修改失败')
  } finally {
    setFileRevisionEditorBusy(sessionId, false)
  }
}

async function decideActiveFileRevision(decision: 'apply_candidate' | 'abandon_revision') {
  const sessionId = currentSessionId.value
  const run = activeFileRevisionRun.value
  const chain = activeFileRevisionChain.value
  const candidate = activeFileRevisionCandidate.value
  const confirmation = activeConfirmation.value
  if (
    !sessionId ||
    !run ||
    !chain ||
    !candidate ||
    confirmation?.reason !== 'confirm_file_revision_apply' ||
    confirmation.revisionId !== run.id
  ) return
  setFileRevisionEditorBusy(sessionId, true)
  setFileRevisionEditorError(sessionId, '')
  try {
    const result = await sessionStore.decideFileRevision(sessionId, run.id, {
      confirmationId: confirmation.confirmationId,
      candidateHash: candidate.candidateHash,
      expectedStateVersion: chain.stateVersion,
      decision
    }) as { applied?: boolean }
    await reconcileSessionEvents(sessionId)
    if (decision === 'apply_candidate') {
      showMessage(result.applied ? '候选已写回文件' : '原文件已变化，候选未写回', result.applied ? 'success' : 'warning')
    } else {
      showMessage('本次修订已放弃', 'info')
    }
  } catch (error) {
    setFileRevisionEditorError(sessionId, error instanceof Error ? error.message : '处理候选失败')
  } finally {
    await sessionStore.loadFileRevisions(sessionId).catch(() => undefined)
    setFileRevisionEditorBusy(sessionId, false)
  }
}

async function resolveActiveFileRevisionFailure(
  decision: 'retry_agents' | 'continue_with_successful' | 'abandon_revision'
) {
  const sessionId = currentSessionId.value
  const run = activeFileRevisionRun.value
  const chain = activeFileRevisionChain.value
  if (!sessionId || !run || !chain || run.errorCode !== 'REVISION_PARTIAL_AGENT_FAILURE') return
  setFileRevisionEditorBusy(sessionId, true)
  setFileRevisionEditorError(sessionId, '')
  try {
    await sessionStore.resolveFileRevisionFailure(sessionId, run.id, {
      expectedStateVersion: chain.stateVersion,
      decision
    })
    await reconcileSessionEvents(sessionId)
    showMessage(
      decision === 'retry_agents'
        ? '已重新运行本轮 Agent'
        : decision === 'continue_with_successful'
          ? 'Receiver 将使用成功结果继续生成候选'
          : '本次修订已放弃',
      decision === 'abandon_revision' ? 'info' : 'success'
    )
  } catch (error) {
    setFileRevisionEditorError(sessionId, error instanceof Error ? error.message : '处理部分失败决策失败')
  } finally {
    setFileRevisionEditorBusy(sessionId, false)
  }
}

async function retryActiveInterruptedFileRevision() {
  const sessionId = currentSessionId.value
  const run = activeFileRevisionRun.value
  const chain = activeFileRevisionChain.value
  if (!sessionId || !run || !chain || run.status !== 'interrupted') return
  setFileRevisionEditorBusy(sessionId, true)
  setFileRevisionEditorError(sessionId, '')
  try {
    await sessionStore.retryInterruptedFileRevision(sessionId, run.id, {
      expectedStateVersion: chain.stateVersion,
      retryKey: crypto.randomUUID()
    })
    await reconcileSessionEvents(sessionId)
    showMessage('已重新启动本轮文件修订', 'success')
  } catch (error) {
    setFileRevisionEditorError(sessionId, error instanceof Error ? error.message : '重试文件修订失败')
  } finally {
    setFileRevisionEditorBusy(sessionId, false)
  }
}

async function resolveConfirmation(optionKey: string) {
  if (!sessionStore.currentSession || !activeConfirmation.value) return
  const sessionId = sessionStore.currentSession.id
  if (
    activeConfirmation.value.reason === 'intent_relation_clarification' &&
    activeConfirmation.value.routingId &&
    (optionKey === 'continue_current' || optionKey === 'related_new' || optionKey === 'independent_new')
  ) {
    await sessionStore.clarifyIntentRouting(sessionId, activeConfirmation.value.routingId, {
      choice: optionKey,
      confirmationId: activeConfirmation.value.confirmationId
    })
    await reconcileSessionEvents(sessionId)
    return
  }
  if (
    activeConfirmation.value.reason === 'confirm_file_revision_apply' &&
    activeConfirmation.value.revisionId &&
    (optionKey === 'apply_candidate' || optionKey === 'abandon_revision')
  ) {
    await decideActiveFileRevision(optionKey)
    return
  }
  if (activeConfirmation.value.reason === 'approve_local_runtime_permission') {
    if (optionKey === 'approve_once' || optionKey === 'cancel') {
      await sessionStore.resolveLocalRuntimePermission(sessionId, {
        confirmationId: activeConfirmation.value.confirmationId,
        decision: optionKey
      })
      await reconcileSessionEvents(sessionId)
      return
    }
  }
  if (activeConfirmation.value.reason === 'initialize_empty_workspace') {
    if (optionKey === 'reselect_workspace') {
      await sessionStore.resolveEmptyWorkspaceDecision(sessionId, {
        confirmationId: activeConfirmation.value.confirmationId,
        decision: 'reselect_workspace'
      })
      await reconcileSessionEvents(sessionId)
      openCreateSessionDialog()
      return
    }
    if (optionKey === 'initialize_project' || optionKey === 'cancel') {
      await sessionStore.resolveEmptyWorkspaceDecision(sessionId, {
        confirmationId: activeConfirmation.value.confirmationId,
        decision: optionKey
      })
      await reconcileSessionEvents(sessionId)
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
        await reconcileSessionEvents(sessionId).catch(() => undefined)
        showErrorMessage(error, '工作流选择失败')
        return
      }
      await reconcileSessionEvents(sessionId).catch(() => undefined)
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
      await reconcileSessionEvents(sessionId)
      return
    }
  }

  if (activeConfirmation.value.reason === 'confirm_workflow_step' && activeConfirmation.value.relatedTaskId) {
    if (optionKey === 'approve') {
      await sessionStore.resolveWorkflowStep(sessionId, activeConfirmation.value.relatedTaskId, {
        confirmationId: activeConfirmation.value.confirmationId,
        decision: 'approve'
      })
      await reconcileSessionEvents(sessionId)
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
      await reconcileSessionEvents(sessionId)
      return
    }
  }
  if (optionKey === 'approve' && activeConfirmation.value.relatedBriefId) {
    await sessionStore.confirmBrief(sessionId, activeConfirmation.value.relatedBriefId)
    await reconcileSessionEvents(sessionId)
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
    await reconcileSessionEvents(sessionId)
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
      await reconcileSessionEvents(sessionId)
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
      await reconcileSessionEvents(sessionId)
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
      await reconcileSessionEvents(sessionId)
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

async function approveCapability(sessionId: string, capabilityIds: string[], agentId?: string) {
  try {
    for (const capabilityId of capabilityIds) {
      await sessionStore.approveCapability(sessionId, capabilityId, { agentId })
    }
    await reconcileSessionEvents(sessionId)
    showMessage('能力已授权，任务将自动恢复执行', 'success')
  } catch (error) {
    showErrorMessage(error, '授权能力失败')
  }
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
    await reconcileSessionEvents(sessionId)
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
    await reconcileSessionEvents(sessionId)
  } catch (error) {
    workflowStepRevisionError.value = error instanceof Error ? error.message : '提交修改要求失败'
  } finally {
    isSubmittingWorkflowStepRevision.value = false
  }
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
      @delete="requestDeleteSession"
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
          <span v-if="activeWorkItem" class="work-item-chip" :title="activeWorkItem.goal">
            <UiIcon name="workflow" :size="15" />
            {{ activeWorkItem.title }}
          </span>
          <button
            v-if="currentWorkingDirectory"
            class="header-icon-button"
            type="button"
            title="文件修订"
            aria-label="文件修订"
            @click="openFileRevisionDialog"
          >
            <UiIcon name="folder" :size="17" />
          </button>
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
          <button
            v-if="canStopSession"
            class="header-icon-button session-control-button is-stop"
            type="button"
            title="停止会话"
            aria-label="停止会话"
            :disabled="isSessionControlBusy"
            @click="stopCurrentSession"
          >
            <UiIcon name="stop" :size="16" />
          </button>
          <button
            v-else-if="canResumeStoppedSession"
            class="header-icon-button session-control-button is-resume"
            type="button"
            title="继续会话"
            aria-label="继续会话"
            :disabled="isSessionControlBusy"
            @click="resumeStoppedSession"
          >
            <UiIcon name="play" :size="16" />
          </button>
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

      <div :class="['workspace-content', {
        'has-backend-alert': backendConnectionNotice,
        'has-intent-routing': pendingIntentRoutingCount > 0
      }]">
        <div
          v-if="backendConnectionNotice"
          :class="['backend-offline-alert', `is-${backendConnectionNotice.tone}`]"
          role="status"
          aria-live="polite"
        >
          <div>
            <strong>{{ backendConnectionNotice.title }}</strong>
            <span>{{ backendConnectionNotice.detail }}</span>
          </div>
        </div>
        <div
          v-if="currentMode === 'chat' && pendingIntentRoutingCount > 0"
          class="intent-routing-indicator"
          role="status"
          aria-live="polite"
        >
          <span aria-hidden="true"></span>
          正在识别消息意图
          <small v-if="pendingIntentRoutingCount > 1">{{ pendingIntentRoutingCount }} 条</small>
        </div>
        <FileRevisionCandidateEditor
          v-if="currentMode === 'chat' && activeFileRevisionRun"
          :file-path="activeFileRevisionRun.filePath"
          :iteration="activeFileRevisionRun.iteration"
          :status="activeFileRevisionRun.status"
          :candidate="activeFileRevisionCandidate"
          :draft="activeFileRevisionDraft"
          :busy="fileRevisionEditorBusy"
          :error="fileRevisionEditorError || activeFileRevisionRun.errorMessage"
          :partial-failure="activeFileRevisionRun.errorCode === 'REVISION_PARTIAL_AGENT_FAILURE'"
          :successful-agent-count="activeFileRevisionRun.agentResults.filter((result) => result.status === 'completed').length"
          @save="saveActiveFileRevisionDraft"
          @submit="submitActiveFileRevision"
          @apply="decideActiveFileRevision('apply_candidate')"
          @abandon="decideActiveFileRevision('abandon_revision')"
          @failure-decision="resolveActiveFileRevisionFailure"
          @retry-interrupted="retryActiveInterruptedFileRevision"
        />
        <section
          v-for="writeback in currentMode === 'chat' ? activeWorkspaceWritebacks : []"
          :key="writeback.id"
          class="workspace-writeback-panel"
          role="alert"
          aria-live="polite"
        >
          <header>
            <div>
              <strong>工作区写回需要处理</strong>
              <p v-if="writeback.status === 'failed'">
                {{ writeback.error ?? '写回失败，请重试或放弃本次写回。' }}
              </p>
              <p v-else>
                自动三方合并未能安全处理以下 {{ writeback.conflicts.length }} 个冲突。
              </p>
            </div>
            <span>{{ writeback.providerKind }}</span>
          </header>
          <ul v-if="writeback.conflicts.length">
            <li v-for="conflict in writeback.conflicts" :key="`${conflict.path}:${conflict.operation}`">
              <code>{{ conflict.path }}</code>
              <span>{{ conflict.message }}</span>
            </li>
          </ul>
          <p v-if="workspaceWritebackError" class="form-error">{{ workspaceWritebackError }}</p>
          <footer>
            <button type="button" :disabled="workspaceWritebackBusy" @click="resolveWorkspaceWriteback(writeback, 'retry_merge')">
              重试合并
            </button>
            <button type="button" :disabled="workspaceWritebackBusy" @click="resolveWorkspaceWriteback(writeback, 'resolve_with_agent')">
              交给 Agent
            </button>
            <button type="button" :disabled="workspaceWritebackBusy" @click="resolveWorkspaceWriteback(writeback, 'keep_workspace')">
              保留当前目录
            </button>
            <button type="button" class="danger" :disabled="workspaceWritebackBusy" @click="resolveWorkspaceWriteback(writeback, 'use_session')">
              采用会话版本
            </button>
            <button type="button" :disabled="workspaceWritebackBusy" @click="resolveWorkspaceWriteback(writeback, 'abandon_writeback')">
              放弃写回
            </button>
          </footer>
        </section>
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
            @approve-capability="approveCapability"
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
            :class="{ selected: sessionWorkspaceKind === 'local_bridge' }"
            @click="selectSessionWorkspaceKind('local_bridge')"
          >
            本地
          </button>
          <button
            type="button"
            :class="{ selected: sessionWorkspaceKind === 'server_local' }"
            @click="selectSessionWorkspaceKind('server_local')"
          >
            服务器
          </button>
        </div>
        <label v-if="sessionWorkspaceKind === 'server_local'" class="dialog-field">
          <span>服务器本地工作目录</span>
          <input v-model="sessionServerWorkspacePath" type="text" placeholder="D:\\demo\\ai-langchain" />
          <small>后端只校验并绑定该目录；元数据索引后台更新，文件内容按任务需要读取。</small>
        </label>
        <div v-else class="dialog-field">
          <span>本机工作目录</span>
          <div
            :class="['local-runtime-connection-state', `is-${localRuntimeStore.connectionState}`]"
            role="status"
            aria-live="polite"
          >
            <span>{{ localRuntimeConnectionLabel }}</span>
            <button
              v-if="localRuntimeStore.connectionState === 'failed'"
              type="button"
              :disabled="localRuntimeStore.connectionBusy"
              @click="ensureLocalRuntimeReady"
            >
              重新检测
            </button>
          </div>
          <div class="local-runtime-workspace-picker">
          <select
            v-model="sessionLocalRuntimeWorkspaceId"
            :disabled="localRuntimeStore.loading || localRuntimeStore.authorizing || localRuntimeStore.connectionBusy"
          >
            <option value="">
              {{ localRuntimeStore.loading ? '正在读取本机 Runtime...' : '请选择已连接工作区' }}
            </option>
            <option
              v-for="workspace in localRuntimeStore.workspaces"
              :key="workspace.workspaceId"
              :value="workspace.workspaceId"
            >
              {{ workspace.displayName }}（{{ (workspace.runtimeTypes ?? []).join(', ') || '无可用 Runtime' }}）
            </option>
          </select>
          <button
            type="button"
            class="local-runtime-authorize-button"
            :disabled="localRuntimeStore.loading || localRuntimeStore.authorizing || localRuntimeStore.connectionBusy"
            @click="authorizeLocalRuntimeWorkspace"
          >
            {{ localRuntimeStore.authorizing ? '等待目录选择...' : '选择本机目录' }}
          </button>
          </div>
          <small v-if="localRuntimeStore.workspaces.length">
            目录授权由本机 Runtime 完成，平台只保存工作区 ID，不接收本地绝对路径。
          </small>
          <small v-else>
            点击“选择本机目录”，本机 Runtime 将打开系统目录选择窗口。
          </small>
        </div>
        <label class="dialog-field">
          <span>Runtime 偏好</span>
          <select
            v-model="sessionRuntimeType"
            :disabled="sessionWorkspaceKind === 'local_bridge' && localRuntimeStore.connectionBusy"
            @change="handleRuntimePreferenceChange"
          >
            <option
              v-for="option in sessionRuntimeOptions"
              :key="option.value"
              :value="option.value"
              :disabled="sessionWorkspaceKind === 'local_bridge'
                ? !option.value || !isRuntimeAvailableForWorkspace(option.value)
                : Boolean(option.value && !isRuntimeAvailableForWorkspace(option.value))"
            >
              {{ option.label }}{{ option.value && !isRuntimeAvailableForWorkspace(option.value) ? '（不可用）' : '' }}
            </option>
          </select>
          <small>
            本地模式由 Local Runtime CLI 在授权目录内执行；服务器模式在服务器 Runtime 中执行，Codex/Claude Code 使用独立 Worker。
          </small>
        </label>
        <fieldset v-if="sessionRuntimeType" class="dialog-field runtime-fallback-field">
          <legend>备用 Runtime</legend>
          <label v-for="option in sessionFallbackRuntimeOptions" :key="option.value" class="runtime-fallback-option">
            <input
              v-model="sessionFallbackRuntimeTypes"
              type="checkbox"
              :value="option.value"
              :disabled="!isRuntimeAvailableForWorkspace(option.value)"
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
          v-if="hasSelectedWorkingDirectory || sessionBindingStatus !== 'idle'"
          class="workspace-binding-summary"
        >
          <header>
            <strong>工作区绑定</strong>
            <span :class="['status-pill', sessionBindingStatus]">
              {{
                sessionBindingStatus === 'binding'
                  ? '绑定中'
                  : sessionBindingStatus === 'bound'
                    ? '已绑定'
                    : sessionBindingStatus === 'failed'
                      ? '失败'
                      : '待绑定'
              }}
            </span>
          </header>
          <p v-if="sessionBindingStatus === 'idle'">
            创建会话只校验并绑定目录；元数据索引由 Runtime 在后台维护，文件内容按任务需要读取。
          </p>
          <p v-else-if="sessionBindingStatus === 'binding'">正在绑定工作区，不等待后台索引完成。</p>
          <p v-else-if="sessionWorkspaceKind === 'local_bridge'">
            本地目录由 agent-runtime CLI 读取和修改，平台后端不会接收本地绝对路径。
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

    <section
      v-if="pendingDeleteSessionId"
      class="modal-backdrop element-confirm-backdrop"
      aria-label="确认删除会话"
    >
      <article
        class="element-confirm-box session-delete-confirm-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-delete-title"
      >
        <header>
          <span class="element-confirm-icon danger">
            <UiIcon name="trash" :size="20" />
          </span>
          <div>
            <h2 id="session-delete-title">确认删除会话？</h2>
            <p>删除后无法恢复，会话消息、任务、事件和会话工作区缓存会一并清理。</p>
          </div>
        </header>
        <dl v-if="pendingDeleteSession">
          <div>
            <dt>会话</dt>
            <dd :title="pendingDeleteSession.title">{{ pendingDeleteSession.title }}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{{ sessionStatusLabel[pendingDeleteSession.status] }}</dd>
          </div>
        </dl>
        <p v-if="deleteSessionError" class="form-error" role="alert">{{ deleteSessionError }}</p>
        <footer>
          <button type="button" :disabled="isPendingSessionDeleting" @click="cancelDeleteSession">取消</button>
          <button
            type="button"
            class="danger"
            data-testid="session-confirm-delete"
            :disabled="isPendingSessionDeleting"
            @click="confirmDeleteSession"
          >
            {{ isPendingSessionDeleting ? '删除中…' : '确认删除' }}
          </button>
        </footer>
      </article>
    </section>

    <section v-if="showFileRevisionDialog" class="modal-backdrop" aria-label="文件修订">
      <form class="modal-panel brief-revision-dialog file-revision-dialog" @submit.prevent="submitFileRevision">
        <header>
          <div>
            <h2>文件修订</h2>
          </div>
          <button type="button" class="modal-close-button" @click="workspaceUiStore.closeFileRevision">
            <UiIcon name="x" :size="18" />
          </button>
        </header>
        <label class="dialog-field">
          <span>文件路径</span>
          <div class="file-revision-path-row">
            <input v-model="fileRevisionPath" type="text" placeholder="docs/result.md" />
            <button
              type="button"
              :disabled="isSubmittingFileRevision || !fileRevisionPath.trim()"
              @click="captureFileRevisionBaseline"
            >
              记录修改前版本
            </button>
          </div>
        </label>
        <label v-if="fileRevisionBaselines.length" class="dialog-field">
          <span>修改前版本</span>
          <select v-model="selectedFileRevisionBaselineId">
            <option v-for="baseline in fileRevisionBaselines" :key="baseline.id" :value="baseline.id">
              {{ baseline.filePath }} · {{ baseline.hash.value.slice(0, 10) }} · {{ new Date(baseline.capturedAt).toLocaleString() }}
            </option>
          </select>
        </label>
        <dl v-if="selectedFileRevisionBaseline" class="file-revision-baseline-summary">
          <div>
            <dt>文件</dt>
            <dd>{{ selectedFileRevisionBaseline.filePath }}</dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd>{{ selectedFileRevisionBaseline.hash.value.slice(0, 16) }}</dd>
          </div>
        </dl>
        <fieldset class="dialog-field">
          <legend>处理 Agent</legend>
          <div class="agent-selector">
            <label v-for="agent in fileRevisionAgents" :key="agent.id" class="agent-checkbox">
              <input
                v-model="selectedFileRevisionAgentIds"
                type="checkbox"
                :value="agent.id"
                @change="workspaceUiStore.fileRevisionError = ''"
              />
              <span>{{ agent.name }}</span>
            </label>
          </div>
        </fieldset>
        <label class="dialog-field">
          <span>处理说明（可选）</span>
          <textarea
            v-model="fileRevisionInstruction"
            rows="3"
            maxlength="2000"
            placeholder="例如：检查修订后的内容是否仍满足验收目标"
          />
        </label>
        <p v-if="fileRevisionError" class="form-error">{{ fileRevisionError }}</p>
        <footer class="form-actions">
          <button type="button" @click="workspaceUiStore.closeFileRevision">取消</button>
          <button
            type="submit"
            class="primary"
            :disabled="isSubmittingFileRevision || !selectedFileRevisionBaselineId || !selectedFileRevisionAgentIds.length"
          >
            {{ isSubmittingFileRevision ? '处理中' : '确认已修改并处理' }}
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
