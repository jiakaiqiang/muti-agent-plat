<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { diffLines } from 'diff'
import { apiGet, apiPost, apiPut } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import type { ConflictFileView, ConflictView } from '@agent-cluster/shared'

const props = defineProps<{ sessionId: string; conflictId: string }>()
const sessionStore = useSessionStore()
const view = ref<ConflictView>()
const selectedId = ref('')
const draft = ref('')
const choice = ref<'ours' | 'theirs'>('ours')
const error = ref('')
const busy = ref(false)
const previousDraft = ref<string | undefined>()
const selected = computed(() => view.value?.files.find((file) => file.fileId === selectedId.value))
const workspaceConflict = computed(() => view.value?.source === 'workspace_writeback')
const allConfirmed = computed(() => Boolean(view.value?.files.length &&
  view.value.files.every((file) => file.status === 'confirmed')))
const kindLabels: Record<ConflictFileView['kind'], string> = {
  text: '文本冲突', binary: '二进制冲突', deleted: '删除冲突',
  renamed: '改名冲突', mode: '文件模式冲突'
}
const changes = computed(() => selected.value?.kind === 'text'
  ? diffLines(selected.value.oursContent ?? '', selected.value.theirsContent ?? '') : [])
const oursLines = computed(() => changes.value.filter((change) => !change.added)
  .flatMap((change) => change.value.split('\n').filter((line, index, lines) =>
    index < lines.length - 1 || line).map((line) => ({ line, conflict: Boolean(change.removed) }))))
const theirsLines = computed(() => changes.value.filter((change) => !change.removed)
  .flatMap((change) => change.value.split('\n').filter((line, index, lines) =>
    index < lines.length - 1 || line).map((line) => ({ line, conflict: Boolean(change.added) }))))

watch(() => `${props.sessionId}:${props.conflictId}`, () => { void load() }, { immediate: true })
watch(selected, (file) => {
  draft.value = file?.resultContent ?? ''
  choice.value = file?.binaryChoice ?? (file?.oursObjectId ? 'ours' : 'theirs')
  previousDraft.value = undefined
})

