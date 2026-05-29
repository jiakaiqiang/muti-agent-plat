import { defineStore } from 'pinia'
import { apiGet, apiPage, apiPost } from '@/api/client'
import type { SessionDetail, SessionListItem, SessionStatus, SessionViewMode } from '@/types/contracts'

type CreateSessionInput = {
  input: string
  agentIds?: string[]
  projectId?: string
  tokenBudget?: number
  knowledgeBaseIds?: string[]
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    sessions: [] as SessionListItem[],
    currentSession: undefined as SessionDetail | undefined,
    currentViewMode: 'chat' as SessionViewMode,
    loading: false
  }),
  actions: {
    async loadSessions() {
      this.loading = true
      try {
        const page = await apiPage<SessionListItem>('/sessions')
        this.sessions = page.items
      } finally {
        this.loading = false
      }
    },
    async createSession(input: CreateSessionInput) {
      const result = await apiPost<{ session: SessionDetail }>('/sessions', input)
      const session = result.session
      this.currentSession = session
      this.sessions = [
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
      ]
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
      return apiPost(`/sessions/${sessionId}/messages`, { content, mentionedAgentIds })
    },
    async confirmBrief(sessionId: string, briefId: string) {
      const result = await apiPost<{ brief: { status?: SessionStatus } }>(
        `/sessions/${sessionId}/briefs/${briefId}/confirm`
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
    switchViewMode(mode: SessionViewMode) {
      this.currentViewMode = mode
    },
    setCurrentStatus(sessionId: string, status: SessionStatus) {
      if (this.currentSession?.id === sessionId) {
        this.currentSession = { ...this.currentSession, status, updatedAt: new Date().toISOString() }
      }
      this.sessions = this.sessions.map((session) =>
        session.id === sessionId ? { ...session, status, updatedAt: new Date().toISOString() } : session
      )
    }
  }
})
