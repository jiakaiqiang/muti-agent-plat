<script setup lang="ts">
import { ref } from 'vue'
import UiIcon from './UiIcon.vue'

defineProps<{ modelValue?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string | undefined] }>()

const warning = ref('')
const isChoosing = ref(false)

type NativeDirectoryPicker = (options?: unknown) => Promise<unknown> | unknown

// 只从用户侧的本地运行环境取目录路径。普通浏览器不会暴露绝对路径,此时只能手动填写。
async function trigger() {
  warning.value = ''
  isChoosing.value = true
  try {
    const path = await pickDirectoryFromUserDevice()
    if (path) {
      emit('update:modelValue', path)
      return
    }
    warning.value = '当前浏览器无法直接读取本机目录绝对路径，请手动填写本地目录绝对路径。'
  } catch (error) {
    warning.value = error instanceof Error
      ? error.message
      : '当前环境无法选择本机目录，请手动填写本地目录绝对路径。'
  } finally {
    isChoosing.value = false
  }
}

async function pickDirectoryFromUserDevice(): Promise<string | undefined> {
  const host = window as unknown as {
    electronAPI?: Record<string, NativeDirectoryPicker>
    nativeAPI?: Record<string, NativeDirectoryPicker>
    desktopAPI?: Record<string, NativeDirectoryPicker>
    __TAURI__?: { dialog?: { open?: NativeDirectoryPicker } }
  }

  const nativePickers = [
    host.electronAPI?.selectDirectory,
    host.electronAPI?.pickDirectory,
    host.electronAPI?.openDirectory,
    host.nativeAPI?.selectDirectory,
    host.nativeAPI?.pickDirectory,
    host.desktopAPI?.selectDirectory,
    host.desktopAPI?.pickDirectory
  ].filter(Boolean) as NativeDirectoryPicker[]

  for (const picker of nativePickers) {
    const path = normalizeSelectedPath(await picker())
    if (path) return path
  }

  const tauriOpen = host.__TAURI__?.dialog?.open
  if (tauriOpen) {
    const path = normalizeSelectedPath(await tauriOpen({ directory: true, multiple: false }))
    if (path) return path
  }

  return undefined
}

function normalizeSelectedPath(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined
  }
  if (Array.isArray(value)) {
    return normalizeSelectedPath(value[0])
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const record = value as Record<string, unknown>
  return (
    normalizeSelectedPath(record.path) ??
    normalizeSelectedPath(record.selectedPath) ??
    normalizeSelectedPath(record.directory) ??
    normalizeSelectedPath(record.filePath) ??
    normalizeSelectedPath(record.filePaths)
  )
}

function onManual(event: Event) {
  const value = (event.target as HTMLInputElement).value.trim()
  emit('update:modelValue', value || undefined)
}

function clear() {
  emit('update:modelValue', undefined)
  warning.value = ''
}
</script>

<template>
  <div class="directory-picker">
    <div class="directory-picker__field">
      <UiIcon name="folder" :size="16" />
      <input
        type="text"
        class="directory-picker__input"
        :value="modelValue ?? ''"
        placeholder="选择本次会话的运行目录，或手动填写本地目录绝对路径（留空用默认环境）"
        spellcheck="false"
        @input="onManual"
      />
      <button type="button" class="directory-picker__choose" :disabled="isChoosing" @click="trigger">
        {{ isChoosing ? '选择中...' : '选择环境目录' }}
      </button>
      <button v-if="modelValue" type="button" class="directory-picker__clear" @click="clear">清除</button>
    </div>
    <p v-if="warning" class="directory-picker__warning">{{ warning }}</p>
  </div>
</template>
