<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type {
  FileRevisionCandidate,
  FileRevisionEditorDraftContent,
  FileRevisionRunStatus
} from '@/types/contracts'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  filePath: string
  iteration: number
  status: FileRevisionRunStatus
  candidate?: FileRevisionCandidate
  draft?: FileRevisionEditorDraftContent
  busy?: boolean
  error?: string
  partialFailure?: boolean
  successfulAgentCount?: number
}>()

const emit = defineEmits<{
  save: [content: string]
  submit: [content: string]
  apply: []
  abandon: []
  failureDecision: [decision: 'retry_agents' | 'continue_with_successful' | 'abandon_revision']
  retryInterrupted: []
}>()

const editing = ref(Boolean(props.draft))
const content = ref(props.draft?.content ?? props.candidate?.content ?? '')
const sectionRef = ref<HTMLElement>()
const contentRef = ref<HTMLElement>()
const textareaRef = ref<HTMLTextAreaElement>()
const editButtonRef = ref<HTMLButtonElement>()
const processing = computed(() => ['submitted', 'processing', 'synthesizing', 'applying'].includes(props.status))
const candidateReady = computed(() => props.status === 'awaiting_confirmation' && Boolean(props.candidate))
const changed = computed(() => content.value !== (props.draft?.content ?? props.candidate?.content ?? ''))
const canSubmit = computed(() => changed.value || Boolean(props.draft))

watch(
  () => [props.candidate?.candidateHash.value, props.draft?.contentHash.value] as const,
  () => {
    content.value = props.draft?.content ?? props.candidate?.content ?? ''
    editing.value = Boolean(props.draft)
  }
)

watch(
  () => [props.status, props.candidate?.candidateHash.value] as const,
  ([status, candidateHash], [previousStatus, previousCandidateHash]) => {
    if (status !== previousStatus && ['submitted', 'processing', 'synthesizing', 'applying'].includes(status)) {
      void nextTick(() => sectionRef.value?.focus())
      return
    }
    if (candidateHash && candidateHash !== previousCandidateHash && status === 'awaiting_confirmation') {
      void nextTick(() => contentRef.value?.focus())
    }
  }
)

async function beginEditing() {
  editing.value = true
  await nextTick()
  textareaRef.value?.focus()
}

async function cancelEditing() {
  content.value = props.draft?.content ?? props.candidate?.content ?? ''
  editing.value = false
  await nextTick()
  ;(editButtonRef.value ?? contentRef.value)?.focus()
}
</script>

