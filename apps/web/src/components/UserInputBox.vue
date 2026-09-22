<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type {
  GroupChatAgentRef,
  GroupChatAttachmentRef,
  GroupChatMessageContext,
  GroupChatMessageDraft,
  GroupChatSkillRef
} from '@agent-cluster/shared'
import { normalizeGroupChatMessageDraft } from '@agent-cluster/shared'
import type { AgentDefinition, Skill, SkillCategory } from '@/types/contracts'
import { useWorkspaceUiStore } from '@/stores/workspaceUi'
import { useSessionStore } from '@/stores/session'
import { useEventStore } from '@/stores/event'
import { useSkillStore } from '@/stores/skill'
import { useAgentStore } from '@/stores/agent'
import { taskActivity } from '@/utils/taskActivity'
import { apiPost } from '@/api/client'
import UiIcon from './UiIcon.vue'

export type ComposerAttachment = GroupChatAttachmentRef & {
  /** Local-only preview data; GC-03 replaces this with the upload result. */
  previewUrl?: string
  sourceFile?: File
}

const props = withDefaults(
  defineProps<{
    disabled?: boolean
    busy?: boolean
    placeholder?: string
    error?: string
    canStop?: boolean
    canResume?: boolean
    controlBusy?: boolean
    controlError?: string
    sessionId?: string
    attachments?: ComposerAttachment[]
    skill?: GroupChatSkillRef
    agents?: GroupChatAgentRef[]
    memberAgentIds?: string[]
  }>(),
  {
    disabled: false,
    busy: false,
    placeholder: '输入消息...（支持 /Skill、@Agent、上传图片或文件）',
    attachments: () => [],
    agents: () => []
  }
)

const emit = defineEmits<{
  send: [content: string, context: GroupChatMessageContext]
  'send-context': [context: GroupChatMessageContext]
  stop: []
  resume: []
  'context-change': [draft: GroupChatMessageDraft]
  'remove-attachment': [attachmentId: string]
  'remove-skill': []
  'remove-agent': [agentId: string]
  'select-skill-blocked': []
  'agent-join-confirmed': [agent: GroupChatAgentRef]
  'agent-join-cancelled': [agent: GroupChatAgentRef]
}>()

const workspaceUiStore = useWorkspaceUiStore()
const sessionStore = useSessionStore()
const eventStore = useEventStore()
const skillStore = useSkillStore()
const agentStore = useAgentStore()
const now = ref(Date.now())
const composerError = ref('')
const textareaId = 'group-chat-message-input'
let activityTimer: ReturnType<typeof setInterval> | undefined

const localAttachments = ref<ComposerAttachment[]>([...props.attachments])
const localSkill = ref<GroupChatSkillRef | undefined>(props.skill)
const localAgents = ref<GroupChatAgentRef[]>([...props.agents])
const pickerSkills = ref<Skill[]>([])
const pickerCategories = ref<SkillCategory[]>([])
const skillPickerOpen = ref(false)
const skillPickerLoading = ref(false)
const skillPickerError = ref('')
const skillPickerIndex = ref(0)
const skillPickerTriggerIndex = ref<number | null>(null)
let skillPickerLoadToken = 0
const pickerAgents = ref<AgentDefinition[]>([])
const agentPickerOpen = ref(false)
const agentPickerLoading = ref(false)
const agentPickerError = ref('')
const agentPickerIndex = ref(0)
const agentPickerTriggerIndex = ref<number | null>(null)
const pendingAgentJoin = ref<GroupChatAgentRef>()
const pendingAgentJoinTriggerIndex = ref<number | null>(null)
let agentPickerLoadToken = 0

watch(() => props.attachments, value => { localAttachments.value = [...value] }, { deep: true })
watch(() => props.skill, value => { localSkill.value = value }, { deep: true })
watch(() => props.agents, value => { localAgents.value = [...value] }, { deep: true })

onMounted(() => { activityTimer = setInterval(() => { now.value = Date.now() }, 5000) })
onBeforeUnmount(() => {
  clearInterval(activityTimer)
  for (const attachment of localAttachments.value) revokePreviewUrl(attachment.previewUrl)
})

