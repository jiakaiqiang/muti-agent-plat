import { defineStore } from 'pinia'
import { apiDelete, apiGet, apiPatch, apiPost } from '@/api/client'
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowStatus, WorkflowVersion } from '@/types/contracts'

type WorkflowInput = {
  name: string
  description?: string
  expectedDraftRevision?: number
  nodes?: WorkflowNode[]
  edges?: WorkflowEdge[]
}

export const useWorkflowStore = defineStore('workflow', {
  state: () => ({
    workflows: [] as WorkflowDefinition[],
    versionsByWorkflowId: {} as Record<string, WorkflowVersion[]>,
    selectedWorkflowId: '' as string,
    loading: false,
    saving: false,
    managerView: 'list' as 'list' | 'editor',
    creating: false,
    draftName: '',
    draftDescription: '',
    draftNodes: [] as WorkflowNode[],
    selectedNodeId: '',
    searchQuery: '',
    statusFilter: 'all' as 'all' | WorkflowStatus,
    errorMessage: '',
    successMessage: '',
    dirty: false,
    undoStack: [] as WorkflowNode[][],
    redoStack: [] as WorkflowNode[][],
    deleteTarget: undefined as WorkflowDefinition | undefined
  }),
  getters: {
    selectedWorkflow: (state) =>
      state.workflows.find((workflow) => workflow.id === state.selectedWorkflowId),
    publishedWorkflows: (state) => state.workflows.filter((workflow) => workflow.status === 'published')
  },
  actions: {
    async loadWorkflows() {
      this.loading = true
      try {
        this.workflows = await apiGet<WorkflowDefinition[]>('/workflows')
        if (!this.workflows.some((workflow) => workflow.id === this.selectedWorkflowId)) {
          this.selectedWorkflowId = this.workflows[0]?.id ?? ''
        }
      } finally {
        this.loading = false
      }
    },
    async loadVersions(workflowId: string) {
      const versions = await apiGet<WorkflowVersion[]>(`/workflows/${workflowId}/versions`)
      this.versionsByWorkflowId = { ...this.versionsByWorkflowId, [workflowId]: versions }
      return versions
    },
    selectWorkflow(workflowId: string) {
      this.selectedWorkflowId = workflowId
    },
    async createWorkflow(input: WorkflowInput) {
      this.saving = true
      try {
        const workflow = await apiPost<WorkflowDefinition>('/workflows', input)
        this.workflows = [workflow, ...this.workflows]
        this.selectedWorkflowId = workflow.id
        return workflow
      } finally {
        this.saving = false
      }
    },
    async updateWorkflow(workflowId: string, input: WorkflowInput) {
      this.saving = true
      try {
        const workflow = await apiPatch<WorkflowDefinition>(`/workflows/${workflowId}/draft`, input)
        this.replaceWorkflow(workflow)
        return workflow
      } finally {
        this.saving = false
      }
    },
    async publishWorkflow(workflowId: string, expectedDraftRevision: number) {
      this.saving = true
      try {
        const workflow = await apiPost<WorkflowDefinition>(`/workflows/${workflowId}/publish`, { expectedDraftRevision })
        this.replaceWorkflow(workflow)
        await this.loadVersions(workflowId)
        return workflow
      } finally {
        this.saving = false
      }
    },
    async archiveWorkflow(workflowId: string) {
      const workflow = await apiPost<WorkflowDefinition>(`/workflows/${workflowId}/archive`, {})
      this.replaceWorkflow(workflow)
      return workflow
    },
    async deleteWorkflow(workflowId: string) {
      await apiDelete(`/workflows/${workflowId}`)
      this.workflows = this.workflows.filter((workflow) => workflow.id !== workflowId)
      if (this.selectedWorkflowId === workflowId) this.selectedWorkflowId = this.workflows[0]?.id ?? ''
    },
    replaceWorkflow(workflow: WorkflowDefinition) {
      this.workflows = this.workflows.map((item) => item.id === workflow.id ? workflow : item)
    },
    statusLabel(status: WorkflowStatus) {
      return { draft: '草稿', published: '已发布', archived: '已归档' }[status]
    }
  }
})
