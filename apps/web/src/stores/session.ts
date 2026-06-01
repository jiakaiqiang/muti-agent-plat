import { defineStore } from 'pinia'
import { apiDelete, apiGet, apiPage, apiPost } from '@/api/client'
import type {
  Artifact,
  SessionDetail,
  SessionListItem,
  SessionStatus,
  SessionViewMode
} from '@/types/contracts'

type CreateSessionInput = {
  input: string
  agentIds?: string[]
  projectId?: string
  tokenBudget?: number
  knowledgeBaseIds?: string[]
  workspaceDir?: string
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
    async deleteSession(sessionId: string) {
      await apiDelete(`/sessions/${sessionId}`)
      this.sessions = this.sessions.filter((session) => session.id !== sessionId)
      if (this.currentSession?.id === sessionId) {
        this.currentSession = undefined
      }
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
    async sendFeishuNotification(sessionId: string, artifactId: string, confirmationId?: string) {
      return apiPost(`/sessions/${sessionId}/notifications/feishu`, { artifactId, confirmationId })
    },
    // 用户在「确认写入文件」卡上做出决策:写入(approved=true)或跳过(false),后端据此落盘并续跑剩余任务。
    async applyWriteConfirmation(sessionId: string, confirmationId: string, approved: boolean) {
      const result = await apiPost(`/sessions/${sessionId}/writes/${confirmationId}/apply`, { approved })
      await this.loadSession(sessionId)
      return result
    },
    // 列出某会话已产生的全部产物(供产物面板查看/下载)。
    async fetchArtifacts(sessionId: string) {
      const page = await apiPage<Artifact>(`/sessions/${sessionId}/artifacts`)
      return page.items
    },
    // 拉取单个产物详情(含完整内容/元数据),供产物面板内联查看。
    async fetchArtifact(artifactId: string) {
      return apiGet<Artifact>(`/artifacts/${artifactId}`)
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