const activity = computed(() => taskActivity({
  session: sessionStore.currentSession,
  events: sessionStore.currentSession ? eventStore.eventsForSession(sessionStore.currentSession.id) : [],
  connectedSessionId: eventStore.connectedSessionId,
  connectionState: eventStore.sseConnectionState,
  unavailable: props.disabled,
  now: now.value
}))
const { messageDraft: draft } = storeToRefs(workspaceUiStore)
const unresolvedAgentMention = computed(() => draft.value.includes('@'))
const visibleError = computed(() => {
  if (props.controlError || props.error) return props.controlError || props.error
  if (unresolvedAgentMention.value) return '请从 @Agent 列表中选择 Agent，未完成选择不能发送。'
  return composerError.value
})
const activeAttachments = computed(() => localAttachments.value.filter(item => item.uploadStatus !== 'deleted'))
const sendableAttachments = computed(() => activeAttachments.value.filter(item => item.uploadStatus !== 'failed'))
function toAttachmentRef({ previewUrl: _previewUrl, sourceFile: _sourceFile, ...reference }: ComposerAttachment): GroupChatAttachmentRef {
  return reference
}
const composerDraft = computed<GroupChatMessageDraft>(() => ({
  text: draft.value,
  skills: localSkill.value ? [localSkill.value] : [],
  agents: [...localAgents.value],
  attachments: sendableAttachments.value.map(toAttachmentRef)
}))
const hasComposerPayload = computed(() => Boolean(
  draft.value.trim() || activeAttachments.value.length || localSkill.value || localAgents.value.length
))
const action = computed(() => props.canStop || (props.busy && !props.canResume)
  ? 'stop' : props.canResume && !hasComposerPayload.value ? 'resume' : 'send')
const canSend = computed(() => action.value === 'send' && hasComposerPayload.value && !unresolvedAgentMention.value && !props.disabled && !props.busy && !props.controlBusy)
const actionLabel = computed(() => action.value === 'stop' ? '停止当前会话' : action.value === 'resume' ? '继续当前会话' : '发送')
const actionDisabled = computed(() => action.value === 'send' ? !canSend.value : props.controlBusy || props.disabled)
const actionPendingLabel = computed(() => action.value === 'stop' ? '正在停止当前会话' : '正在继续当前会话')

const groupedAvailableSkills = computed(() => {
  const categoryMap = new Map(pickerCategories.value.map(category => [category.id, category]))
  const groups = new Map<string, { id: string; name: string; skills: Skill[] }>()
  for (const skill of pickerSkills.value.filter(item => item.status === 'active')) {
    const category = skill.categoryId ? categoryMap.get(skill.categoryId) : undefined
    const id = category?.id ?? skill.categoryId ?? '__uncategorized__'
    const name = category?.name ?? (skill.categoryId ? `分类 ${skill.categoryId}` : '未分类')
    const group = groups.get(id) ?? { id, name, skills: [] }
    group.skills.push(skill)
    groups.set(id, group)
  }
  return [...groups.values()]
    .map(group => ({ ...group, skills: [...group.skills].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)) }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
})
const skillPickerOptions = computed(() => groupedAvailableSkills.value.flatMap(group => group.skills))
const memberAgentIds = computed(() => new Set(
  props.memberAgentIds ?? sessionStore.currentSession?.participatingAgentIds ?? []
))
const agentPickerQuery = computed(() => {
  const triggerIndex = agentPickerTriggerIndex.value
  return agentPickerOpen.value && triggerIndex !== null ? draft.value.slice(triggerIndex + 1) : ''
})
const filteredPickerAgents = computed(() => {
  const query = agentPickerQuery.value.trim().toLocaleLowerCase()
  return pickerAgents.value
    .filter(agent => agent.status === 'active')
    .filter(agent => agent.management?.allowedSurfaces.includes('mention') ?? true)
    .filter(agent => agent.key !== 'coordinator' && agent.management?.systemRole !== 'coordinator')
    .filter(agent => {
      if (!query) return true
      return [agent.name, agent.key, agent.description, agent.role, ...agent.tags]
        .filter(Boolean)
        .some(value => value!.toLocaleLowerCase().includes(query))
    })
    .filter(agent => !localAgents.value.some(selected => selected.id === agent.id))
})
const groupedPickerAgents = computed(() => {
  const groups = new Map<string, { id: string; name: string; agents: AgentDefinition[] }>()
  for (const agent of filteredPickerAgents.value) {
    const name = agent.tags[0] || agent.role || '未分类'
    const id = `${name}`
    const group = groups.get(id) ?? { id, name, agents: [] }
    group.agents.push(agent)
    groups.set(id, group)
  }
  return [...groups.values()]
    .map(group => ({ ...group, agents: [...group.agents].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)) }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
})
const agentPickerOptions = computed(() => groupedPickerAgents.value.flatMap(group => group.agents))

