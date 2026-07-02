import { defineStore } from 'pinia'
import { apiDelete, apiGet, apiPatch, apiPost } from '@/api/client'
import type { RuntimeModelConfig, RuntimeModelCreateInput, RuntimeModelUpdateInput } from '@/types/contracts'

export const useRuntimeModelStore = defineStore('runtimeModel', {
  state: () => ({
    config: undefined as RuntimeModelConfig | undefined,
    loading: false,
    saving: false,
    error: ''
  }),
  getters: {
    currentModel: (state) => state.config?.currentModel ?? '',
    currentModelId: (state) => state.config?.currentModelId ?? '',
    availableModels: (state) => state.config?.availableModels ?? []
  },
  actions: {
    async loadConfig() {
      this.loading = true
      this.error = ''
      try {
        this.config = await apiGet<RuntimeModelConfig>('/runtimes/model-config')
      } catch (error) {
        this.error = error instanceof Error ? error.message : '模型配置加载失败'
      } finally {
        this.loading = false
      }
    },
    async switchModel(model: string) {
      this.saving = true
      this.error = ''
      try {
        this.config = await apiPost<RuntimeModelConfig>('/runtimes/model-config/switch', { model })
      } catch (error) {
        this.error = error instanceof Error ? error.message : '模型切换失败'
        throw error
      } finally {
        this.saving = false
      }
    },
    async addModel(input: RuntimeModelCreateInput) {
      this.saving = true
      this.error = ''
      try {
        this.config = await apiPost<RuntimeModelConfig>('/runtimes/model-config/models', input)
      } catch (error) {
        this.error = error instanceof Error ? error.message : '模型添加失败'
        throw error
      } finally {
        this.saving = false
      }
    },
    async updateModel(modelId: string, input: RuntimeModelUpdateInput) {
      this.saving = true
      this.error = ''
      try {
        this.config = await apiPatch<RuntimeModelConfig>(
          `/runtimes/model-config/models/${encodeURIComponent(modelId)}`,
          input
        )
      } catch (error) {
        this.error = error instanceof Error ? error.message : '模型更新失败'
        throw error
      } finally {
        this.saving = false
      }
    },
    async deleteModel(modelId: string) {
      this.saving = true
      this.error = ''
      try {
        this.config = await apiDelete<RuntimeModelConfig>(
          `/runtimes/model-config/models/${encodeURIComponent(modelId)}`
        )
      } catch (error) {
        this.error = error instanceof Error ? error.message : '模型删除失败'
        throw error
      } finally {
        this.saving = false
      }
    }
  }
})
