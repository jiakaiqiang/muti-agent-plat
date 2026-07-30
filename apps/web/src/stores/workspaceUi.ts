import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { RuntimeType } from '@/types/contracts'

export type WorkspaceKind = 'local_bridge' | 'server_local'
export type WorkspaceBindingStatus = 'idle' | 'binding' | 'bound' | 'failed'
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
  const sessionBindingStatus = ref<WorkspaceBindingStatus>('idle')
  const sessionRuntimeType = ref<RuntimeType | ''>('')
  const sessionModelId = ref('')
  const sessionWorkspaceKind = ref<WorkspaceKind>('local_bridge')
  const sessionServerWorkspacePath = ref(defaultServerWorkspacePath)
  const sessionLocalRuntimeWorkspaceId = ref('')

  const showBriefRevisionDialog = ref(false)
  const briefRevisionInput = ref('')
  const briefRevisionError = ref('')
  const isSubmittingBriefRevision = ref(false)

  const showWorkflowStepRevisionDialog = ref(false)
  const workflowStepRevisionInput = ref('')
  const workflowStepRevisionError = ref('')
  const isSubmittingWorkflowStepRevision = ref(false)

  const showFileRevisionDialog = ref(false)
  const fileRevisionPath = ref('')
  const selectedFileRevisionBaselineId = ref('')
  const selectedFileRevisionAgentIds = ref<string[]>([])
  const fileRevisionInstruction = ref('')
  const fileRevisionError = ref('')
  const isSubmittingFileRevision = ref(false)

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
    sessionBindingStatus.value = 'idle'
    sessionRuntimeType.value = ''
    sessionModelId.value = ''
    sessionWorkspaceKind.value = 'local_bridge'
    sessionLocalRuntimeWorkspaceId.value = ''
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

  function openFileRevision() {
    fileRevisionError.value = ''
    fileRevisionInstruction.value = ''
    showFileRevisionDialog.value = true
  }

  function closeFileRevision() {
    showFileRevisionDialog.value = false
    fileRevisionError.value = ''
  }

  function toggleFileRevisionAgent(agentId: string) {
    selectedFileRevisionAgentIds.value = selectedFileRevisionAgentIds.value.includes(agentId)
      ? selectedFileRevisionAgentIds.value.filter((id) => id !== agentId)
      : [...selectedFileRevisionAgentIds.value, agentId]
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
    isSubmittingFileRevision,
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
    openFileRevision,
    closeFileRevision,
    toggleFileRevisionAgent
  }
})