<template>
  <section ref="sectionRef" class="revision-editor" aria-labelledby="revision-editor-title" tabindex="-1">
    <header class="revision-editor__header">
      <div>
        <h2 id="revision-editor-title">{{ filePath }}</h2>
        <span>第 {{ iteration }} 轮</span>
      </div>
      <span :class="['revision-editor__status', status]">
        <i v-if="processing" aria-hidden="true"></i>
        {{ processing ? '处理中' : status === 'awaiting_confirmation' ? '待确认' : status }}
      </span>
    </header>

    <div v-if="processing && !candidateReady" class="revision-editor__processing" role="status" aria-live="polite">
      <span></span>
      <strong>{{ status === 'synthesizing' ? 'Receiver 正在生成候选' : status === 'applying' ? '正在写回文件' : 'Agent 正在处理' }}</strong>
    </div>

    <template v-else-if="candidateReady">
      <textarea
        v-if="editing"
        ref="textareaRef"
        v-model="content"
        class="revision-editor__textarea"
        :disabled="busy"
        :aria-label="`${filePath} 候选内容`"
        spellcheck="false"
      />
      <pre v-else ref="contentRef" class="revision-editor__content" tabindex="0">{{ candidate?.content }}</pre>

      <p v-if="error" class="revision-editor__error" role="alert">{{ error }}</p>

      <footer v-if="editing" class="revision-editor__actions">
        <button type="button" :disabled="busy || !changed" @click="emit('save', content)">
          <UiIcon name="check" :size="16" />
          保存草稿
        </button>
        <button class="primary" type="button" :disabled="busy || !canSubmit" @click="emit('submit', content)">
          <UiIcon name="send" :size="16" />
          提交修改
        </button>
        <button type="button" :disabled="busy" @click="cancelEditing">
          <UiIcon name="x" :size="16" />
          放弃编辑
        </button>
      </footer>
      <footer v-else class="revision-editor__actions">
        <button class="primary" type="button" :disabled="busy" @click="emit('apply')">
          <UiIcon name="check" :size="16" />
          确认并写回
        </button>
        <button ref="editButtonRef" type="button" :disabled="busy" @click="beginEditing">
          <UiIcon name="plus" :size="16" />
          继续编辑
        </button>
        <button class="danger" type="button" :disabled="busy" @click="emit('abandon')">
          <UiIcon name="x" :size="16" />
          放弃修订
        </button>
      </footer>
    </template>

    <div v-else-if="error || ['failed', 'stale', 'interrupted'].includes(status)" class="revision-editor__failure">
      <p class="revision-editor__error" role="alert">
        {{ error || (status === 'stale' ? '原文件已变化，候选未写回。' : status === 'interrupted' ? '服务重启中断了本轮处理。' : '本轮修订处理失败。') }}
      </p>
      <footer v-if="partialFailure" class="revision-editor__actions" aria-label="部分 Agent 失败处理">
        <button class="primary" type="button" :disabled="busy" @click="emit('failureDecision', 'retry_agents')">
          <UiIcon name="refresh-cw" :size="16" />
          重试全部 Agent
        </button>
        <button
          type="button"
          :disabled="busy || !successfulAgentCount"
          @click="emit('failureDecision', 'continue_with_successful')"
        >
          <UiIcon name="send" :size="16" />
          使用成功结果继续
        </button>
        <button class="danger" type="button" :disabled="busy" @click="emit('failureDecision', 'abandon_revision')">
          <UiIcon name="x" :size="16" />
          放弃修订
        </button>
      </footer>
      <footer v-else-if="status === 'interrupted'" class="revision-editor__actions" aria-label="重试中断的文件修订">
        <button class="primary" type="button" :disabled="busy" @click="emit('retryInterrupted')">
          <UiIcon name="refresh-cw" :size="16" />
          重试本轮修订
        </button>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.revision-editor {
  flex: 0 0 min(58vh, 620px);
  min-height: 280px;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid #dcdfe6;
  background: #fff;
}

.revision-editor__header {
  min-height: 52px;
  padding: 10px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #ebeef5;
}

.revision-editor__header > div {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.revision-editor__header h2 {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}

.revision-editor__header span {
  flex: none;
  font-size: 12px;
  color: #909399;
}

.revision-editor__status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #606266;
}

.revision-editor__status i,
.revision-editor__processing span {
  width: 12px;
  height: 12px;
  border: 2px solid #c0c4cc;
  border-top-color: #409eff;
  border-radius: 50%;
  animation: revision-spin .8s linear infinite;
}

.revision-editor__content,
.revision-editor__textarea {
  flex: 1;
  min-height: 0;
  width: 100%;
  margin: 0;
  padding: 18px;
  overflow: auto;
  border: 0;
  outline: 0;
  resize: none;
  background: #fff;
  color: #303133;
  font: 13px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  box-sizing: border-box;
}

.revision-editor__textarea:focus {
  box-shadow: inset 0 0 0 2px #409eff;
}

.revision-editor__processing {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #606266;
}

.revision-editor__actions {
  min-height: 56px;
  padding: 10px 18px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-top: 1px solid #ebeef5;
}

.revision-editor__actions button {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 13px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  background: #fff;
  color: #606266;
  cursor: pointer;
}

.revision-editor__actions button.primary {
  border-color: #409eff;
  background: #409eff;
  color: #fff;
}

.revision-editor__actions button.danger {
  border-color: #f56c6c;
  color: #f56c6c;
}

.revision-editor__actions button:disabled {
  opacity: .55;
  cursor: not-allowed;
}

.revision-editor__error {
  margin: 0;
  padding: 10px 18px;
  background: #fef0f0;
  color: #c45656;
  font-size: 13px;
}

.revision-editor__failure {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

@keyframes revision-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 760px) {
  .revision-editor { flex-basis: min(64vh, 560px); }
  .revision-editor__actions { flex-wrap: wrap; }
  .revision-editor__actions button { flex: 1 1 140px; justify-content: center; }
}
</style>
