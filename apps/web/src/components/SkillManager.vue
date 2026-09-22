<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import {
  useSkillStore,
  type SkillFormField as FormField,
  type SkillFormState,
  type SkillInput
} from '@/stores/skill'
import type { Skill } from '@/types/contracts'
import UiIcon from './UiIcon.vue'

const skillStore = useSkillStore()
const { selectedSkillId, formMode, form, fieldErrors, operationError, pendingDeleteSkillId } = storeToRefs(skillStore)
const nameInput = ref<HTMLInputElement | null>(null)

const selectedSkill = computed(() => skillStore.skills.find((skill) => skill.id === selectedSkillId.value))
const pendingDeleteSkill = computed(() => skillStore.skills.find((skill) => skill.id === pendingDeleteSkillId.value))
const canSave = computed(() => !skillStore.saving)

function emptyForm(): SkillFormState {
  return { name: '', description: '', content: '', files: [] }
}

function formFromSkill(skill: Skill): SkillFormState {
  return {
    name: skill.name,
    description: skill.description ?? '',
    content: skill.content,
    files: skill.files.map((file) => ({ ...file }))
  }
}

function resetErrors() {
  fieldErrors.value = {}
  operationError.value = ''
}

function selectSkill(skillId: string) {
  selectedSkillId.value = skillId
  resetErrors()
  if (formMode.value === 'edit') formMode.value = undefined
}

function startCreate() {
  formMode.value = 'create'
  form.value = emptyForm()
  selectedSkillId.value = ''
  resetErrors()
  void nextTick(() => nameInput.value?.focus())
}

function startEdit() {
  if (!selectedSkill.value) return
  formMode.value = 'edit'
  form.value = formFromSkill(selectedSkill.value)
  resetErrors()
  void nextTick(() => nameInput.value?.focus())
}

function cancelForm() {
  formMode.value = undefined
  form.value = emptyForm()
  resetErrors()
}

function addFile() {
  form.value.files.push({ path: '', content: '' })
}

function removeFile(index: number) {
  form.value.files.splice(index, 1)
  delete fieldErrors.value.files
}

function normalizePath(path: string) {
  return path.trim().replace(/\\/g, '/')
}

function setFieldError(field: FormField, message: string) {
  fieldErrors.value = { ...fieldErrors.value, [field]: message }
}

function buildInput(): SkillInput | undefined {
  resetErrors()
  const name = form.value.name.trim()
  const description = form.value.description.trim()
  const content = form.value.content.trim()

  if (!name) setFieldError('name', '请填写 Skill 名称')
  else if (name.length > 100) setFieldError('name', '名称不能超过 100 个字符')
  else if (
    skillStore.skills.some(
      (skill) => skill.id !== selectedSkill.value?.id && skill.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0
    )
  ) {
    setFieldError('name', '名称已存在，请使用另一个名称')
  }

  if (description.length > 500) setFieldError('description', '描述不能超过 500 个字符')
  if (!content) setFieldError('content', '请填写 Skill 内容')
  else if (content.length > 100_000) setFieldError('content', '内容不能超过 100,000 个字符')

  if (form.value.files.length > 20) {
    setFieldError('files', '最多可以添加 20 个文件')
  }

  const paths = new Set<string>()
  let fileContentLength = 0
  const files = form.value.files.map((file, index) => {
    const path = normalizePath(file.path)
    const segments = path.split('/')
    if (!path || path.startsWith('/') || /^[a-zA-Z]:\//.test(path) || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      setFieldError('files', `第 ${index + 1} 个文件的路径必须是安全的相对路径`)
    } else if (paths.has(path)) {
      setFieldError('files', `文件路径重复：${path}`)
    }
    paths.add(path)
    if (file.content.length > 100_000) {
      setFieldError('files', `文件 ${path || index + 1} 不能超过 100,000 个字符`)
    }
    fileContentLength += file.content.length
    return { path, content: file.content }
  })

  if (fileContentLength > 500_000) setFieldError('files', '所有文件内容合计不能超过 500,000 个字符')
  if (Object.keys(fieldErrors.value).length > 0) return undefined

  return {
    name,
    description: description || undefined,
    content,
    files
  }
}

function applyServerError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback
  operationError.value = message
  if (/name|名称|duplicate/i.test(message)) setFieldError('name', message)
  else if (/description|描述/i.test(message)) setFieldError('description', message)
  else if (/content|内容/i.test(message)) setFieldError('content', message)
  else if (/file|文件|path|路径/i.test(message)) setFieldError('files', message)
}

async function saveSkill() {
  const input = buildInput()
  if (!input) return

  try {
    const skill =
      formMode.value === 'edit' && selectedSkill.value
        ? await skillStore.updateSkill(selectedSkill.value.id, input)
        : await skillStore.createSkill(input)
    selectedSkillId.value = skill.id
    formMode.value = undefined
    form.value = emptyForm()
    resetErrors()
  } catch (error) {
    applyServerError(error, '保存 Skill 失败')
  }
}

