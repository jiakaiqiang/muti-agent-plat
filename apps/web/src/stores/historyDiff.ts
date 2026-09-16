import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { HistoricalFile } from '@/utils/historyDiffModel'
import { filesFromChanges } from '@/utils/historyDiffModel'
import { apiGet } from '@/api/client'
import type { AgentTask, Artifact, WorkflowDeliveryFileDiff } from '@agent-cluster/shared'

export const useHistoryDiffStore = defineStore('historyDiff', () => {
  const visible = ref(false)
  const files = ref<HistoricalFile[]>([])
  const selectedPath = ref('')
  const title = ref('')
  const source = ref('')
  const sessionId = ref('')
  let requestGeneration = 0
  function open(input: { files: HistoricalFile[]; path?: string; title: string; source: string; sessionId: string }) {
    ++requestGeneration
    files.value = input.files.map(file => ({ ...file }))
    selectedPath.value = input.path ?? input.files[0]?.path ?? ''
    title.value = input.title; source.value = input.source; sessionId.value = input.sessionId
    visible.value = true
  }
  function close() { ++requestGeneration; visible.value = false }
  async function openArtifact(artifactId: string, id: string) {
    const generation = ++requestGeneration
    try {
      const artifact = await apiGet<Artifact>(`/artifacts/${encodeURIComponent(artifactId)}`)
      if (generation !== requestGeneration || artifact.sessionId !== id) return
      const changes = artifact.systemEvidence?.workspaceChangeSet
      const files = changes ? filesFromChanges(changes.changes) : [{ path: artifact.uri ?? artifact.title, operation: 'reference' as const, after: artifact.contentSummary, notice: '此产物未保存文件变更两端；仅展示已保存的摘要。' }]
      open({ files, title: artifact.title, source: `${artifact.taskId ?? ''} · ${artifact.agentId ?? ''} · ${artifact.createdAt} · 本轮执行前 → 执行后 · ${changes?.id ?? '无版本化变更'}`, sessionId: id })
    } catch (error) {
      if (generation === requestGeneration) open({ files: [], title: '产物读取失败', source: error instanceof Error ? error.message : '无法读取产物', sessionId: id })
    }
  }
  async function openDelivery(runId: string, id: string) {
    const generation = ++requestGeneration
    try {
      const result = await apiGet<WorkflowDeliveryFileDiff>(`/workflow-runs/${encodeURIComponent(runId)}/file-diff`)
      if (generation !== requestGeneration) return
      open({ files: result.files, title: '最终交付文件差异', source: `${result.source}${result.reason ? ` · ${result.reason}` : ''}`, sessionId: id })
    } catch (error) {
      if (generation === requestGeneration) open({ files: [], title: '交付差异读取失败', source: error instanceof Error ? error.message : '无法读取历史差异', sessionId: id })
    }
  }
  async function openDeliveryArtifact(artifactId: string, id: string) {
    const generation = ++requestGeneration
    try {
      const [artifact, tasks] = await Promise.all([
        apiGet<Artifact>(`/artifacts/${encodeURIComponent(artifactId)}`),
        apiGet<AgentTask[]>(`/sessions/${encodeURIComponent(id)}/tasks`)
      ])
      if (generation !== requestGeneration || artifact.sessionId !== id) return
      const runId = tasks.find(task => task.id === artifact.taskId && task.sessionId === id)?.workflowRunId
      if (runId) await openDelivery(runId, id)
      else open({ files: [], title: artifact.title, source: '此交付证据未关联到工作流运行，无法确定累计比较范围。', sessionId: id })
    } catch (error) {
      if (generation === requestGeneration) open({ files: [], title: '交付证据读取失败', source: error instanceof Error ? error.message : '无法读取历史证据', sessionId: id })
    }
  }
  return { visible, files, selectedPath, title, source, sessionId, open, close, openArtifact, openDelivery, openDeliveryArtifact }
})