async function load() {
  error.value = ''
  try {
    view.value = await apiGet<ConflictView>(
      `/sessions/${props.sessionId}/conflicts/${props.conflictId}`)
    if (!view.value.files.some((file) => file.fileId === selectedId.value)) {
      selectedId.value = view.value.files[0]?.fileId ?? ''
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '冲突文件加载失败'
  }
}

function adopt(side: 'ours' | 'theirs') {
  if (!selected.value || selected.value.status === 'confirmed') return
  if (selected.value.kind === 'text') {
    previousDraft.value = draft.value
    draft.value = side === 'ours' ? selected.value.oursContent ?? '' : selected.value.theirsContent ?? ''
  } else choice.value = side
}

function keydown(event: KeyboardEvent) {
  if (!event.altKey) return
  if (event.key === 'ArrowLeft') { event.preventDefault(); adopt('ours') }
  if (event.key === 'ArrowRight') { event.preventDefault(); adopt('theirs') }
  if (event.key.toLowerCase() === 'z' && previousDraft.value !== undefined) {
    event.preventDefault()
    const current = draft.value
    draft.value = previousDraft.value
    previousDraft.value = current
  }
}

async function save(file: ConflictFileView, confirm: boolean) {
  if (!view.value || busy.value || file.status === 'confirmed') return
  busy.value = true
  error.value = ''
  try {
    const next = await apiPut<ConflictView>(
      `/sessions/${props.sessionId}/conflicts/${props.conflictId}/files/${file.fileId}`, {
        expectedConflictVersion: view.value.version, confirm,
        ...(file.kind === 'text' ? { resultContent: draft.value } : { binaryChoice: choice.value })
      })
    view.value = next
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '冲突保存失败'
  } finally {
    busy.value = false
  }
}

async function complete() {
  if (!view.value || !allConfirmed.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await apiPost<{ status?: string }>(`/sessions/${props.sessionId}/conflicts/${props.conflictId}/complete`,
      { expectedConflictVersion: view.value.version })
    if (workspaceConflict.value && result.status === 'conflicted') await load()
    await sessionStore.refreshSourceSession(props.sessionId)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '冲突提交失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="github-conflict" :aria-label="workspaceConflict ? '工作区冲突编辑器' : 'GitHub 冲突编辑器'" @keydown="keydown">
    <header class="github-conflict__header">
      <strong>{{ workspaceConflict ? '工作区写回冲突' : '合并冲突' }}</strong>
      <span>{{ view?.files.filter((file) => file.status === 'confirmed').length ?? 0 }} / {{ view?.files.length ?? 0 }} 已确认</span>
      <el-button :disabled="busy" @click="load">刷新</el-button>
      <el-button type="primary" :loading="busy" :disabled="!allConfirmed" @click="complete">{{ workspaceConflict ? '应用到工作区' : '验证并更新 PR' }}</el-button>
    </header>
    <div v-if="view" class="github-conflict__layout">
      <nav aria-label="冲突文件列表" class="github-conflict__files">
        <button v-for="file in view.files" :key="file.fileId" type="button"
          :class="{ selected: file.fileId === selectedId }" @click="selectedId = file.fileId">
          <span>{{ file.previousPath && file.previousPath !== file.path
            ? `${file.previousPath} → ${file.path}` : file.path }}</span>
          <small>{{ kindLabels[file.kind] }} · {{ file.status }}</small>
        </button>
      </nav>
      <div v-if="selected" class="github-conflict__editor">
        <h3>{{ selected.path }}</h3>
        <div v-if="selected.kind === 'text'" class="github-conflict__panes">
          <section :aria-label="workspaceConflict ? '会话候选版本' : '当前任务分支'">
            <header>{{ workspaceConflict ? '会话候选版本' : '当前任务分支' }} <el-button size="small" title="采用左侧 (Alt+←)" :disabled="selected.status === 'confirmed'" @click="adopt('ours')">采用左侧</el-button></header>
            <pre><span v-for="(line, index) in oursLines" :key="index" :class="{ conflict: line.conflict }">{{ line.line }}
</span></pre>
          </section>
          <section :aria-label="workspaceConflict ? '当前工作区版本' : '待合入目标分支'">
            <header>{{ workspaceConflict ? '当前工作区版本' : '待合入目标分支' }} <el-button size="small" title="采用右侧 (Alt+→)" :disabled="selected.status === 'confirmed'" @click="adopt('theirs')">采用右侧</el-button></header>
            <pre><span v-for="(line, index) in theirsLines" :key="index" :class="{ conflict: line.conflict }">{{ line.line }}
</span></pre>
          </section>
          <section aria-label="最终结果">
            <header>最终结果</header>
            <el-input v-model="draft" type="textarea" :rows="18" resize="none"
              aria-label="冲突解决结果" :disabled="selected.status === 'confirmed'" />
          </section>
        </div>
        <div v-else class="github-conflict__typed">
          <p>{{ selected.kind === 'binary' ? '二进制文件' : selected.kind === 'deleted' ? '删除冲突' : selected.kind === 'mode' ? '文件模式冲突' : '改名冲突' }}</p>
          <el-radio-group v-model="choice" :disabled="selected.status === 'confirmed'" aria-label="采用版本">
            <el-radio value="ours">{{ workspaceConflict ? '会话候选版本' : '当前任务分支' }}</el-radio>
            <el-radio value="theirs">{{ workspaceConflict ? '当前工作区版本' : '待合入目标分支' }}</el-radio>
          </el-radio-group>
        </div>
        <footer v-if="selected.status !== 'confirmed'">
          <el-button :loading="busy" @click="save(selected, false)">保存草稿</el-button>
          <el-button type="primary" :loading="busy" @click="save(selected, true)">确认此文件</el-button>
        </footer>
      </div>
    </div>
    <p v-if="error" class="github-conflict__error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.github-conflict { display: grid; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--el-border-color); background: var(--el-bg-color); min-width: 0; }
.github-conflict__header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.github-conflict__header span { color: var(--el-text-color-secondary); margin-right: auto; }
.github-conflict__layout { display: grid; grid-template-columns: minmax(150px, 210px) minmax(0, 1fr); border: 1px solid var(--el-border-color); min-width: 0; max-height: 58vh; }
.github-conflict__files { overflow: auto; border-right: 1px solid var(--el-border-color); }
.github-conflict__files button { width: 100%; display: grid; gap: 4px; padding: 8px; text-align: left; border: 0; border-bottom: 1px solid var(--el-border-color-lighter); background: transparent; cursor: pointer; }
.github-conflict__files button.selected { background: var(--el-color-primary-light-9); }
.github-conflict__files span { overflow-wrap: anywhere; }
.github-conflict__files small { color: var(--el-text-color-secondary); }
.github-conflict__editor { min-width: 0; overflow: auto; padding: 8px; }
.github-conflict__editor h3 { font-size: 13px; margin: 0 0 8px; overflow-wrap: anywhere; }
.github-conflict__panes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; min-width: 0; }
.github-conflict__panes section { min-width: 0; border: 1px solid var(--el-border-color); }
.github-conflict__panes header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; min-height: 36px; padding: 4px 6px; background: var(--el-fill-color-light); font-size: 12px; }
.github-conflict__panes pre { margin: 0; height: 310px; overflow: auto; padding: 6px; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
.github-conflict__panes pre span.conflict { background: var(--el-color-warning-light-8); border-left: 3px solid var(--el-color-warning); }
.github-conflict__panes :deep(textarea) { font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; min-height: 310px !important; border-radius: 0; }
.github-conflict__typed, .github-conflict__editor footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding-top: 8px; }
.github-conflict__error { color: var(--el-color-danger); margin: 0; overflow-wrap: anywhere; }
@media (max-width: 850px) { .github-conflict__layout { grid-template-columns: 1fr; max-height: none; } .github-conflict__files { max-height: 130px; border-right: 0; border-bottom: 1px solid var(--el-border-color); } .github-conflict__panes { grid-template-columns: 1fr; } .github-conflict__panes pre, .github-conflict__panes :deep(textarea) { height: 180px; min-height: 180px !important; } }
</style>
