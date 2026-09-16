import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { apiGet, apiPage } from '@/api/client'
import type { AgentTask, Artifact, WorkflowRun, WorkflowNodeRun, WorkflowApprovalRecord, WorkflowVersion } from '@agent-cluster/shared'

export type RunDetail = { run: WorkflowRun; nodeRuns: WorkflowNodeRun[]; approvals: WorkflowApprovalRecord[] }
export type WorkspaceSelection = { runId: string; nodeId: string; taskId: string; nodeRunId: string }

export const useTaskWorkspaceStore = defineStore('taskWorkspace', () => {
  const sessionId = ref('')
  const runs = ref<WorkflowRun[]>([])
  const details = ref<Record<string, RunDetail>>({})
  const tasks = ref<AgentTask[]>([])
  const artifacts = ref<Artifact[]>([])
  const loading = ref(false)
  const error = ref('')
  const catalog = ref<WorkflowVersion[]>([])
  const catalogLoading = ref(false)
  const catalogError = ref('')
  const selections = reactive<Record<string, WorkspaceSelection>>({})
  let generation = 0
  let catalogGeneration = 0
  const selection = computed(() => selections[sessionId.value] ?? { runId: '', nodeId: '', taskId: '', nodeRunId: '' })
  const detail = computed(() => details.value[selection.value.runId])

  function select(patch: Partial<WorkspaceSelection>) {
    if (!sessionId.value) return
    selections[sessionId.value] = { ...selection.value, ...patch }
    try { sessionStorage.setItem(`task-workspace:${sessionId.value}`, JSON.stringify(selections[sessionId.value])) } catch { /* Storage may be disabled. */ }
  }

  async function load(id: string) {
    const request = ++generation
    if (sessionId.value !== id) {
      sessionId.value = id
      if (id && !selections[id]) {
        try {
          const saved = JSON.parse(sessionStorage.getItem(`task-workspace:${id}`) ?? 'null')
          if (saved && ['runId', 'nodeId', 'taskId', 'nodeRunId'].every(key => typeof saved[key] === 'string')) selections[id] = { runId: saved.runId, nodeId: saved.nodeId, taskId: saved.taskId, nodeRunId: saved.nodeRunId }
        } catch { /* Ignore obsolete or unavailable UI storage. */ }
      }
      runs.value = []; details.value = {}; tasks.value = []; artifacts.value = []
    }
    error.value = ''
    if (!id) { loading.value = false; return }
    loading.value = true
    try {
      const [history, taskPage, artifactPage] = await Promise.all([
        apiPage<WorkflowRun>(`/workflow-runs/session/${encodeURIComponent(id)}`),
        apiGet<AgentTask[]>(`/sessions/${encodeURIComponent(id)}/tasks`),
        apiPage<Artifact>(`/sessions/${encodeURIComponent(id)}/artifacts`)
      ])
      const runDetails = await Promise.all(history.items.map((run) => apiGet<RunDetail>(`/workflow-runs/${encodeURIComponent(run.id)}`)))
      if (request !== generation) return
      runs.value = history.items
      tasks.value = taskPage
      artifacts.value = artifactPage.items
      details.value = Object.fromEntries(runDetails.map((item) => [item.run.id, item]))
      if (!details.value[selection.value.runId]) select({ runId: history.items[0]?.id ?? '', nodeId: '', taskId: '', nodeRunId: '' })
    } catch (cause) {
      if (request === generation) error.value = cause instanceof Error ? cause.message : '读取执行记录失败'
    } finally {
      if (request === generation) loading.value = false
    }
  }

  async function loadCatalog() {
    const request = ++catalogGeneration
    catalogLoading.value = true; catalogError.value = ''
    try {
      const page = await apiPage<WorkflowVersion>('/workflows/catalog/published')
      if (request === catalogGeneration) catalog.value = page.items
    } catch (cause) {
      if (request === catalogGeneration) {
        catalog.value = []
        catalogError.value = cause instanceof Error ? cause.message : '读取流程目录失败'
      }
    } finally { if (request === catalogGeneration) catalogLoading.value = false }
  }
  return { sessionId, runs, details, detail, tasks, artifacts, loading, error, catalog, catalogLoading, catalogError, selection, select, load, loadCatalog }
})
