import { defineStore } from 'pinia'
import { apiDelete, apiGet, apiPage, apiPost } from '@/api/client'
import { expectedBackendCommit } from '@/config/runtime'
import type {
  OpsHealth,
  SessionDetail,
  RuntimePreference,
  SessionListItem,
  SessionStatus,
  SessionViewMode,
  SessionWorkingDirectory,
  WorkspaceSnapshot,
  CollaborationEvent
} from '@/types/contracts'
import type { PostReviewAction } from '@/types/contracts'

type CreateSessionInput = {
  input: string
  agentIds?: string[]
  projectId?: string
  tokenBudget?: number
  knowledgeBaseIds?: string[]
  workingDirectory?: SessionWorkingDirectory
  workspaceSnapshot?: WorkspaceSnapshot
  runtimePreference?: RuntimePreference
}

const favoriteStorageKey = 'agent-cluster.favorite-session-ids'

function loadFavoriteSessionIds() {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(favoriteStorageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

function persistFavoriteSessionIds(ids: string[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(favoriteStorageKey, JSON.stringify(ids))
}

function sortSessionsByRecency(sessions: SessionListItem[]) {
  return [...sessions].sort((left, right) => sessionRecencyTime(right) - sessionRecencyTime(left))
}

function sessionRecencyTime(session: SessionListItem) {
  return Date.parse(session.updatedAt || session.createdAt) || Date.parse(session.createdAt) || 0
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    sessions: [] as SessionListItem[],
    currentSession: undefined as SessionDetail | undefined,
    currentViewMode: 'chat' as SessionViewMode,
    loading: false,
    favoriteSessionIds: loadFavoriteSessionIds() as string[],
    deletingSessionIds: [] as string[],
    runtimeHealth: undefined as OpsHealth | undefined,
    runtimeHealthChecked: false,
    runtimeHealthError: undefined as string | undefined
  }),
  getters: {
    isFavorite: (state) => (sessionId: string) => state.favoriteSessionIds.includes(sessionId),
    backendCompatible: (state) => runtimeHealthCompatible(state.runtimeHealth, expectedBackendCommit)
  },
  actions: {
    async loadRuntimeHealth(force = false) {
      if (this.runtimeHealthChecked && !force) return this.runtimeHealth
      try {
        this.runtimeHealth = await apiGet<OpsHealth>('/health')
        this.runtimeHealthError = this.backendCompatible
          ? undefined
          : `BACKEND_VERSION_MISMATCH: expected pipeline=v2 schema=3${expectedBackendCommit ? ` commit=${expectedBackendCommit}` : ''}; received pipeline=${this.runtimeHealth.pipelineVersion} schema=${this.runtimeHealth.dataSchemaVersion} commit=${this.runtimeHealth.commit}.`
        if (this.runtimeHealthError) {
          this.sessions = []
          this.currentSession = undefined
        }
        return this.runtimeHealth
      } catch (error) {
        this.runtimeHealth = undefined
        this.runtimeHealthError = error instanceof Error ? error.message : 'BACKEND_HEALTH_UNAVAILABLE'
        this.sessions = []
        this.currentSession = undefined
        throw error
      } finally {
        this.runtimeHealthChecked = true
      }
    },
    async assertBackendCompatible() {
      await this.loadRuntimeHealth(true)
      if (!this.backendCompatible) {
        this.sessions = []
        this.currentSession = undefined
        throw new Error(this.runtimeHealthError ?? 'BACKEND_VERSION_MISMATCH')
      }
    },
    async loadSessions() {
      await this.assertBackendCompatible()
      this.loading = true
      try {
        const page = await apiPage<SessionListItem>('/sessions')
        this.sessions = sortSessionsByRecency(page.items)
      } finally {
        this.loading = false
      }
    },
    async createSession(input: CreateSessionInput) {
      await this.assertBackendCompatible()
      const result = await apiPost<{ session: SessionDetail }>('/sessions', input)
      const session = result.session
      this.currentSession = session
      this.sessions = sortSessionsByRecency([
        {
          id: session.id,
          title: session.title,
          status: session.status,
          agentCount: session.participatingAgentIds.length,
          requiresUserAction: false,
          tokenBudget: session.tokenBudget,
          tokenUsed: session.tokenUsed,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        },
        ...this.sessions
      ])
      return session
    },
    async loadSession(sessionId?: string) {
      await this.assertBackendCompatible()
      this.loading = true
      const selectedSessionId = sessionId ?? this.sessions[0]?.id
      if (!sessionId && !this.sessions.length) {
        this.currentSession = undefined
        this.loading = false
        return
      }
      try {
        this.currentSession = await apiGet<SessionDetail>(`/sessions/${selectedSessionId}`)
      } finally {
        this.loading = false
      }
    },
    async sendMessage(sessionId: string, content: string, mentionedAgentIds: string[] = []) {
      await this.assertBackendCompatible()
      return apiPost<{ event: CollaborationEvent }>(`/sessions/${sessionId}/messages`, { content, mentionedAgentIds })
    },
    async refreshWorkspaceSnapshot(sessionId: string, workspaceId: string, workspaceSnapshot: WorkspaceSnapshot) {
      await this.assertBackendCompatible()
      const result = await apiPost<{
        session: SessionDetail
        updatedSessionIds: string[]
      }>(`/sessions/${sessionId}/workspace/snapshot`, { workspaceId, workspaceSnapshot })
      if (this.currentSession?.id === sessionId) this.currentSession = result.session
      return result
    },
    removeSessionFromState(sessionId: string) {
      this.sessions = this.sessions.filter((session) => session.id !== sessionId)
      this.favoriteSessionIds = this.favoriteSessionIds.filter((id) => id !== sessionId)
      persistFavoriteSessionIds(this.favoriteSessionIds)
      if (this.currentSession?.id === sessionId) {
        this.currentSession = undefined
      }
    },
    async deleteSession(sessionId: string) {
      await this.assertBackendCompatible()
      if (this.deletingSessionIds.includes(sessionId)) {
        return false
      }

      this.deletingSessionIds = [...this.deletingSessionIds, sessionId]
      let deleted = false
      try {
        await apiDelete<{ deleted: boolean; sessionId: string }>(`/sessions/${sessionId}`)
        deleted = true
      } catch (error) {
        if (error instanceof Error && error.message.includes('Session not found')) {
          deleted = true
        } else {
          throw error
        }
      } finally {
        this.deletingSessionIds = this.deletingSessionIds.filter((id) => id !== sessionId)
      }

      if (deleted) {
        this.removeSessionFromState(sessionId)
      }
      return deleted
    },
    toggleFavoriteSession(sessionId: string) {
      this.favoriteSessionIds = this.favoriteSessionIds.includes(sessionId)
        ? this.favoriteSessionIds.filter((id) => id !== sessionId)
        : [...this.favoriteSessionIds, sessionId]
      persistFavoriteSessionIds(this.favoriteSessionIds)
    },
    async confirmBrief(sessionId: string, briefId: string) {
      await this.assertBackendCompatible()
      // Execution now runs in the background; confirm returns "accepted" and the
      // UI follows execution over SSE rather than waiting for the full result.
      const result = await apiPost<{ accepted: boolean; status: SessionStatus }>(
        `/sessions/${sessionId}/briefs/${briefId}/confirm`
      )
      await this.loadSession(sessionId)
      return result
    },
    async reviseBrief(
      sessionId: string,
      briefId: string,
      input: { userMessage: string; confirmationId?: string; reason?: string; assignedAgentKeys?: string[] }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost<{ accepted: boolean; status: SessionStatus }>(
        `/sessions/${sessionId}/briefs/${briefId}/reject`,
        input
      )
      await this.loadSession(sessionId)
      return result
    },
    async pauseSession(sessionId: string, confirmationId?: string) {
      await this.assertBackendCompatible()
      await apiPost(`/sessions/${sessionId}/pause`, confirmationId ? { confirmationId } : undefined)
      this.setCurrentStatus(sessionId, 'WAIT_USER_DECISION')
    },
    async resumeSession(sessionId: string, confirmationId?: string) {
      await this.assertBackendCompatible()
      await apiPost(`/sessions/${sessionId}/resume`, confirmationId ? { confirmationId } : undefined)
      this.setCurrentStatus(sessionId, 'EXECUTING')
    },
    async cancelSession(sessionId: string, confirmationId?: string) {
      await this.assertBackendCompatible()
      await apiPost(`/sessions/${sessionId}/cancel`, confirmationId ? { confirmationId } : undefined)
      this.setCurrentStatus(sessionId, 'CANCELLED')
    },
    async resolvePostReviewAction(
      sessionId: string,
      input: { confirmationId: string; action: PostReviewAction['action'] }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost<{ session: SessionDetail; action: PostReviewAction }>(
        `/sessions/${sessionId}/post-review/actions`,
        input
      )
      await this.loadSession(sessionId)
      return result
    },
    async selectWorkflow(
      sessionId: string,
      input: { workflowId: string; workflowVersion: number; confirmationId: string }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost<{ session: SessionDetail }>(`/sessions/${sessionId}/workflow/select`, input)
      await this.loadSession(sessionId)
      return result
    },
    async resolveEmptyWorkspaceDecision(
      sessionId: string,
      input: {
        confirmationId: string
        decision: 'initialize_project' | 'reselect_workspace' | 'cancel'
      }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost<{ session: SessionDetail }>(
        `/sessions/${sessionId}/workspace/empty-decision`,
        input
      )
      await this.loadSession(sessionId)
      return result
    },
    async resolveWorkflowHumanDecision(
      sessionId: string,
      runId: string,
      nodeRunId: string,
      input: {
        confirmationId: string
        expectedRunRevision?: number
        decision: 'approve' | 'revise' | 'cancel'
        instruction?: string
      }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost(`/workflow-runs/${runId}/nodes/${nodeRunId}/decision`, input)
      await this.loadSession(sessionId)
      return result
    },
    async resolveWorkflowStep(
      sessionId: string,
      taskId: string,
      input: { confirmationId: string; decision: 'approve' | 'revise'; instruction?: string }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost<{ session: SessionDetail }>(
        `/sessions/${sessionId}/workflow/steps/${taskId}/decision`,
        input
      )
      await this.loadSession(sessionId)
      return result
    },
    async confirmMemory(
      sessionId: string,
      input: { content: string; confirmationId?: string; sourceEventId?: string; confidence?: number }
    ) {
      await this.assertBackendCompatible()
      return apiPost(`/sessions/${sessionId}/memories/confirm`, input)
    },
    async decideFeishuNotification(
      sessionId: string,
      input: {
        confirmationId?: string
        notificationDraftArtifactId?: string
        decision: 'send_notification' | 'skip_notification'
      }
    ) {
      await this.assertBackendCompatible()
      return apiPost(`/sessions/${sessionId}/notifications/feishu/decision`, input)
    },
    async decideLocalReportSave(
      sessionId: string,
      input: {
        confirmationId: string
        artifactId: string
        decision: 'save_local' | 'keep_in_session'
      }
    ) {
      await this.assertBackendCompatible()
      return apiPost(`/sessions/${sessionId}/reports/local-save/decision`, input)
    },
    switchViewMode(mode: SessionViewMode) {
      this.currentViewMode = mode
    },
    setCurrentStatus(sessionId: string, status: SessionStatus) {
      const updatedAt = new Date().toISOString()
      if (this.currentSession?.id === sessionId) {
        this.currentSession = { ...this.currentSession, status, updatedAt }
      }
      this.sessions = sortSessionsByRecency(
        this.sessions.map((session) => (session.id === sessionId ? { ...session, status, updatedAt } : session))
      )
    }
  }
})

export function runtimeHealthCompatible(health: OpsHealth | undefined, expectedCommit = '') {
  return (
    health?.pipelineVersion === 'v2' &&
    health.dataSchemaVersion === 3 &&
    (!expectedCommit || health.commit === expectedCommit)
  )
}
