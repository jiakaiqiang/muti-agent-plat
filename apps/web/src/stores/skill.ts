import { defineStore } from 'pinia'
import { apiDelete, apiGet, apiPatch, apiPost } from '@/api/client'
import type { Skill, SkillFile } from '@/types/contracts'

export type SkillInput = {
  name: string
  description?: string
  content: string
  files?: SkillFile[]
}

export type SkillRemovalResult = {
  skill: Skill
  removed: boolean
}

export type SkillFormField = 'name' | 'description' | 'content' | 'files'

export type SkillFormState = {
  name: string
  description: string
  content: string
  files: SkillFile[]
}

function emptySkillForm(): SkillFormState {
  return { name: '', description: '', content: '', files: [] }
}

export function sortSkills(skills: Skill[]) {
  return [...skills].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

export const useSkillStore = defineStore('skill', {
  state: () => ({
    skills: [] as Skill[],
    loading: false,
    saving: false,
    error: '',
    selectedSkillId: '',
    formMode: undefined as 'create' | 'edit' | undefined,
    form: emptySkillForm(),
    fieldErrors: {} as Partial<Record<SkillFormField, string>>,
    operationError: '',
    pendingDeleteSkillId: ''
  }),
  actions: {
    async loadSkills() {
      this.loading = true
      this.error = ''
      try {
        this.skills = sortSkills(await apiGet<Skill[]>('/skills'))
        return this.skills
      } catch (error) {
        this.error = error instanceof Error ? error.message : '加载 Skill 列表失败'
        throw error
      } finally {
        this.loading = false
      }
    },
    async createSkill(input: SkillInput) {
      this.saving = true
      this.error = ''
      try {
        const skill = await apiPost<Skill>('/skills', input)
        this.skills = sortSkills([...this.skills.filter((item) => item.id !== skill.id), skill])
        return skill
      } catch (error) {
        this.error = error instanceof Error ? error.message : '创建 Skill 失败'
        throw error
      } finally {
        this.saving = false
      }
    },
    async updateSkill(skillId: string, input: Partial<SkillInput>) {
      this.saving = true
      this.error = ''
      try {
        const skill = await apiPatch<Skill>(`/skills/${skillId}`, input)
        this.skills = sortSkills(this.skills.map((item) => (item.id === skill.id ? skill : item)))
        return skill
      } catch (error) {
        this.error = error instanceof Error ? error.message : '保存 Skill 失败'
        throw error
      } finally {
        this.saving = false
      }
    },
    async removeSkill(skillId: string) {
      this.saving = true
      this.error = ''
      try {
        const result = await apiDelete<SkillRemovalResult>(`/skills/${skillId}`)
        this.skills = this.skills.filter((item) => item.id !== skillId)
        return result
      } catch (error) {
        this.error = error instanceof Error ? error.message : '删除 Skill 失败'
        throw error
      } finally {
        this.saving = false
      }
    }
  }
})
