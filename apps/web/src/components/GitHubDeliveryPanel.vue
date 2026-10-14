<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, Document, RefreshRight } from '@element-plus/icons-vue'
import { apiGet, apiPost } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import { useLocalRuntimeStore } from '@/stores/localRuntime'
import type { DeliveryDiff, DeliveryRecord, SessionDetail } from '@agent-cluster/shared'

const props = defineProps<{ session: SessionDetail }>()
const sessionStore = useSessionStore()
const localRuntimeStore = useLocalRuntimeStore()
const busy = ref(false)
const error = ref('')
const diffOpen = ref(false)
const diffKind = ref<'pull_request' | 'merged_commit'>('pull_request')
const diff = ref<DeliveryDiff>()
const selectedPath = ref('')
const reviewed = ref(false)
const validationProgram = ref('npm')
const validationScript = ref('test')
const validationDirectory = ref('.')
let timer: ReturnType<typeof setInterval> | undefined

const delivery = computed(() => props.session.delivery)
const selectedFile = computed(() => diff.value?.files.find((file) => file.path === selectedPath.value))
const deviceAvailable = computed(() => props.session.sourceBinding?.executionLocation !== 'local' ||
  localRuntimeStore.connectedDevices.some((device) =>
    device.deviceId === props.session.sourceBinding?.deviceId))
const mergeActionAvailable = computed(() => deviceAvailable.value &&
  (delivery.value?.state === 'merge_ready' ||
    delivery.value?.state === 'awaiting_ci' && delivery.value.mergeable === false))
const reviewedHead = computed(() => diffKind.value === 'pull_request' &&
  diff.value?.sha === delivery.value?.commitSha && diff.value?.hasMore === false && reviewed.value)
const statusText: Record<string, string> = {
  idle: '无需提交', awaiting_validation_input: '等待验证方式', validating: '正在验证',
  needs_fix: '验证未通过', preparing_push: '准备推送', pushing: '正在推送',
  pr_open: 'PR 已创建', awaiting_ci: '等待合并条件', merge_ready: '可以合并',
  merging: '正在合并', merged: '已合并', resolving_conflict: '需要解决冲突',
  blocked: '交付暂停'
}

watch(() => `${props.session.id}:${delivery.value?.commitSha}:${delivery.value?.version}`,
  () => {
    if (diff.value?.sha !== delivery.value?.commitSha) reviewed.value = false
  })
watch(deviceAvailable, (available, wasAvailable) => {
  if (available && !wasAvailable && delivery.value?.state === 'blocked' &&
      delivery.value.pullRequestNumber && !busy.value) void operate('refresh')
})

async function sync() {
  await sessionStore.refreshSourceSession(props.session.id)
}

async function operate(action: 'validate' | 'publish' | 'refresh') {
  const current = delivery.value
  if (!current || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const body = action === 'validate'
      ? { expectedDeliveryVersion: current.version,
          command: { program: validationProgram.value,
            args: ['run', validationScript.value], relativeCwd: validationDirectory.value } }
      : { expectedDeliveryVersion: current.version }
    await apiPost(`/sessions/${props.session.id}/delivery/${action}`, body)
    await sync()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '交付操作失败'
    await sync().catch(() => undefined)
  } finally {
    busy.value = false
  }
}

async function openDiff(kind: 'pull_request' | 'merged_commit') {
  if (busy.value) return
  diffKind.value = kind
  diff.value = undefined
  selectedPath.value = ''
  reviewed.value = false
  diffOpen.value = true
  await loadDiff(1)
}

async function loadDiff(page: number) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await apiGet<DeliveryDiff>(
      `/sessions/${props.session.id}/delivery/diff?kind=${diffKind.value}&page=${page}`)
    if (page > 1 && (!diff.value || result.kind !== diff.value.kind ||
        result.sha !== diff.value.sha || result.page !== diff.value.page + 1)) {
      diff.value = undefined
      reviewed.value = false
      throw new Error('差异版本已变化，请重新加载')
    }
    diff.value = page === 1 ? result : { ...result, files: [...diff.value!.files, ...result.files] }
    selectedPath.value ||= diff.value.files[0]?.path ?? ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '差异加载失败'
  } finally {
    busy.value = false
  }
}

