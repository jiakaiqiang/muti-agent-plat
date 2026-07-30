import { defineStore } from 'pinia'
import { apiGet } from '@/api/client'
import type {
  ContextEnvelopeV2,
  ExecutionTermination,
  ResolvedExecutionTarget,
  ResolvedToolCatalog,
  RuntimeInvocationProfileSnapshot
} from '@/types/contracts'

export type RuntimeUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cost?: number
  model?: string
}

export type RuntimeInvocationItem = {
  id: string
  dataEpoch: string
  invocationId: string
  sessionId: string
  taskId?: string
  agentId: string
  agentKey: string
  phase: string
  status: string
  identity: RuntimeInvocationProfileSnapshot
  executionTarget: ResolvedExecutionTarget
  toolCatalog: ResolvedToolCatalog
  contextEnvelope: ContextEnvelopeV2
  expectedOutput: { kind: string; schemaVersion: string }
  outputContract: { contractId: string; contractVersion: string; schemaHash: string }
  attempt?: {
    attemptGroupId: string
    attempt: number
    retryOfInvocationId?: string
    fallbackFromRuntimeType?: string
    fallbackReason?: string
    supplementalContextAttempt?: number
    supplementalContextDurationMs?: number
  }
  workspaceIndexGeneration?: number
  workspaceIndexStatus?: 'empty' | 'building' | 'ready' | 'stale' | 'failed'
  workspaceIndexComplete?: boolean
  workspaceRevisionAtStart: { id: string; observedAt: string }
  supplementalContextAttempt: number
  supplementalContextDurationMs: number
  evidenceBytes: number
  evidencePaths: string[]
  usage?: RuntimeUsage
  runtimeDiagnostics?: {
    providerNotifications: Array<{ method: string; disposition: string; payload: unknown }>
    unknownNotificationCount: number
    stderrTail: string | null
  }
  systemEvidence: {
    workspaceChangeSet: { id: string; changes: unknown[] } | null
    verifiedTestResults: Array<{
      command: string
      status: 'passed' | 'failed'
      exitCode: number | null
      stdout: string
      stderr: string
      startedAt: string
      completedAt: string
    }>
    capturedAt: string
    invocationId: string
  }
  error?: {
    code?: string
    message?: string
    requestedContext?: {
      reason?: string
      requestedPaths?: string[]
      requestedCommands?: string[]
      followUpInstruction?: string
    }
  }
  termination?: ExecutionTermination
  startedAt: string
  completedAt: string
  summary: {
    navigationCount: number
    evidenceCount: number
    evidenceBytes: number
    evidencePaths: string[]
    workspaceIndexGeneration?: number
    workspaceIndexStatus?: 'empty' | 'building' | 'ready' | 'stale' | 'failed'
    workspaceIndexComplete?: boolean
    workspaceRevisionAtStart: { id: string; observedAt: string }
    supplementalContextAttempt: number
    supplementalContextDurationMs: number
    projectModuleCount: number
    toolCount: number
    blockedToolCount: number
    memoryBulletCount: number
    artifactRefCount: number
  }
}

export type DebugTokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  invocationCount: number
  byInvocation: Array<{
    invocationId: string
    agentKey: string
    phase: string
    runtimeType: string
    usage?: RuntimeUsage
  }>
}

function emptyTokenUsage(): DebugTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    invocationCount: 0,
    byInvocation: []
  }
}

export const useDebugStore = defineStore('debug', {
  state: () => ({
    sessionId: '',
    loading: false,
    error: '',
    selectedInvocationId: '',
    invocations: [] as RuntimeInvocationItem[],
    tokenUsage: emptyTokenUsage()
  }),
  getters: {
    selectedInvocation: (state) =>
      state.invocations.find((item) => item.invocationId === state.selectedInvocationId) ?? state.invocations.at(-1)
  },
  actions: {
    async loadDebugData(sessionId: string) {
      if (!sessionId) return
      this.loading = true
      this.error = ''
      try {
        const [invocationPage, tokenData] = await Promise.all([
          apiGet<{ items: RuntimeInvocationItem[] }>(`/sessions/${sessionId}/debug/runtime-invocations`),
          apiGet<DebugTokenUsage>(`/sessions/${sessionId}/debug/token-usage`)
        ])
        this.sessionId = sessionId
        this.invocations = invocationPage.items
        this.tokenUsage = tokenData
        this.selectedInvocationId = invocationPage.items.at(-1)?.invocationId ?? ''
      } catch (caught) {
        this.error = caught instanceof Error ? caught.message : '审计数据加载失败'
      } finally {
        this.loading = false
      }
    },
    selectInvocation(invocationId: string) {
      this.selectedInvocationId = invocationId
    }
  }
})
