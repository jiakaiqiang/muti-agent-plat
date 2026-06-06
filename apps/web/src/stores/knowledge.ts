import { defineStore } from 'pinia'
import { apiGet } from '@/api/client'
import type { KnowledgeBase, KnowledgeDocument } from '@/types/contracts'

export const useKnowledgeStore = defineStore('knowledge', {
  state: () => ({
    knowledgeBases: [] as KnowledgeBase[],
    documentsByKnowledgeBaseId: {} as Record<string, KnowledgeDocument[]>,
    indexingStatusByDocumentId: {} as Record<string, string>
  }),
  getters: {
    knowledgeBaseName: (state) => (knowledgeBaseId: string) =>
      state.knowledgeBases.find((base) => base.id === knowledgeBaseId)?.name ?? knowledgeBaseId
  },
  actions: {
    async loadKnowledgeBases() {
      this.knowledgeBases = await apiGet<KnowledgeBase[]>('/knowledge-bases')
      this.documentsByKnowledgeBaseId = {}
      this.indexingStatusByDocumentId = {}
    }
  }
})