async function merge() {
  const current = delivery.value
  if (!current || !mergeActionAvailable.value || !reviewedHead.value || !diff.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await apiPost(`/sessions/${props.session.id}/delivery/merge`, {
      expectedDeliveryVersion: current.version, expectedHeadSha: diff.value.sha
    }, { headers: { 'Idempotency-Key': current.mergeOperationKey ?? crypto.randomUUID() } })
    reviewed.value = false
    diffOpen.value = false
    await sync()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '合并失败'
    await sync().catch(() => undefined)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  timer = setInterval(() => {
    if (delivery.value?.pullRequestNumber && deviceAvailable.value &&
        ['awaiting_ci', 'merge_ready', 'pushing', 'merging', 'blocked'].includes(delivery.value.state)
        && !busy.value && !diffOpen.value) void operate('refresh')
  }, 15_000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <section v-if="delivery" class="github-delivery" aria-label="GitHub 代码交付">
    <div class="github-delivery__row">
      <div class="github-delivery__status">
        <strong>代码交付</strong>
        <el-tag size="small" :type="delivery.state === 'merged' ? 'success' : delivery.state === 'blocked' || delivery.state === 'needs_fix' ? 'danger' : 'info'">
          {{ statusText[delivery.state] ?? delivery.state }}
        </el-tag>
        <span>第 {{ delivery.round }} 轮</span>
        <span v-if="delivery.ciStatus">CI：{{ delivery.ciStatus }}</span>
      </div>
      <div class="github-delivery__actions">
        <el-button :icon="RefreshRight" circle title="刷新交付状态" aria-label="刷新交付状态"
          :disabled="busy || !delivery.pullRequestNumber" @click="operate('refresh')" />
        <el-button v-if="delivery.pullRequestNumber" :icon="Document" title="查看 PR 差异"
          aria-label="查看 PR 差异" :disabled="busy" @click="openDiff('pull_request')" />
        <el-button v-if="delivery.state === 'merged' && delivery.mergedCommitSha"
          :icon="Document" title="查看实际合入差异" aria-label="查看实际合入差异"
          :disabled="busy" @click="openDiff('merged_commit')" />
        <el-button v-if="mergeActionAvailable" type="primary" :icon="Check"
          :disabled="busy" @click="openDiff('pull_request')">
          {{ delivery.mergeable === false ? '审查并解决冲突' : '审查并合并' }}
        </el-button>
      </div>
    </div>
    <a v-if="delivery.pullRequestUrl" :href="delivery.pullRequestUrl" target="_blank" rel="noopener noreferrer">
      PR #{{ delivery.pullRequestNumber }}
    </a>
    <p v-if="delivery.validation">验证：{{ delivery.validation.command }} · 退出码 {{ delivery.validation.exitCode }}</p>
    <p v-if="delivery.errorCode" class="github-delivery__error">{{ delivery.errorCode }}</p>
    <div v-if="['awaiting_validation_input', 'needs_fix'].includes(delivery.state)" class="github-delivery__validation">
      <el-select v-model="validationProgram" aria-label="验证工具">
        <el-option label="npm" value="npm" /><el-option label="pnpm" value="pnpm" />
        <el-option label="yarn" value="yarn" />
      </el-select>
      <el-input v-model="validationScript" aria-label="验证脚本" placeholder="脚本名称" />
      <el-input v-model="validationDirectory" aria-label="相对目录" placeholder="相对目录" />
      <el-button :loading="busy" :disabled="!validationScript.trim()" @click="operate('validate')">执行验证</el-button>
    </div>
    <el-button v-if="delivery.state === 'blocked' && delivery.validation?.exitCode === 0"
      :loading="busy" @click="operate('publish')">重试交付</el-button>
    <p v-if="error" role="alert" class="github-delivery__error">{{ error }}</p>
  </section>

  <el-dialog v-model="diffOpen" :title="diffKind === 'pull_request' ? 'PR 代码差异' : '实际合入代码差异'"
    width="min(1100px, 96vw)" append-to-body>
    <div v-if="diff" class="github-delivery__diff">
      <header>提交 {{ diff.sha }} <span>{{ diff.files.length }} 个文件</span></header>
      <div class="github-delivery__diff-grid">
        <nav aria-label="差异文件">
          <button v-for="file in diff.files" :key="file.path" type="button"
            :class="{ selected: selectedPath === file.path }" @click="selectedPath = file.path">
            <span>{{ file.path }}</span><small>+{{ file.additions }} / -{{ file.deletions }}</small>
          </button>
          <el-button v-if="diff.hasMore" :loading="busy" @click="loadDiff(diff.page + 1)">加载更多文件</el-button>
        </nav>
        <div class="github-delivery__patch">
          <strong>{{ selectedFile?.path }}</strong>
          <p v-if="selectedFile?.previousPath">原路径：{{ selectedFile.previousPath }}</p>
          <pre v-if="selectedFile?.patch">{{ selectedFile.patch }}</pre>
          <p v-else>该文件没有可展示的文本补丁。</p>
        </div>
      </div>
    </div>
    <p v-if="error" role="alert" class="github-delivery__error">{{ error }}</p>
    <template #footer>
      <el-checkbox v-if="diffKind === 'pull_request' && mergeActionAvailable"
        v-model="reviewed" :disabled="busy || !diff || diff.sha !== delivery?.commitSha || diff.hasMore">
        已审查此版本的差异
      </el-checkbox>
      <el-button @click="diffOpen = false">关闭</el-button>
      <el-button v-if="mergeActionAvailable && diffKind === 'pull_request'"
        type="primary" :loading="busy" :disabled="!reviewedHead" @click="merge">
        {{ delivery?.mergeable === false ? '进入冲突处理' : 'Squash Merge' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.github-delivery { display: grid; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--el-border-color); background: var(--el-fill-color-light); }
.github-delivery__row, .github-delivery__status, .github-delivery__actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.github-delivery__row { justify-content: space-between; }
.github-delivery__status span, .github-delivery p { color: var(--el-text-color-secondary); }
.github-delivery p { margin: 0; }
.github-delivery__error { color: var(--el-color-danger) !important; overflow-wrap: anywhere; }
.github-delivery__validation { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.github-delivery__validation :deep(.el-select), .github-delivery__validation :deep(.el-input) { width: min(150px, 100%); }
.github-delivery__diff { min-width: 0; }
.github-delivery__diff header { display: flex; gap: 12px; flex-wrap: wrap; overflow-wrap: anywhere; font-size: 12px; color: var(--el-text-color-secondary); margin-bottom: 12px; }
.github-delivery__diff-grid { display: grid; grid-template-columns: minmax(170px, 230px) minmax(0, 1fr); min-height: 300px; max-height: 65vh; border: 1px solid var(--el-border-color); }
.github-delivery__diff-grid nav { overflow: auto; border-right: 1px solid var(--el-border-color); }
.github-delivery__diff-grid nav button { width: 100%; border: 0; border-bottom: 1px solid var(--el-border-color-lighter); background: transparent; text-align: left; padding: 8px; display: grid; gap: 4px; cursor: pointer; }
.github-delivery__diff-grid nav button.selected { background: var(--el-color-primary-light-9); }
.github-delivery__diff-grid nav button span { overflow-wrap: anywhere; }
.github-delivery__diff-grid nav button small { color: var(--el-text-color-secondary); }
.github-delivery__patch { overflow: auto; min-width: 0; padding: 12px; }
.github-delivery__patch strong { overflow-wrap: anywhere; }
.github-delivery__patch pre { font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre; overflow: auto; max-width: 100%; }
@media (max-width: 600px) { .github-delivery__diff-grid { grid-template-columns: 1fr; grid-template-rows: minmax(90px, 24vh) minmax(180px, 1fr); } .github-delivery__diff-grid nav { border-right: 0; border-bottom: 1px solid var(--el-border-color); } }
</style>
