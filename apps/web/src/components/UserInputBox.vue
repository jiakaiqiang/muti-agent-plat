<script setup lang="ts">
import { computed, ref } from 'vue'
import UiIcon from './UiIcon.vue'

const props = withDefaults(
  defineProps<{
    disabled?: boolean
    busy?: boolean
    placeholder?: string
    error?: string
  }>(),
  {
    disabled: false,
    busy: false,
    placeholder: '输入消息...（支持 @agent / #知识库 / 发送文件）'
  }
)

const emit = defineEmits<{
  send: [content: string]
}>()

const draft = ref('')
const canSend = computed(() => draft.value.trim().length > 0 && !props.disabled && !props.busy)

function submit() {
  const content = draft.value.trim()
  if (!content || !canSend.value) return
  emit('send', content)
  draft.value = ''
}

function handleKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    submit()
  }
}
</script>

<template>
  <footer class="user-input-box" aria-label="User input">
    <div class="input-tools" aria-hidden="true">
      <span class="tool-dot"><UiIcon name="paperclip" :size="18" /></span>
      <span class="tool-dot"><UiIcon name="image" :size="18" /></span>
      <span class="tool-dot"><UiIcon name="code" :size="18" /></span>
      <span class="tool-dot"><UiIcon name="at" :size="18" /></span>
    </div>
    <textarea
      v-model="draft"
      :placeholder="placeholder"
      :disabled="disabled || busy"
      rows="2"
      @keydown="handleKeydown"
    />
    <div class="user-input-box__actions">
      <p v-if="error" class="input-error">{{ error }}</p>
      <button class="send-button" type="button" :disabled="!canSend" title="发送" @click="submit">
        <UiIcon name="send" :size="21" :stroke-width="2.4" />
      </button>
    </div>
  </footer>
</template>
