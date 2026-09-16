import { defineStore } from 'pinia'
import { apiDelete, apiGet, apiPage, apiPost, apiPut } from '@/api/client'
import { expectedBackendCommit } from '@/config/runtime'
import type {
  OpsHealth,
  FileRevisionBaseline,
  FileRevisionCandidate,
  FileRevisionEditorDraft,
  FileRevisionEditorDraftContent,
  FileRevisionRun,
  FileRevisionState,
  FileHash,
  IntentRoutingRecord,
  IntentRoutingStatus,
  SessionDetail,
  RuntimePreference,
  RuntimeStopSummary,
  SessionListItem,
  SessionStatus,
  SessionViewMode,
  SessionWorkingDirectory,
  CollaborationEvent,
  WorkItem
} from '@/types/contracts'
import type { PostReviewAction } from '@/types/contracts'

type CreateSessionInput = {
  input: string
  agentIds?: string[]
  projectId?: string
  tokenBudget?: number
  knowledgeBaseIds?: string[]
  workingDirectory?: SessionWorkingDirectory
  runtimePreference?: RuntimePreference
}

const favoriteStorageKey = 'agent-cluster.favorite-session-ids'
export const BACKEND_HEALTH_REQUEST_TIMEOUT_MS = 5_000
/**
 * 一次用户操作往往连着调好几个 action（selectWorkflow → loadSession → reconcile），
 * 每个 action 开头都 assertBackendCompatible()。逐个强制探活会把一次后端抖动
 * 放大成整页失联，所以同一操作窗口内复用上一次探活结果。
 * 只用于合并连锁调用，不用于长时间缓存：后端重启导致的版本错位仍会在下个窗口暴露。
 */
export const BACKEND_HEALTH_REUSE_WINDOW_MS = 2_000
export const SESSION_DELETE_REQUEST_TIMEOUT_MS = 20_000

function emptyFileRevisionState(): FileRevisionState {
  return { baselines: [], chains: [], runs: [], drafts: [] }
}

function normalizeSessionDeleteError(error: unknown) {
  if (!(error instanceof Error)) return new Error('删除会话失败，请稍后重试。')
  if (/Failed to fetch|fetch failed|NetworkError|Load failed|ERR_CONNECTION_REFUSED/i.test(error.message)) {
    return new Error('后端连接已中断，删除结果尚未确认；请恢复后端服务后重试。')
  }
  return error
}

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

const terminalIntentRoutingStatuses = new Set<IntentRoutingStatus>([
  'ROUTED',
  'CLARIFICATION_REQUIRED',
  'REJECTED'
])

function createMessageIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `message-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function waitForIntentRoutingPoll(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    sessions: [] as SessionListItem[],
    currentSession: undefined as SessionDetail | undefined,
    currentViewMode: 'chat' as SessionViewMode,
    sessionLoadGeneration: 0,
    loading: false,
    favoriteSessionIds: loadFavoriteSessionIds() as string[],
    deletingSessionIds: [] as string[],
    runtimeHealth: undefined as OpsHealth | undefined,
    runtimeHealthChecked: false,
    runtimeHealthCheckedAt: 0,
    runtimeHealthError: undefined as string | undefined,
    fileRevisionStatesBySession: {} as Record<string, FileRevisionState>,
    fileRevisionCandidates: {} as Record<string, FileRevisionCandidate>,
    fileRevisionDraftContents: {} as Record<string, FileRevisionEditorDraftContent>,
    fileRevisionRequestGeneration: {} as Record<string, number>,
    fileRevisionCandidateRequestGeneration: {} as Record<string, number>,
    fileRevisionDraftRequestGeneration: {} as Record<string, number>,
    fileRevisionLoadingBySession: {} as Record<string, boolean>,
    workItemsBySession: {} as Record<string, WorkItem[]>,
    intentRoutingsById: {} as Record<string, IntentRoutingRecord>,
    intentRoutingIdsBySession: {} as Record<string, string[]>,
    stopStatesBySession: {} as Record<string, RuntimeStopSummary>,
    stopStateErrorsBySession: {} as Record<string, string>
  }),
  getters: {
    isFavorite: (state) => (sessionId: string) => state.favoriteSessionIds.includes(sessionId),
    backendCompatible: (state) => runtimeHealthCompatible(state.runtimeHealth, expectedBackendCommit),
    fileRevisionState: (state) => state.currentSession
      ? state.fileRevisionStatesBySession[state.currentSession.id] ?? emptyFileRevisionState()
      : emptyFileRevisionState(),
    fileRevisionLoading: (state) => Boolean(
      state.currentSession && state.fileRevisionLoadingBySession[state.currentSession.id]
    ),
    activeWorkItem: (state) => {
      const session = state.currentSession
      if (!session?.activeWorkItemId) return undefined
      return (state.workItemsBySession[session.id] ?? []).find((item) => item.id === session.activeWorkItemId)
    },
    pendingIntentRoutingCount: (state) => (sessionId: string) =>
      (state.intentRoutingIdsBySession[sessionId] ?? []).filter((routingId) => {
        const status = state.intentRoutingsById[routingId]?.status
        return status !== undefined && !terminalIntentRoutingStatuses.has(status)
      }).length
  },
  actions: {
    async loadRuntimeHealth(force = false) {
      if (this.runtimeHealthChecked && !force) return this.runtimeHealth
      try {
        this.runtimeHealth = await apiGet<OpsHealth>('/health', {
          timeoutMs: BACKEND_HEALTH_REQUEST_TIMEOUT_MS,
          timeoutMessage: '后端健康检查超时，请确认后端服务已启动后重试。'
        })
        this.runtimeHealthError = this.backendCompatible
          ? undefined
          : `BACKEND_VERSION_MISMATCH: expected pipeline=v2 schema=3 stale=false${expectedBackendCommit ? ` commit=${expectedBackendCommit}` : ''}; received pipeline=${this.runtimeHealth.pipelineVersion} schema=${this.runtimeHealth.dataSchemaVersion} commit=${this.runtimeHealth.commit} build=${this.runtimeHealth.buildId ?? 'missing'} stale=${String(this.runtimeHealth.runtimeBuildStale)}.`
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
        this.runtimeHealthCheckedAt = Date.now()
      }
    },
    async assertBackendCompatible() {
      // 同一操作窗口内已经探活成功过就复用，避免一次用户操作打好几次 /health。
      // 上一次探活失败时不复用：那种情况必须立刻重试，否则错误状态会粘住。
      const reusable =
        this.runtimeHealth !== undefined &&
        this.runtimeHealthError === undefined &&
        Date.now() - this.runtimeHealthCheckedAt < BACKEND_HEALTH_REUSE_WINDOW_MS
      if (!reusable) await this.loadRuntimeHealth(true)
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
        const visible = new Map(this.sessions.map(item => [item.id, item]))
        this.sessions = sortSessionsByRecency(page.items.map(item => {
          const current = visible.get(item.id)
          return current && Date.parse(current.updatedAt) > Date.parse(item.updatedAt) ? current : item
        }))
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
      await this.loadWorkItems(session.id)
      return session
    },
    async loadSession(sessionId?: string) {
      const generation = ++this.sessionLoadGeneration
      await this.assertBackendCompatible()
      this.loading = true
      const selectedSessionId = sessionId ?? this.sessions[0]?.id
      if (!sessionId && !this.sessions.length) {
        this.currentSession = undefined
        this.loading = false
        return
      }
      try {
        const session = await apiGet<SessionDetail>(`/sessions/${selectedSessionId}`)
        if (generation !== this.sessionLoadGeneration) return
        this.currentSession = session
        if (this.currentSession) await Promise.all([
          this.loadWorkItems(this.currentSession.id),
          this.loadStopState(this.currentSession.id)
        ])
      } finally {
        if (generation === this.sessionLoadGeneration) this.loading = false
      }
    },
    async sendMessage(sessionId: string, content: string, mentionedAgentIds: string[] = []) {
      await this.assertBackendCompatible()
      const result = await apiPost<{
        event: CollaborationEvent
        routingId?: string
        routingStatus?: IntentRoutingStatus
      }>(`/sessions/${sessionId}/messages`, { content, mentionedAgentIds }, {
        headers: { 'Idempotency-Key': createMessageIdempotencyKey() }
      })
      if (result.routingId) {
        this.recordIntentRouting(sessionId, {
          id: result.routingId,
          sessionId,
          status: result.routingStatus ?? 'RECEIVED'
        } as IntentRoutingRecord)
        void this.pollIntentRouting(sessionId, result.routingId).catch((error) => {
          console.warn(`Failed to track intent routing ${result.routingId}.`, error)
        })
      }
      return result
    },
    async loadWorkItems(sessionId: string) {
      const page = await apiPage<WorkItem>(`/sessions/${sessionId}/work-items`)
      this.workItemsBySession[sessionId] = page.items
      return page.items
    },
    async loadStopState(sessionId: string) {
      try {
        const summary = await apiGet<RuntimeStopSummary>(`/sessions/${sessionId}/stop-state`)
        this.applyStopState(summary)
        delete this.stopStateErrorsBySession[sessionId]
        return summary
      } catch (error) {
        this.stopStateErrorsBySession[sessionId] = error instanceof Error ? error.message : '停止状态查询失败'
        const current = this.stopStatesBySession[sessionId]
        const unknown: RuntimeStopSummary = {
          sessionId,
          stopRequestId: current?.stopRequestId,
          version: current?.version ?? 0,
          status: 'unknown',
          requestedCount: current?.requestedCount ?? 0,
          confirmedCount: current?.confirmedCount ?? 0,
          targets: current?.targets ?? [],
          blockers: [{ reason: 'state_query_failed', message: '停止状态查询失败，暂不能确认是否可继续。' }],
          canResume: false,
          updatedAt: current?.updatedAt
        }
        this.stopStatesBySession[sessionId] = unknown
        return unknown
      }
    },
    applyStopState(summary: RuntimeStopSummary) {
      const current = this.stopStatesBySession[summary.sessionId]
      if (current?.stopRequestId === summary.stopRequestId && current.version > summary.version) return false
      if (current?.stopRequestId && summary.stopRequestId && current.stopRequestId !== summary.stopRequestId &&
          current.updatedAt && summary.updatedAt && Date.parse(current.updatedAt) > Date.parse(summary.updatedAt)) return false
      this.stopStatesBySession[summary.sessionId] = summary
      return true
    },
    recordIntentRouting(sessionId: string, routing: IntentRoutingRecord) {
      this.intentRoutingsById[routing.id] = routing
      const ids = this.intentRoutingIdsBySession[sessionId] ?? []
      if (!ids.includes(routing.id)) this.intentRoutingIdsBySession[sessionId] = [...ids, routing.id]
    },
    async pollIntentRouting(sessionId: string, routingId: string) {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const routing = await apiGet<IntentRoutingRecord>(
          `/sessions/${sessionId}/message-routings/${routingId}`
        )
        this.recordIntentRouting(sessionId, routing)
        if (terminalIntentRoutingStatuses.has(routing.status)) {
          await this.loadWorkItems(sessionId)
          await this.refreshCurrentSession(sessionId)
          return routing
        }
        await waitForIntentRoutingPoll(1_000)
      }
      throw new Error(`Intent routing timed out: ${routingId}`)
    },
    async clarifyIntentRouting(
      sessionId: string,
      routingId: string,
      input: {
        choice: 'continue_current' | 'related_new' | 'independent_new'
        confirmationId?: string
      }
    ) {
      const result = await apiPost<{ routing: IntentRoutingRecord; workItem: WorkItem }>(
        `/sessions/${sessionId}/message-routings/${routingId}/clarify`,
        input
      )
      this.recordIntentRouting(sessionId, result.routing)
      await this.loadWorkItems(sessionId)
      await this.refreshCurrentSession(sessionId)
      return result
    },
    async loadFileRevisions(sessionId: string) {
      await this.assertBackendCompatible()
      const generation = (this.fileRevisionRequestGeneration[sessionId] ?? 0) + 1
      this.fileRevisionRequestGeneration[sessionId] = generation
      this.fileRevisionLoadingBySession[sessionId] = true
      try {
        const state = await apiGet<FileRevisionState>(
          `/sessions/${sessionId}/file-revisions`
        )
        if (this.fileRevisionRequestGeneration[sessionId] === generation) {
          this.fileRevisionStatesBySession[sessionId] = state
        }
        return state
      } finally {
        if (this.fileRevisionRequestGeneration[sessionId] === generation) {
          this.fileRevisionLoadingBySession[sessionId] = false
        }
      }
    },
    async refreshCurrentSession(sessionId: string) {
      await this.assertBackendCompatible()
      if (this.currentSession?.id !== sessionId) return undefined
      const generation = this.sessionLoadGeneration
      const snapshot = this.currentSession
      const refreshed = await apiGet<SessionDetail>(`/sessions/${sessionId}`)
      if (this.currentSession?.id === sessionId && generation === this.sessionLoadGeneration &&
          (this.currentSession === snapshot || Date.parse(refreshed.updatedAt) >= Date.parse(this.currentSession.updatedAt))) {
        this.currentSession = refreshed
      }
      return refreshed
    },
    fileRevisionCandidateFor(sessionId: string, revisionId: string) {
      return this.fileRevisionCandidates[`${sessionId}:${revisionId}`]
    },
    fileRevisionDraftFor(sessionId: string, revisionId: string) {
      return this.fileRevisionDraftContents[`${sessionId}:${revisionId}`]
    },
    async loadFileRevisionCandidate(sessionId: string, revisionId: string) {
      await this.assertBackendCompatible()
      const key = `${sessionId}:${revisionId}`
      const generation = (this.fileRevisionCandidateRequestGeneration[key] ?? 0) + 1
      this.fileRevisionCandidateRequestGeneration[key] = generation
      const candidate = await apiGet<FileRevisionCandidate>(
        `/sessions/${sessionId}/file-revisions/${revisionId}/candidate`
      )
      if (
        this.currentSession?.id === sessionId &&
        this.fileRevisionCandidateRequestGeneration[key] === generation
      ) {
        this.fileRevisionCandidates[key] = candidate
      }
      return candidate
    },
    async loadFileRevisionDraft(sessionId: string, revisionId: string) {
      await this.assertBackendCompatible()
      const key = `${sessionId}:${revisionId}`
      const generation = (this.fileRevisionDraftRequestGeneration[key] ?? 0) + 1
      this.fileRevisionDraftRequestGeneration[key] = generation
      const draft = await apiGet<FileRevisionEditorDraftContent | null>(
        `/sessions/${sessionId}/file-revisions/${revisionId}/draft`
      )
      if (
        this.currentSession?.id === sessionId &&
        this.fileRevisionDraftRequestGeneration[key] === generation
      ) {
        if (draft) this.fileRevisionDraftContents[key] = draft
        else delete this.fileRevisionDraftContents[key]
      }
      return draft
    },
    async saveFileRevisionDraft(
      sessionId: string,
      revisionId: string,
      expectedCandidateHash: FileHash,
      content: string
    ) {
      await this.assertBackendCompatible()
      const key = `${sessionId}:${revisionId}`
      this.fileRevisionDraftRequestGeneration[key] =
        (this.fileRevisionDraftRequestGeneration[key] ?? 0) + 1
      const draft = await apiPut<FileRevisionEditorDraft>(
        `/sessions/${sessionId}/file-revisions/${revisionId}/draft`,
        { expectedCandidateHash, content }
      )
      await this.loadFileRevisions(sessionId)
      this.fileRevisionDraftRequestGeneration[key] =
        (this.fileRevisionDraftRequestGeneration[key] ?? 0) + 1
      this.fileRevisionDraftContents[key] = { ...draft, content }
      return draft
    },
    async reprocessFileRevision(
      sessionId: string,
      revisionId: string,
      input: {
        draftHash: FileHash
        expectedCandidateHash: FileHash
        expectedStateVersion: number
        targetAgentIds?: string[]
        instruction?: string
      }
    ) {
      await this.assertBackendCompatible()
      const run = await apiPost<FileRevisionRun>(
        `/sessions/${sessionId}/file-revisions/${revisionId}/reprocess`,
        input
      )
      this.setCurrentStatus(sessionId, 'EXECUTING')
      await this.loadFileRevisions(sessionId)
      return run
    },
    async resolveFileRevisionFailure(
      sessionId: string,
      revisionId: string,
      input: {
        expectedStateVersion: number
        decision: 'retry_agents' | 'continue_with_successful' | 'abandon_revision'
        instruction?: string
      }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost<{
        run: FileRevisionRun
        chain: FileRevisionState['chains'][number]
        decision: typeof input.decision
      }>(`/sessions/${sessionId}/file-revisions/${revisionId}/failure-decision`, input)
      this.setCurrentStatus(sessionId, input.decision === 'abandon_revision' ? 'COMPLETED' : 'EXECUTING')
      await this.loadFileRevisions(sessionId)
      return result
    },
    async retryInterruptedFileRevision(
      sessionId: string,
      revisionId: string,
      input: { expectedStateVersion: number; retryKey: string }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost<{
        run: FileRevisionRun
        chain: FileRevisionState['chains'][number]
        mode: 'run_agents' | 'receiver_only' | 'apply_reconcile'
      }>(`/sessions/${sessionId}/file-revisions/${revisionId}/retry`, input)
      this.setCurrentStatus(sessionId, 'EXECUTING')
      await this.loadFileRevisions(sessionId)
      return result
    },
    async captureFileRevisionBaseline(sessionId: string, filePath: string) {
      await this.assertBackendCompatible()
      const baseline = await apiPost<FileRevisionBaseline>(`/sessions/${sessionId}/file-revisions/baselines`, {
        filePath,
        source: 'user_selected'
      })
      await this.loadFileRevisions(sessionId)
      return baseline
    },
    async startFileRevision(
      sessionId: string,
      baselineId: string,
      targetAgentIds: string[],
      instruction?: string
    ) {
      await this.assertBackendCompatible()
      const run = await apiPost<FileRevisionRun>(`/sessions/${sessionId}/file-revisions`, {
        baselineId,
        targetAgentIds,
        ...(instruction?.trim() ? { instruction: instruction.trim() } : {})
      })
      this.setCurrentStatus(sessionId, 'EXECUTING')
      await this.loadFileRevisions(sessionId)
      return run
    },
    async decideFileRevision(
      sessionId: string,
      revisionId: string,
      input: {
        confirmationId: string
        candidateHash: FileHash
        expectedStateVersion: number
        decision: 'apply_candidate' | 'abandon_revision'
      }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost(
        `/sessions/${sessionId}/file-revisions/${revisionId}/decision`,
        input
      )
      await Promise.all([this.refreshCurrentSession(sessionId), this.loadFileRevisions(sessionId)])
      return result
    },
    removeSessionFromState(sessionId: string) {
      this.sessions = this.sessions.filter((session) => session.id !== sessionId)
      this.favoriteSessionIds = this.favoriteSessionIds.filter((id) => id !== sessionId)
      persistFavoriteSessionIds(this.favoriteSessionIds)
      if (this.currentSession?.id === sessionId) {
        this.currentSession = undefined
      }
      delete this.fileRevisionStatesBySession[sessionId]
      delete this.fileRevisionLoadingBySession[sessionId]
      delete this.fileRevisionRequestGeneration[sessionId]
      for (const key of Object.keys(this.fileRevisionCandidates)) {
        if (key.startsWith(`${sessionId}:`)) delete this.fileRevisionCandidates[key]
      }
      for (const key of Object.keys(this.fileRevisionDraftContents)) {
        if (key.startsWith(`${sessionId}:`)) delete this.fileRevisionDraftContents[key]
      }
      for (const key of Object.keys(this.fileRevisionCandidateRequestGeneration)) {
        if (key.startsWith(`${sessionId}:`)) delete this.fileRevisionCandidateRequestGeneration[key]
      }
      for (const key of Object.keys(this.fileRevisionDraftRequestGeneration)) {
        if (key.startsWith(`${sessionId}:`)) delete this.fileRevisionDraftRequestGeneration[key]
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
        await apiDelete<{ deleted: boolean; sessionId: string }>(`/sessions/${sessionId}`, {
          timeoutMs: SESSION_DELETE_REQUEST_TIMEOUT_MS,
          timeoutMessage: '删除会话请求超时：后端可能正在退出或已经断开，删除结果尚未确认；请恢复服务后重试。'
        })
        deleted = true
      } catch (error) {
        if (error instanceof Error && error.message.includes('Session not found')) {
          deleted = true
        } else {
          throw normalizeSessionDeleteError(error)
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
    async confirmBrief(sessionId: string, briefId: string, confirmationId: string) {
      await this.assertBackendCompatible()
      // Execution now runs in the background; confirm returns "accepted" and the
      // UI follows execution over SSE rather than waiting for the full result.
      const result = await apiPost<{ accepted: boolean; status: SessionStatus }>(
        `/sessions/${sessionId}/briefs/${briefId}/confirm`,
        { confirmationId }
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
      const result = await apiPost<{ session: SessionDetail }>(
        `/sessions/${sessionId}/pause`,
        confirmationId ? { confirmationId } : undefined
      )
      if (this.currentSession?.id === sessionId) await this.loadSession(sessionId)
      return result
    },
    async resumeSession(sessionId: string, confirmationId?: string) {
      await this.assertBackendCompatible()
      const result = await apiPost<{ session: SessionDetail }>(
        `/sessions/${sessionId}/resume`,
        confirmationId ? { confirmationId } : undefined
      )
      if (this.currentSession?.id === sessionId) await this.loadSession(sessionId)
      return result
    },
    async cancelSession(sessionId: string, confirmationId?: string) {
      await this.assertBackendCompatible()
      await apiPost(`/sessions/${sessionId}/cancel`, confirmationId ? { confirmationId } : undefined)
      this.setCurrentStatus(sessionId, 'CANCELLED')
    },
    async resolveLocalRuntimePermission(
      sessionId: string,
      input: { confirmationId: string; decision: 'approve_once' | 'cancel' }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost<{ session: SessionDetail }>(
        `/sessions/${sessionId}/local-runtime/permissions/decision`,
        input
      )
      await this.loadSession(sessionId)
      return result
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
    async resolveWorkflowAgentSubstitution(
      sessionId: string,
      input: { confirmationId: string; taskId: string; agentId: string }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost<{ session: SessionDetail }>(
        `/sessions/${sessionId}/workflow/agent-substitution`,
        input
      )
      await this.loadSession(sessionId)
      return result
    },
    async resolveWorkflowAgentSkip(
      sessionId: string,
      input: { confirmationId: string; taskId: string; reason?: string }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost<{ session: SessionDetail }>(
        `/sessions/${sessionId}/workflow/agent-skip`,
        input
      )
      await this.loadSession(sessionId)
      return result
    },
    async resolveWorkflowUpstreamRerun(
      sessionId: string,
      input: {
        confirmationId: string
        nodeId?: string
        decision?: 'rerun_upstream' | 'retry_current'
        instruction?: string
      }
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost<{ session: SessionDetail }>(
        `/sessions/${sessionId}/workflow/upstream-rerun`,
        input
      )
      await this.loadSession(sessionId)
      return result
    },
    async resolveWorkspaceWriteback(
      sessionId: string,
      writebackId: string,
      input: import('@/types/contracts').ResolveWorkspaceWritebackInput
    ) {
      await this.assertBackendCompatible()
      const result = await apiPost<import('@/types/contracts').WorkspaceWritebackRecord>(
        `/sessions/${sessionId}/workspace-writebacks/${writebackId}/resolve`,
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
    async approveCapability(
      sessionId: string,
      capabilityId: string,
      input?: { agentId?: string; reason?: string }
    ) {
      await this.assertBackendCompatible()
      return apiPost(`/capabilities/${capabilityId}/approve`, { sessionId, ...input })
    },
    async approveCapabilities(
      sessionId: string,
      capabilityIds: string[],
      input?: { agentId?: string; reason?: string }
    ) {
      await this.assertBackendCompatible()
      return apiPost('/capabilities/approvals', { sessionId, capabilityIds, ...input })
    },
    switchViewMode(mode: SessionViewMode) {
      this.currentViewMode = mode
    },
    setCurrentStatus(sessionId: string, status: SessionStatus, updatedAt = new Date().toISOString()) {
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
    health.runtimeBuildStale === false &&
    Boolean(health.buildId) &&
    (!expectedCommit || health.commit === expectedCommit)
  )
}