function requestDelete() {
  if (selectedSkill.value) pendingDeleteSkillId.value = selectedSkill.value.id
}

function cancelDelete() {
  pendingDeleteSkillId.value = ''
}

async function removeSkill() {
  const skill = pendingDeleteSkill.value
  if (!skill) return
  resetErrors()
  try {
    await skillStore.removeSkill(skill.id)
    selectedSkillId.value = skillStore.skills[0]?.id ?? ''
    pendingDeleteSkillId.value = ''
  } catch (error) {
    operationError.value = error instanceof Error ? error.message : '删除 Skill 失败'
  }
}

async function refreshData() {
  resetErrors()
  try {
    await skillStore.loadSkills()
    if (!skillStore.skills.some((skill) => skill.id === selectedSkillId.value)) {
      selectedSkillId.value = skillStore.skills[0]?.id ?? ''
    }
  } catch (error) {
    operationError.value = error instanceof Error ? error.message : '刷新 Skill 数据失败'
  }
}

function contentSummary(skill: Skill) {
  const fileLabel = skill.files.length === 1 ? '1 个文件' : `${skill.files.length} 个文件`
  return `${scopeLabel(skill)} · ${skill.content.length.toLocaleString()} 字符 · ${fileLabel}`
}

function scopeLabel(skill: Skill) {
  if (skill.scope === 'personal') return '个人'
  if (skill.scope === 'group') return `群聊${skill.scopeId ? ` · ${skill.scopeId}` : ''}`
  return '系统'
}

onMounted(() => void refreshData())
</script>

