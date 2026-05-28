import { defineStore } from 'pinia'
import { mockSession, mockSessionId, mockSessions } from '@/mock/mockEvents'
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
    loadSessions() {
      this.loading = true
      this.sessions = mockSessions
      this.loading = false
    },
    createSession(input: CreateSessionInput) {
      const now = new Date().toISOString()
      const session: SessionDetail = {
        id: `session-${Date.now()}`,
        title: input.input.slice(0, 28) || 'Untitled Session',
        originalInput: input.input,
        status: 'DRAFT_INPUT',
        ownerId: 'local-user',
        workspaceId: 'default-workspace',
        projectId: input.projectId,
        tokenBudget: input.tokenBudget,
        tokenUsed: 0,
        participatingAgentIds: input.agentIds ?? [],
        createdAt: now,
        updatedAt: now
      }
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
    loadSession(sessionId = mockSessionId) {
      this.loading = true
      this.currentSession = sessionId === mockSession.id ? mockSession : undefined
      this.loading = false
    },
    sendMessage(sessionId: string, content: string, mentionedAgentIds: string[] = []) {
      return { sessionId, content, mentionedAgentIds }
    },
    pauseSession(sessionId: string) {
      this.setCurrentStatus(sessionId, 'WAIT_USER_DECISION')
    },
    resumeSession(sessionId: string) {
      this.setCurrentStatus(sessionId, 'EXECUTING')
    },
    cancelSession(sessionId: string) {
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
