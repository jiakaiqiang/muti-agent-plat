import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { ReviewableFileChange } from './localWorkspace'
import type { RuntimeType, WorkspaceSnapshot } from '@/types/contracts'

export type WorkspaceKind = 'browser_local' | 'server_local'
export type WorkspaceScanStatus = 'idle' | 'scanning' | 'completed' | 'failed'
export type UiMessageType = 'success' | 'warning' | 'error' | 'info'
export type SessionListTab = 'all' | 'mine' | 'favorites'
export type WorkflowStageKey = 'intake' | 'brief' | 'dispatch' | 'execution' | 'review'

export type WorkspaceUiMessage = {
  id: number
  type: UiMessageType
  text: string
}

const defaultServerWorkspacePath = String(import.meta.env.VITE_DEFAULT_SERVER_WORKSPACE_PATH ?? '')

/**
 * Shared state for the workspace's multi-step UI flows.
 *
 * Domain entities remain in their domain stores. This store owns only interaction
 * state that must survive component replacement or be shared by workspace children.
 */
export const useWorkspaceUiStore = defineStore('workspaceUi', () => {
  const isSendingMessage = ref(false)
  const showAgentPopover = ref(false)
  const sessionListTab = ref<SessionListTab>('all')
  const sessionSearchQuery = ref('')
  const messageDraft = ref('')
  const selectedWorkflowStage = ref<WorkflowStageKey>('intake')

  const showCreateSessionDialog = ref(false)
  const showCreateConfirmDialog = ref(false)
  const isCreatingSession = ref(false)
  const newSessionInput = ref('')
  const selectedSessionAgentIds = ref<string[]>([])
  const sessionCreateError = ref('')
  const pendingCreateInput = ref('')
  const sessionScanStatus = ref<WorkspaceScanStatus>('idle')
  const sessionScanSummary = ref<WorkspaceSnapshot>()
  const sessionRuntimeType = ref<RuntimeType | ''>('')
  const sessionModelId = ref('')
  const sessionWorkspaceKind = ref<WorkspaceKind>('browser_local')
  const sessionServerWorkspacePath = ref(defaultServerWorkspacePath)

  const showBriefRevisionDialog = ref(false)
  const briefRevisionInput = ref('')
  const briefRevisionError = ref('')
  const isSubmittingBriefRevision = ref(false)

  const showWorkflowStepRevisionDialog = ref(false)
  const workflowStepRevisionInput = ref('')
  const workflowStepRevisionError = ref('')
  const isSubmittingWorkflowStepRevision = ref(false)

  const showFileReviewDialog = ref(false)
  const reviewChanges = ref<ReviewableFileChange[]>([])
  const selectedChangePaths = ref<string[]>([])
  const isReviewLoading = ref(false)
  const isApplyingReview = ref(false)

  const uiMessage = ref<WorkspaceUiMessage>()
  let uiMessageTimer: ReturnType<typeof setTimeout> | undefined

  function showMessage(text: string, type: UiMessageType = 'info') {
    clearMessageTimer()
    uiMessage.value = { id: Date.now(), type, text }
    uiMessageTimer = setTimeout(() => {
      uiMessage.value = undefined
      uiMessageTimer = undefined
    }, type === 'error' ? 4200 : 2600)
  }

  function clearMessage() {
    clearMessageTimer()
    uiMessage.value = undefined
  }

  function clearMessageTimer() {
    if (!uiMessageTimer) return
    clearTimeout(uiMessageTimer)
    uiMessageTimer = undefined
  }

  function resetCreateSessionDraft() {
    showCreateConfirmDialog.value = false
    isCreatingSession.value = false
    newSessionInput.value = ''
    selectedSessionAgentIds.value = []
    sessionCreateError.value = ''
    pendingCreateInput.value = ''
    sessionScanStatus.value = 'idle'
    sessionScanSummary.value = undefined
    sessionRuntimeType.value = ''
    sessionModelId.value = ''
    sessionWorkspaceKind.value = 'browser_local'
  }

  function openCreateSession() {
    resetCreateSessionDraft()
    showCreateSessionDialog.value = true
  }

  function closeCreateSession() {
    showCreateSessionDialog.value = false
    showCreateConfirmDialog.value = false
    sessionCreateError.value = ''
  }

  function setSessionWorkspaceKind(kind: WorkspaceKind) {
    sessionWorkspaceKind.value = kind
    sessionCreateError.value = ''
  }

  function toggleSessionAgent(agentId: string) {
    selectedSessionAgentIds.value = selectedSessionAgentIds.value.includes(agentId)
      ? selectedSessionAgentIds.value.filter((id) => id !== agentId)
      : [...selectedSessionAgentIds.value, agentId]
  }

  function openBriefRevision(content: string) {
    briefRevisionError.value = ''
    briefRevisionInput.value = content
    showBriefRevisionDialog.value = true
  }

  function closeBriefRevision() {
    showBriefRevisionDialog.value = false
    briefRevisionError.value = ''
  }

  function openWorkflowStepRevision() {
    workflowStepRevisionInput.value = ''
    workflowStepRevisionError.value = ''
    showWorkflowStepRevisionDialog.value = true
  }

  function closeWorkflowStepRevision() {
    showWorkflowStepRevisionDialog.value = false
    workflowStepRevisionError.value = ''
  }

  function openFileReview(changes: ReviewableFileChange[]) {
    reviewChanges.value = changes
    selectedChangePaths.value = changes.filter((item) => !item.conflict).map((item) => item.change.path)
    showFileReviewDialog.value = true
  }

  function toggleReviewPath(path: string) {
    if (reviewChanges.value.some((item) => item.change.path === path && item.conflict)) return
    selectedChangePaths.value = selectedChangePaths.value.includes(path)
      ? selectedChangePaths.value.filter((item) => item !== path)
      : [...selectedChangePaths.value, path]
  }

  function selectAllReviewPaths() {
    selectedChangePaths.value = reviewChanges.value
      .filter((item) => !item.conflict)
      .map((item) => item.change.path)
  }

  function clearReviewSelection() {
    selectedChangePaths.value = []
  }

  function closeFileReview() {
    showFileReviewDialog.value = false
    reviewChanges.value = []
    selectedChangePaths.value = []
  }

  return {
    isSendingMessage,
    showAgentPopover,
    sessionListTab,
    sessionSearchQuery,
    messageDraft,
    selectedWorkflowStage,
    showCreateSessionDialog,
    showCreateConfirmDialog,
    isCreatingSession,
    newSessionInput,
    selectedSessionAgentIds,
    sessionCreateError,
    pendingCreateInput,
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
    isApplyingReview,
    uiMessage,
    showMessage,
    clearMessage,
    resetCreateSessionDraft,
    openCreateSession,
    closeCreateSession,
    setSessionWorkspaceKind,
    toggleSessionAgent,
    openBriefRevision,
    closeBriefRevision,
    openWorkflowStepRevision,
    closeWorkflowStepRevision,
    openFileReview,
    toggleReviewPath,
    selectAllReviewPaths,
    clearReviewSelection,
    closeFileReview
  }
})