<template>
  <div class="skill-manager">
    <article class="admin-card skill-manager-toolbar">
      <div>
        <strong>Skill 管理</strong>
        <p>维护可复用工作规则；Agent 通过 Profile Markdown 中的稳定 key 引用 Skill。</p>
      </div>
      <dl>
        <div>
          <dt>Skill</dt>
          <dd>{{ skillStore.skills.length }}</dd>
        </div>
        <div>
          <dt>启用中</dt>
          <dd>{{ skillStore.skills.filter((skill) => skill.status === 'active').length }}</dd>
        </div>
      </dl>
      <div class="skill-toolbar-actions">
        <button type="button" :disabled="skillStore.loading" @click="refreshData()">刷新</button>
        <button data-testid="skill-create" type="button" class="primary" @click="startCreate">
          <UiIcon name="plus" :size="16" />
          新建 Skill
        </button>
      </div>
    </article>

    <p v-if="operationError && !formMode" class="skill-operation-error" role="alert">{{ operationError }}</p>

    <div class="skill-management-layout">
      <aside class="admin-card skill-list-panel" aria-label="Skill 列表">
        <header>
          <strong>Skill 列表</strong>
          <span>{{ skillStore.loading ? '加载中' : `${skillStore.skills.length} 项` }}</span>
        </header>
        <div v-if="skillStore.skills.length" class="skill-list">
          <button
            v-for="skill in skillStore.skills"
            :key="skill.id"
            type="button"
            :class="['skill-list-item', { active: selectedSkillId === skill.id }]"
            :data-testid="`skill-list-item-${skill.id}`"
            @click="selectSkill(skill.id)"
          >
            <strong>{{ skill.name }}</strong>
            <span>{{ contentSummary(skill) }}</span>
          </button>
        </div>
        <p v-else-if="!skillStore.loading" class="admin-empty">暂无 Skill。新建后可在 Agent Profile 中插入稳定引用。</p>
      </aside>

      <section class="skill-detail-panel" aria-live="polite">
        <form v-if="formMode" class="admin-card skill-form" @submit.prevent="saveSkill">
          <header>
            <div>
              <strong>{{ formMode === 'edit' ? '编辑 Skill' : '新建 Skill' }}</strong>
              <p>内容会在 Agent Profile 编译时展开；仅在必要时添加文件附件。</p>
            </div>
            <button type="button" @click="cancelForm">
              <UiIcon name="x" :size="16" />
              取消
            </button>
          </header>

          <label :class="{ invalid: fieldErrors.name }">
            <span>名称</span>
            <input ref="nameInput" v-model="form.name" data-testid="skill-name" maxlength="100" autocomplete="off" placeholder="例如 Contract Review" />
            <small>最多 100 个字符，名称不区分大小写且必须唯一。</small>
            <em v-if="fieldErrors.name" class="skill-field-error">{{ fieldErrors.name }}</em>
          </label>

          <label :class="{ invalid: fieldErrors.description }">
            <span>描述</span>
            <input v-model="form.description" data-testid="skill-description" maxlength="500" placeholder="说明该 Skill 的适用范围" />
            <small>可选，最多 500 个字符。</small>
            <em v-if="fieldErrors.description" class="skill-field-error">{{ fieldErrors.description }}</em>
          </label>

          <label class="span-2" :class="{ invalid: fieldErrors.content }">
            <span>工作规则</span>
            <textarea v-model="form.content" data-testid="skill-content" rows="9" maxlength="100000" placeholder="输入将注入 Agent 上下文的工作规则…" />
            <small>最多 100,000 个字符。请勿放入密钥或不应被运行时读取的敏感信息。</small>
            <em v-if="fieldErrors.content" class="skill-field-error">{{ fieldErrors.content }}</em>
          </label>

          <div class="skill-files-editor span-2" :class="{ invalid: fieldErrors.files }">
            <header>
              <div>
                <span>附加文件</span>
                <small>仅支持安全相对路径；最多 20 个，单文件 100,000 字符、总计 500,000 字符。</small>
              </div>
              <button data-testid="skill-add-file" type="button" :disabled="form.files.length >= 20" @click="addFile">
                <UiIcon name="plus" :size="15" />
                添加文件
              </button>
            </header>
            <div v-for="(file, index) in form.files" :key="index" class="skill-file-editor">
              <label>
                <span>相对路径</span>
                <input v-model="file.path" :data-testid="`skill-file-path-${index}`" placeholder="guides/checklist.md" />
              </label>
              <label>
                <span>文件内容</span>
                <textarea v-model="file.content" :data-testid="`skill-file-content-${index}`" rows="3" />
              </label>
              <button type="button" :aria-label="`删除文件 ${index + 1}`" @click="removeFile(index)">
                <UiIcon name="trash" :size="16" />
              </button>
            </div>
            <p v-if="!form.files.length" class="skill-file-empty">未添加附加文件。</p>
            <em v-if="fieldErrors.files" class="skill-field-error">{{ fieldErrors.files }}</em>
          </div>

          <p v-if="operationError" class="skill-operation-error span-2" role="alert">{{ operationError }}</p>
          <footer class="form-actions span-2">
            <button type="button" @click="cancelForm">取消</button>
            <button data-testid="skill-save" type="submit" class="primary" :disabled="!canSave">
              {{ skillStore.saving ? '保存中' : formMode === 'edit' ? '保存 Skill' : '创建 Skill' }}
            </button>
          </footer>
        </form>

        <article v-else-if="selectedSkill" class="admin-card skill-detail-card">
          <header>
            <div>
              <strong>{{ selectedSkill.name }}</strong>
              <p>{{ selectedSkill.description || '暂无描述' }}</p>
            </div>
            <span>{{ contentSummary(selectedSkill) }}</span>
          </header>
          <dl>
            <div>
              <dt>来源层级</dt>
              <dd>{{ scopeLabel(selectedSkill) }}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>{{ selectedSkill.status === 'active' ? '启用' : '停用' }}</dd>
            </div>
            <div>
              <dt>稳定引用</dt>
              <dd><code>${skill:{{ selectedSkill.key }}}</code></dd>
            </div>
            <div>
              <dt>修订版本</dt>
              <dd>v{{ selectedSkill.revision }}</dd>
            </div>
            <div>
              <dt>最后更新</dt>
              <dd>{{ selectedSkill.updatedAt }}</dd>
            </div>
          </dl>
          <div class="skill-file-summary">
            <span>附加文件</span>
            <p v-if="selectedSkill.files.length">{{ selectedSkill.files.map((file) => file.path).join('、') }}</p>
            <p v-else>无附加文件</p>
          </div>
          <p class="skill-content-notice">为避免在管理页暴露不必要内容，此处只显示长度和文件摘要；编辑时才展示完整工作规则。</p>
          <footer class="skill-detail-actions">
            <button type="button" @click="startEdit">
              <UiIcon name="settings" :size="16" />
              编辑
            </button>
            <button :data-testid="`skill-delete-${selectedSkill.id}`" type="button" class="danger" @click="requestDelete">
              <UiIcon name="trash" :size="16" />
              删除
            </button>
          </footer>
        </article>

        <p v-else class="admin-empty">从左侧选择一个 Skill，或新建一个可复用的工作规则。</p>
      </section>
    </div>

    <div v-if="pendingDeleteSkill" class="skill-delete-backdrop" role="presentation">
      <section class="admin-card skill-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-delete-title">
        <header>
          <div>
            <strong id="skill-delete-title">删除 {{ pendingDeleteSkill.name }}？</strong>
            <p>删除后无法恢复。仍被 Agent Profile 引用时，服务端会拒绝删除。</p>
          </div>
        </header>
        <div class="skill-delete-impact">
          <span>删除前检查</span>
          <p>请先从所有 Agent Profile 中移除 <code>${skill:{{ pendingDeleteSkill.key }}}</code>。</p>
        </div>
        <footer class="form-actions">
          <button type="button" @click="cancelDelete">取消</button>
          <button data-testid="skill-confirm-delete" type="button" class="danger" :disabled="skillStore.saving" @click="removeSkill">
            {{ skillStore.saving ? '删除中' : '确认删除' }}
          </button>
        </footer>
      </section>
    </div>
  </div>
</template>
