<script setup lang="ts">
import { ref } from 'vue'
import UiIcon from './UiIcon.vue'

defineProps<{ modelValue?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string | undefined] }>()

const inputRef = ref<HTMLInputElement>()
const warning = ref('')

// 点击按钮触发原生「选择文件夹」对话框(input[webkitdirectory])。
function trigger() {
  warning.value = ''
  inputRef.value?.click()
}

function onChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const dir = resolveSelectedDir(file)
  if (dir) {
    emit('update:modelValue', dir)
  } else {
    warning.value = '当前环境拿不到文件夹的绝对路径，请在下方手动补全。'
  }
}

// 从选中文件夹里任一文件推出该文件夹的绝对路径:File.path（本地 / Electron / webview 会暴露）减去
// webkitRelativePath 的相对部分,得到所选文件夹的绝对路径。
function resolveSelectedDir(file: File): string | undefined {
  const rel = (file.webkitRelativePath || '').replace(/\\/g, '/')
  const folderName = rel.split('/')[0] || ''
  const abs = ((file as unknown as { path?: string }).path ?? '').replace(/\\/g, '/')
  if (abs && rel && abs.endsWith(rel)) {
    const base = abs.slice(0, abs.length - rel.length)
    const dir = `${base}${folderName}`.replace(/\/+$/, '')
    return dir || undefined
  }
  return undefined
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
        placeholder="点击「选择文件夹」，或手动填写本地目录绝对路径（留空用默认目录）"
        spellcheck="false"
        @input="onManual"
      />
      <button type="button" class="directory-picker__choose" @click="trigger">选择文件夹</button>
      <button v-if="modelValue" type="button" class="directory-picker__clear" @click="clear">清除</button>
    </div>
    <p v-if="warning" class="directory-picker__warning">{{ warning }}</p>
    <!-- 原生文件夹选择:webkitdirectory 让对话框只能选目录 -->
    <input ref="inputRef" type="file" webkitdirectory multiple hidden @change="onChange" />
  </div>
</template>
