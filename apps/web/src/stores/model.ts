import { defineStore } from 'pinia'
import { apiDelete, apiGet, apiPatch, apiPost } from '@/api/client'
import type { ModelConnection, ModelDefinition, ModelFeatureFlags, ModelProvider, ModelSource } from '@/types/contracts'

export type ConnectionInput = {
  name?: string
  source?: ModelSource
  provider?: ModelProvider
  baseUrl?: string
  credential?: string | null
}

export type ModelInput = {
  connectionId?: string
  name?: string
  upstreamModel?: string
  features?: Partial<ModelFeatureFlags>
  status?: 'active' | 'disabled'
}

export const useModelStore = defineStore('model', {
  state: () => ({
    connections: [] as ModelConnection[],
    models: [] as ModelDefinition[]
  }),
  getters: {
    connectionName: (state) => (id?: string) =>
      id ? state.connections.find((connection) => connection.id === id)?.name ?? id : '—'
  },
  actions: {
    async loadAll() {
      await Promise.all([this.loadConnections(), this.loadModels()])
    },
    async loadConnections() {
      this.connections = await apiGet<ModelConnection[]>('/connections')
    },
    async loadModels() {
      this.models = await apiGet<ModelDefinition[]>('/models')
    },
    async createConnection(input: ConnectionInput) {
      const connection = await apiPost<ModelConnection>('/connections', input)
      this.connections = [connection, ...this.connections.filter((item) => item.id !== connection.id)]
      return connection
    },
    async updateConnection(id: string, input: ConnectionInput) {
      const connection = await apiPatch<ModelConnection>(`/connections/${id}`, input)
      this.connections = this.connections.map((item) => (item.id === connection.id ? connection : item))
      return connection
    },
    async deleteConnection(id: string) {
      await apiDelete(`/connections/${id}`)
      this.connections = this.connections.filter((item) => item.id !== id)
      this.models = this.models.filter((item) => item.connectionId !== id)
    },
    async discoverModels(id: string) {
      const result = await apiPost<{ models: string[] }>(`/connections/${id}/discover`)
      return result.models
    },
    async createModel(input: ModelInput) {
      const model = await apiPost<ModelDefinition>('/models', input)
      this.models = [model, ...this.models.filter((item) => item.id !== model.id)]
      return model
    },
    async deleteModel(id: string) {
      await apiDelete(`/models/${id}`)
      this.models = this.models.filter((item) => item.id !== id)
    }
  }
})
