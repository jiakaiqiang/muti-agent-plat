import { defineStore } from 'pinia'
import { mockDocumentsByKnowledgeBaseId, mockKnowledgeBases } from '@/mock/mockEvents'
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
    loadKnowledgeBases() {
      this.knowledgeBases = mockKnowledgeBases
      this.documentsByKnowledgeBaseId = mockDocumentsByKnowledgeBaseId
      this.indexingStatusByDocumentId = Object.values(mockDocumentsByKnowledgeBaseId)
        .flat()
        .reduce<Record<string, string>>((acc, document) => {
          acc[document.id] = document.status
          return acc
        }, {})
    }
  }
})
