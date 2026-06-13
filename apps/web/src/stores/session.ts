import { defineStore } from 'pinia'
import { apiDelete, apiGet, apiPage, apiPost } from '@/api/client'
import type {
  SessionDetail,
  SessionListItem,
  SessionStatus,
  SessionViewMode,
  SessionWorkingDirectory,
  WorkspaceSnapshot,
  CollaborationEvent
} from '@/types/contracts'

type CreateSessionInput = {
  input: string
  agentIds?: string[]
  projectId?: string
  tokenBudget?: number
  knowledgeBaseIds?: string[]
  workingDirectory?: SessionWorkingDirectory
  workspaceSnapshot?: WorkspaceSnapshot
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
    favoriteSessionIds: loadFavoriteSessionIds() as string[]
  }),
  getters: {
    isFavorite: (state) => (sessionId: string) => state.favoriteSessionIds.includes(sessionId)
  },
  actions: {
    async loadSessions() {
      this.loading = true
      try {
        const page = await apiPage<SessionListItem>('/sessions')
        this.sessions = sortSessionsByRecency(page.items)
      } finally {
        this.loading = false
      }
    },
    async createSession(input: CreateSessionInput) {
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
      return apiPost<{ event: CollaborationEvent }>(`/sessions/${sessionId}/messages`, { content, mentionedAgentIds })
    },
    async deleteSession(sessionId: string) {
      await apiDelete<{ deleted: boolean; sessionId: string }>(`/sessions/${sessionId}`)
      this.sessions = this.sessions.filter((session) => session.id !== sessionId)
      this.favoriteSessionIds = this.favoriteSessionIds.filter((id) => id !== sessionId)
      persistFavoriteSessionIds(this.favoriteSessionIds)
      if (this.currentSession?.id === sessionId) {
        this.currentSession = undefined
      }
    },
    toggleFavoriteSession(sessionId: string) {
      this.favoriteSessionIds = this.favoriteSessionIds.includes(sessionId)
        ? this.favoriteSessionIds.filter((id) => id !== sessionId)
        : [...this.favoriteSessionIds, sessionId]
      persistFavoriteSessionIds(this.favoriteSessionIds)
    },
    async confirmBrief(sessionId: string, briefId: string) {
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
      input: { userMessage: string; confirmationId?: string; reason?: string }
    ) {
      const result = await apiPost<{ accepted: boolean; status: SessionStatus }>(
        `/sessions/${sessionId}/briefs/${briefId}/reject`,
        input
      )
      await this.loadSession(sessionId)
      return result
    },
    async pauseSession(sessionId: string, confirmationId?: string) {
      await apiPost(`/sessions/${sessionId}/pause`, confirmationId ? { confirmationId } : undefined)
      this.setCurrentStatus(sessionId, 'WAIT_USER_DECISION')
    },
    async resumeSession(sessionId: string, confirmationId?: string) {
      await apiPost(`/sessions/${sessionId}/resume`, confirmationId ? { confirmationId } : undefined)
      this.setCurrentStatus(sessionId, 'EXECUTING')
    },
    async cancelSession(sessionId: string, confirmationId?: string) {
      await apiPost(`/sessions/${sessionId}/cancel`, confirmationId ? { confirmationId } : undefined)
      this.setCurrentStatus(sessionId, 'CANCELLED')
    },
    async confirmMemory(
      sessionId: string,
      input: { content: string; confirmationId?: string; sourceEventId?: string; confidence?: number }
    ) {
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
      return apiPost(`/sessions/${sessionId}/notifications/feishu/decision`, input)
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