function emitContextChange() {
  emit('context-change', {
    text: draft.value,
    skills: localSkill.value ? [localSkill.value] : [],
    agents: [...localAgents.value],
    attachments: activeAttachments.value.map(toAttachmentRef)
  })
}

function createDraftAttachmentId() {
  return globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function addAttachment(attachment: ComposerAttachment) {
  const count = localAttachments.value.filter(item => item.kind === attachment.kind && item.uploadStatus !== 'deleted').length
  if (attachment.kind === 'image' && count >= 4) {
    composerError.value = '一条消息最多上传 4 张图片。'
    return false
  }
  if (attachment.kind === 'file' && count >= 4) {
    composerError.value = '一条消息最多上传 4 个文件。'
    return false
  }
  if (activeAttachments.value.length >= 8) {
    composerError.value = '一条消息最多包含 8 个附件。'
    return false
  }
  localAttachments.value = [...localAttachments.value, attachment]
  composerError.value = ''
  emitContextChange()
  return true
}

function removeAttachment(attachmentId: string) {
  const removed = localAttachments.value.find(item => item.id === attachmentId)
  if (!removed) return
  revokePreviewUrl(removed.previewUrl)
  localAttachments.value = localAttachments.value.filter(item => item.id !== attachmentId)
  emit('remove-attachment', attachmentId)
  emitContextChange()
}

function recognitionLabel(attachment: ComposerAttachment) {
  if (attachment.kind !== 'image') return ''
  if (attachment.recognitionStatus === 'processing') return '识别中'
  if (attachment.recognitionStatus === 'ready') return '已识别'
  if (attachment.recognitionStatus === 'failed') return '识别失败'
  return '待识别'
}

async function retryRecognition(attachment: ComposerAttachment) {
  if (attachment.kind !== 'image' || attachment.recognitionStatus !== 'failed' || !props.sessionId) return
  localAttachments.value = localAttachments.value.map(item => item.id === attachment.id
    ? { ...item, recognitionStatus: 'processing' }
    : item)
  composerError.value = ''
  try {
    const updated = await apiPost<GroupChatAttachmentRef>(`/sessions/${encodeURIComponent(props.sessionId)}/attachments/${encodeURIComponent(attachment.id)}/recognition/retry`)
    localAttachments.value = localAttachments.value.map(item => item.id === updated.id
      ? { ...item, ...updated }
      : item)
    emitContextChange()
  } catch (error) {
    localAttachments.value = localAttachments.value.map(item => item.id === attachment.id
      ? { ...item, recognitionStatus: 'failed' }
      : item)
    composerError.value = error instanceof Error ? error.message : '图片识别重试失败，请稍后再试。'
  }
}

function selectSkill(skill: GroupChatSkillRef) {
  if (localSkill.value) {
    composerError.value = '一条消息只能选择一个 Skill；请先删除当前 Skill，或使用替换操作。'
    emit('select-skill-blocked')
    return false
  }
  localSkill.value = skill
  composerError.value = ''
  emitContextChange()
  return true
}

function replaceSkill(skill: GroupChatSkillRef) {
  localSkill.value = skill
  composerError.value = ''
  emitContextChange()
}

function removeSkill() {
  localSkill.value = undefined
  emit('remove-skill')
  emitContextChange()
}

function closeSkillPicker() {
  skillPickerOpen.value = false
  skillPickerLoading.value = false
  skillPickerError.value = ''
  skillPickerIndex.value = 0
  skillPickerTriggerIndex.value = null
}

function closeAgentPicker() {
  agentPickerOpen.value = false
  agentPickerLoading.value = false
  agentPickerError.value = ''
  agentPickerIndex.value = 0
  agentPickerTriggerIndex.value = null
}

async function openSkillPicker() {
  if (props.disabled || props.busy) return
  const triggerIndex = draft.value.endsWith('/') ? draft.value.length - 1 : -1
  if (triggerIndex < 0) return
  skillPickerTriggerIndex.value = triggerIndex
  skillPickerOpen.value = true
  skillPickerLoading.value = true
  skillPickerError.value = ''
  skillPickerIndex.value = 0
  const loadToken = ++skillPickerLoadToken
  try {
    const [skills, categories] = await Promise.all([
      skillStore.loadAvailableSkills(),
      skillStore.loadAvailableCategories()
    ])
    if (loadToken !== skillPickerLoadToken) return
    pickerSkills.value = skills
    pickerCategories.value = categories
  } catch (error) {
    if (loadToken !== skillPickerLoadToken) return
    skillPickerError.value = error instanceof Error ? error.message : '加载可用 Skill 失败'
  } finally {
    if (loadToken === skillPickerLoadToken) skillPickerLoading.value = false
  }
}

async function openAgentPicker() {
  if (props.disabled || props.busy) return
  const triggerIndex = draft.value.lastIndexOf('@')
  if (triggerIndex < 0 || (triggerIndex > 0 && !/\s/.test(draft.value[triggerIndex - 1]))) return
  agentPickerTriggerIndex.value = triggerIndex
  agentPickerOpen.value = true
  closeSkillPicker()
  agentPickerLoading.value = true
  agentPickerError.value = ''
  agentPickerIndex.value = 0
  const loadToken = ++agentPickerLoadToken
  try {
    const agents = await agentStore.loadAgentsForSurface('mention')
    if (loadToken !== agentPickerLoadToken) return
    pickerAgents.value = agents
  } catch (error) {
    if (loadToken !== agentPickerLoadToken) return
    agentPickerError.value = error instanceof Error ? error.message : '加载可用 Agent 失败'
  } finally {
    if (loadToken === agentPickerLoadToken) agentPickerLoading.value = false
  }
}

function skillRefFromRecord(skill: Skill): GroupChatSkillRef {
  return {
    id: skill.id,
    key: skill.key,
    name: skill.name,
    revision: skill.revision,
    scope: skill.scope,
    scopeId: skill.scopeId,
    categoryId: skill.categoryId,
    status: skill.status
  }
}

function selectSkillFromPicker(skill: Skill) {
  const triggerIndex = skillPickerTriggerIndex.value
  if (triggerIndex !== null) draft.value = draft.value.slice(0, triggerIndex)
  const accepted = selectSkill(skillRefFromRecord(skill))
  closeSkillPicker()
  return accepted
}

function moveSkillPicker(delta: number) {
  const count = skillPickerOptions.value.length
  if (!count) return
  skillPickerIndex.value = (skillPickerIndex.value + delta + count) % count
}

function moveAgentPicker(delta: number) {
  const count = agentPickerOptions.value.length
  if (!count) return
  agentPickerIndex.value = (agentPickerIndex.value + delta + count) % count
}

function selectAgent(agent: GroupChatAgentRef) {
  if (localAgents.value.some(item => item.id === agent.id)) return false
  localAgents.value = [...localAgents.value, agent]
  composerError.value = ''
  emitContextChange()
  return true
}

function agentRefFromRecord(agent: AgentDefinition): GroupChatAgentRef {
  return { id: agent.id, key: agent.key, name: agent.name }
}

function selectAgentFromPicker(agent: AgentDefinition) {
  const reference = agentRefFromRecord(agent)
  const triggerIndex = agentPickerTriggerIndex.value
  closeAgentPicker()
  if (memberAgentIds.value.has(agent.id)) {
    if (triggerIndex !== null) draft.value = draft.value.slice(0, triggerIndex)
    selectAgent(reference)
    return true
  }
  pendingAgentJoin.value = reference
  pendingAgentJoinTriggerIndex.value = triggerIndex
  return false
}

function confirmAgentJoin() {
  const reference = pendingAgentJoin.value
  if (!reference) return false
  const triggerIndex = pendingAgentJoinTriggerIndex.value
  if (triggerIndex !== null) draft.value = draft.value.slice(0, triggerIndex)
  const accepted = selectAgent(reference)
  if (accepted) emit('agent-join-confirmed', reference)
  pendingAgentJoin.value = undefined
  pendingAgentJoinTriggerIndex.value = null
  return accepted
}

function cancelAgentJoin() {
  const reference = pendingAgentJoin.value
  if (reference) emit('agent-join-cancelled', reference)
  pendingAgentJoin.value = undefined
  pendingAgentJoinTriggerIndex.value = null
}

function removeAgent(agentId: string) {
  localAgents.value = localAgents.value.filter(item => item.id !== agentId)
  emit('remove-agent', agentId)
  emitContextChange()
}

function clearComposerState() {
  for (const attachment of localAttachments.value) revokePreviewUrl(attachment.previewUrl)
  localAttachments.value = []
  localSkill.value = undefined
  localAgents.value = []
  draft.value = ''
  composerError.value = ''
  emitContextChange()
}

function activateAction() {
  if (actionDisabled.value) return
  if (action.value === 'stop') emit('stop')
  else if (action.value === 'resume') emit('resume')
  else submit()
}

function submit() {
  if (!hasComposerPayload.value || !canSend.value) return
  const normalized = normalizeGroupChatMessageDraft(composerDraft.value)
  if (!normalized.ok) {
    composerError.value = normalized.errors.map(error => error.message).join(' ')
    return
  }
  emit('send', normalized.value.text, normalized.value)
  emit('send-context', normalized.value)
  clearComposerState()
}

function handleKeydown(event: KeyboardEvent) {
  if (agentPickerOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeAgentPicker()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveAgentPicker(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveAgentPicker(-1)
      return
    }
    if (event.key === 'Enter' && agentPickerOptions.value[agentPickerIndex.value]) {
      event.preventDefault()
      selectAgentFromPicker(agentPickerOptions.value[agentPickerIndex.value])
      return
    }
  }
  if (skillPickerOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSkillPicker()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSkillPicker(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSkillPicker(-1)
      return
    }
    if (event.key === 'Enter' && skillPickerOptions.value[skillPickerIndex.value]) {
      event.preventDefault()
      selectSkillFromPicker(skillPickerOptions.value[skillPickerIndex.value])
      return
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    submit()
  }
}

watch(draft, value => {
  const beforeTrigger = value.slice(0, -1)
  const isSlashTrigger = value.endsWith('/') && !beforeTrigger.includes('/') && (value.length === 1 || /\s$/.test(beforeTrigger))
  if (isSlashTrigger) {
    if (!skillPickerOpen.value) void openSkillPicker()
  } else if (skillPickerOpen.value) {
    closeSkillPicker()
  }
}, { immediate: true })

watch(draft, value => {
  if (pendingAgentJoin.value) return
  const triggerIndex = value.lastIndexOf('@')
  const isMentionTrigger = triggerIndex >= 0 && (triggerIndex === 0 || /\s/.test(value[triggerIndex - 1])) && !value.slice(triggerIndex + 1).includes('\n')
  if (isMentionTrigger) {
    if (!agentPickerOpen.value) void openAgentPicker()
  } else if (agentPickerOpen.value) {
    closeAgentPicker()
  }
}, { immediate: true })

function revokePreviewUrl(previewUrl?: string) {
  if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
}

defineExpose({
  addAttachment,
  addDraftFile(file: File, kind: GroupChatAttachmentRef['kind']) {
    const previewUrl = kind === 'image' ? URL.createObjectURL(file) : undefined
    const accepted = addAttachment({
      id: createDraftAttachmentId(),
      sessionId: props.sessionId ?? 'draft',
      kind,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      uploadStatus: 'uploading',
      recognitionStatus: kind === 'image' ? 'not_started' : undefined,
      createdAt: new Date().toISOString(),
      previewUrl,
      sourceFile: file
    })
    if (!accepted) revokePreviewUrl(previewUrl)
    return accepted
  },
  selectSkill,
  openSkillPicker,
  closeSkillPicker,
  selectSkillFromPicker,
  openAgentPicker,
  closeAgentPicker,
  selectAgentFromPicker,
  confirmAgentJoin,
  cancelAgentJoin,
  replaceSkill,
  removeSkill,
  selectAgent,
  removeAgent,
  removeAttachment,
  retryRecognition,
  clearComposerState
})
</script>

<template>
  <footer class="user-input-box" :class="{ 'has-task-activity': activity }" aria-label="User input">
    <p v-if="activity" class="task-activity" :class="`is-${activity.tone}`" role="status" aria-live="polite" aria-atomic="true">
      <span class="task-activity__dot" aria-hidden="true"></span>{{ activity.text }}
    </p>
    <div class="input-tools" aria-hidden="true">
      <span class="tool-dot"><UiIcon name="paperclip" :size="18" /></span>
      <span class="tool-dot"><UiIcon name="image" :size="18" /></span>
      <span class="tool-dot"><UiIcon name="code" :size="18" /></span>
      <span class="tool-dot"><UiIcon name="at" :size="18" /></span>
    </div>
    <div v-if="activeAttachments.length || localSkill || localAgents.length" class="composer-tags" aria-label="已选择的上下文">
      <div v-if="activeAttachments.length" class="composer-attachments" aria-label="已选择的附件">
        <div v-for="attachment in activeAttachments" :key="attachment.id" class="composer-attachment" :class="`is-${attachment.kind}`">
          <img v-if="attachment.kind === 'image' && attachment.previewUrl" class="composer-attachment__thumbnail" :src="attachment.previewUrl" :alt="attachment.fileName" />
          <span v-else class="composer-attachment__icon" aria-hidden="true"><UiIcon :name="attachment.kind === 'image' ? 'image' : 'paperclip'" :size="16" /></span>
          <span class="composer-attachment__name" :title="attachment.fileName">{{ attachment.fileName }}</span>
          <span v-if="attachment.kind === 'image'" class="composer-attachment__recognition" :class="`is-${attachment.recognitionStatus ?? 'not_started'}`" role="status" :aria-label="`${attachment.fileName}：${recognitionLabel(attachment)}`">
            {{ recognitionLabel(attachment) }}
          </span>
          <span v-if="attachment.kind === 'image' && attachment.recognitionSummary" class="composer-attachment__summary" :title="attachment.recognitionSummary">
            {{ attachment.recognitionSummary }}
          </span>
          <button v-if="attachment.kind === 'image' && attachment.recognitionStatus === 'failed'" class="composer-tag__retry" type="button" :aria-label="`重试识别 ${attachment.fileName}`" @click="retryRecognition(attachment)">重试</button>
          <button class="composer-tag__remove" type="button" :aria-label="`删除附件 ${attachment.fileName}`" @click="removeAttachment(attachment.id)">×</button>
        </div>
      </div>
      <div v-if="localSkill" class="composer-tag composer-tag--skill">
        <span>/{{ localSkill.name }}</span>
        <button class="composer-tag__remove" type="button" :aria-label="`删除 Skill ${localSkill.name}`" @click="removeSkill">×</button>
      </div>
      <div v-for="agent in localAgents" :key="agent.id" class="composer-tag composer-tag--agent">
        <span>@{{ agent.name }}</span>
        <button class="composer-tag__remove" type="button" :aria-label="`删除 Agent ${agent.name}`" @click="removeAgent(agent.id)">×</button>
      </div>
    </div>
    <div v-if="agentPickerOpen" class="agent-picker" role="listbox" aria-label="选择 Agent" :aria-busy="agentPickerLoading">
      <p v-if="agentPickerLoading" class="agent-picker__status" role="status" aria-live="polite">正在加载可用 Agent…</p>
      <p v-else-if="agentPickerError" class="agent-picker__status is-error" role="alert">{{ agentPickerError }}</p>
      <p v-else-if="!agentPickerOptions.length" class="agent-picker__status" role="status">没有匹配的 Agent</p>
      <template v-else>
        <p class="agent-picker__query">@{{ agentPickerQuery || '选择 Agent' }}</p>
        <section v-for="group in groupedPickerAgents" :key="group.id" class="agent-picker__group">
          <h3 class="agent-picker__category">{{ group.name }}</h3>
          <button
            v-for="agent in group.agents"
            :key="agent.id"
            class="agent-picker__option"
            :class="{ 'is-active': agentPickerOptions[agentPickerIndex]?.id === agent.id }"
            type="button"
            role="option"
            :aria-selected="agentPickerOptions[agentPickerIndex]?.id === agent.id"
            :data-testid="`agent-picker-option-${agent.id}`"
            @click="selectAgentFromPicker(agent)"
          >
            <span class="agent-picker__name">@{{ agent.name }}</span>
            <span class="agent-picker__meta">{{ agent.description || agent.role }}</span>
          </button>
        </section>
      </template>
    </div>
    <div v-if="pendingAgentJoin" class="agent-join-confirm" role="dialog" aria-label="确认加入 Agent">
      <p><strong>@{{ pendingAgentJoin.name }}</strong> 尚未加入当前群聊，确认后可读取加入前的历史消息和附件索引。</p>
      <div class="agent-join-confirm__actions">
        <button type="button" class="agent-join-confirm__cancel" @click="cancelAgentJoin">取消</button>
        <button type="button" class="agent-join-confirm__accept" @click="confirmAgentJoin">确认加入</button>
      </div>
    </div>
    <div v-if="skillPickerOpen" class="skill-picker" role="listbox" aria-label="选择 Skill" :aria-busy="skillPickerLoading">
      <p v-if="skillPickerLoading" class="skill-picker__status" role="status" aria-live="polite">正在加载可用 Skill…</p>
      <p v-else-if="skillPickerError" class="skill-picker__status is-error" role="alert">{{ skillPickerError }}</p>
      <p v-else-if="!skillPickerOptions.length" class="skill-picker__status" role="status">暂无可用 Skill</p>
      <template v-else>
        <section v-for="group in groupedAvailableSkills" :key="group.id" class="skill-picker__group">
          <h3 class="skill-picker__category">{{ group.name }}</h3>
          <button
            v-for="skill in group.skills"
            :key="skill.id"
            class="skill-picker__option"
            :class="{ 'is-active': skillPickerOptions[skillPickerIndex]?.id === skill.id }"
            type="button"
            role="option"
            :aria-selected="skillPickerOptions[skillPickerIndex]?.id === skill.id"
            :data-testid="`skill-picker-option-${skill.id}`"
            @click="selectSkillFromPicker(skill)"
          >
            <span class="skill-picker__name">/{{ skill.name }}</span>
            <span class="skill-picker__meta">v{{ skill.revision }}</span>
          </button>
        </section>
      </template>
    </div>
    <label class="sr-only" :for="textareaId">消息输入</label>
    <textarea
      :id="textareaId"
      v-model="draft"
      :placeholder="placeholder"
      :disabled="disabled || busy"
      :aria-describedby="visibleError ? 'group-chat-composer-error' : undefined"
      :aria-invalid="visibleError ? 'true' : undefined"
      rows="2"
      @keydown="handleKeydown"
    />
    <div class="user-input-box__actions">
      <p v-if="visibleError" id="group-chat-composer-error" class="input-error" role="alert" aria-live="polite">{{ visibleError }}</p>
      <button class="send-button composer-action" :class="`is-${action}`" type="button"
        :disabled="actionDisabled" :aria-busy="controlBusy || undefined" :aria-label="actionLabel"
        :title="controlBusy ? actionPendingLabel : actionLabel" @click="activateAction">
        <span v-if="controlBusy" class="composer-action__spinner" aria-hidden="true"></span>
        <UiIcon v-else :name="action === 'stop' ? 'stop' : action === 'resume' ? 'play' : 'send'" :size="21" :stroke-width="2.4" />
        <span v-if="controlBusy" class="composer-action__status" role="status">{{ actionPendingLabel }}</span>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.user-input-box { position: relative; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.composer-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
.composer-attachments { display: flex; flex-wrap: wrap; gap: 6px; width: 100%; }
.composer-attachment, .composer-tag { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; max-width: 220px; padding: 3px 6px; border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 6px; font-size: 12px; line-height: 18px; }
.composer-attachment.is-image { padding-left: 3px; }
.composer-attachment__thumbnail { width: 28px; height: 28px; object-fit: cover; border-radius: 4px; }
.composer-attachment__icon { display: inline-flex; color: #606266; }
.composer-attachment__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-attachment__recognition { flex-shrink: 0; font-size: 11px; color: #606266; }
.composer-attachment__recognition.is-processing { color: #337ecc; }
.composer-attachment__recognition.is-ready { color: #2e7d32; }
.composer-attachment__recognition.is-failed { color: #c45656; }
.composer-attachment__summary { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #606266; font-size: 11px; }
.composer-tag__retry { padding: 1px 4px; border: 1px solid currentColor; border-radius: 4px; color: #c45656; background: transparent; cursor: pointer; font-size: 11px; }
.composer-tag__retry:focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: 1px; }
.composer-tag--skill { color: #2563eb; background: #eff6ff; border-color: #bfdbfe; font-weight: 600; }
.composer-tag--agent { color: #7c3aed; background: #f5f3ff; border-color: #ddd6fe; font-style: italic; }
.skill-picker { position: absolute; z-index: 4; right: 0; bottom: calc(100% + 8px); left: 0; max-height: 280px; overflow: auto; padding: 8px; border: 1px solid #bfdbfe; border-radius: 8px; background: #fff; box-shadow: 0 8px 24px rgb(15 23 42 / 14%); }
.skill-picker__group + .skill-picker__group { margin-top: 8px; }
.skill-picker__category { margin: 0 4px 4px; color: #64748b; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.skill-picker__option { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 7px 8px; border: 0; border-radius: 6px; color: #1e3a8a; background: transparent; cursor: pointer; text-align: left; }
.skill-picker__option:hover, .skill-picker__option.is-active { background: #eff6ff; }
.skill-picker__option:focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: -2px; }
.skill-picker__name { font-weight: 600; }
.skill-picker__meta { color: #64748b; font-size: 11px; }
.skill-picker__status { margin: 8px 4px; color: #64748b; font-size: 12px; }
.skill-picker__status.is-error { color: #c45656; }
.agent-picker { position: absolute; z-index: 4; right: 0; bottom: calc(100% + 8px); left: 0; max-height: 320px; overflow: auto; padding: 8px; border: 1px solid #ddd6fe; border-radius: 8px; background: #fff; box-shadow: 0 8px 24px rgb(15 23 42 / 14%); }
.agent-picker__query { margin: 4px; color: #6d28d9; font-size: 11px; font-weight: 700; }
.agent-picker__group + .agent-picker__group { margin-top: 8px; }
.agent-picker__category { margin: 0 4px 4px; color: #64748b; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.agent-picker__option { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 12px; padding: 7px 8px; border: 0; border-radius: 6px; color: #5b21b6; background: transparent; cursor: pointer; text-align: left; }
.agent-picker__option:hover, .agent-picker__option.is-active { background: #f5f3ff; }
.agent-picker__option:focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: -2px; }
.agent-picker__name { flex-shrink: 0; font-weight: 600; }
.agent-picker__meta { overflow: hidden; color: #64748b; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.agent-picker__status { margin: 8px 4px; color: #64748b; font-size: 12px; }
.agent-picker__status.is-error { color: #c45656; }
.agent-join-confirm { position: absolute; z-index: 5; right: 0; bottom: calc(100% + 8px); left: 0; padding: 10px 12px; border: 1px solid #f5c2e7; border-radius: 8px; background: #fff7fb; box-shadow: 0 8px 24px rgb(15 23 42 / 14%); color: #7a284d; font-size: 12px; }
.agent-join-confirm p { margin: 0; line-height: 1.5; }
.agent-join-confirm__actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
.agent-join-confirm__actions button { min-height: 26px; padding: 2px 9px; border: 1px solid #e5bfd1; border-radius: 5px; background: #fff; color: #7a284d; cursor: pointer; font-size: 11px; }
.agent-join-confirm__actions .agent-join-confirm__accept { border-color: #c0266d; background: #c0266d; color: #fff; }
.composer-tag__remove { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; color: currentColor; background: transparent; cursor: pointer; font-size: 16px; line-height: 16px; }
.composer-tag__remove:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
.composer-tag__remove:focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: 1px; }
.composer-action { flex-shrink: 0; cursor: pointer; transition: opacity 160ms; }
.composer-action:hover:not(:disabled) { opacity: .85; }
.composer-action:disabled { cursor: not-allowed; opacity: .6; }
.composer-action:focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: 2px; }
.composer-action__spinner { width: 18px; height: 18px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: composer-spin .8s linear infinite; }
.composer-action__status { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@keyframes composer-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .composer-action__spinner { animation: none; } }
.user-input-box.has-task-activity { margin-top: 32px; }
.task-activity {
  position: absolute;
  bottom: calc(100% + 7px);
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: #606266;
}
.task-activity.is-running { color: #337ecc; }
.task-activity.is-warning { color: #8d5706; }
.task-activity__dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: currentColor; }
.is-running .task-activity__dot { animation: task-activity-pulse 1.5s ease-in-out infinite; }
@keyframes task-activity-pulse { 50% { opacity: 0.4; } }
@media (prefers-reduced-motion: reduce) { .task-activity__dot { animation: none; } }
</style>
