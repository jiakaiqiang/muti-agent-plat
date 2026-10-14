<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiGet, apiPost } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import type { SessionDetail } from '@/types/contracts'

const props = defineProps<{ session: SessionDetail }>()
const sessionStore = useSessionStore()
const token = ref('')
const error = ref('')
const busy = ref(false)
const authorizationUrl = ref('')
const branches = ref<Array<{ name: string; sha: string }>>([])
const selectedBranch = ref('')
const branchVersion = ref(0)
const branchDialogVisible = ref(false)
let pollTimer: ReturnType<typeof setInterval> | undefined
let refreshing = false

function message(errorValue: unknown) {
  return errorValue instanceof Error ? errorValue.message : 'GitHub 来源操作失败'
}

async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    await sessionStore.refreshSourceSession(props.session.id)
  } catch (cause) {
    error.value = message(cause)
  } finally {
    refreshing = false
  }
}

async function loadBranches() {
  try {
    const result = await apiGet<{
      defaultBranch: string
      branches: Array<{ name: string; sha: string }>
      version: number
    }>(`/sessions/${props.session.id}/source/branches`)
    branches.value = result.branches
    selectedBranch.value = result.defaultBranch
    branchVersion.value = result.version
    branchDialogVisible.value = true
    error.value = ''
  } catch (cause) {
    error.value = message(cause)
  }
}

watch(() => `${props.session.id}:${props.session.sourceBinding?.state}:${props.session.sourceBinding?.version}`,
  () => {
    if (props.session.sourceBinding?.state === 'awaiting_base_branch') void loadBranches()
    else branchDialogVisible.value = false
  }, { immediate: true })

onMounted(() => {
  pollTimer = setInterval(() => {
    if (['awaiting_auth', 'cloning', 'binding'].includes(props.session.sourceBinding?.state ?? '')) {
      void refresh()
    }
  }, 2000)
})
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

async function startOAuth() {
  busy.value = true
  error.value = ''
  try {
    const result = await apiPost<{ authorizationUrl: string }>(
      '/code-hosts/github/oauth/start', { sessionId: props.session.id })
    authorizationUrl.value = result.authorizationUrl
  } catch (cause) {
    error.value = message(cause)
  } finally {
    busy.value = false
  }
}

async function saveToken() {
  if (!token.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    await apiPost(`/code-hosts/github/tokens`, {
      sessionId: props.session.id,
      token: token.value.trim()
    })
    await refresh()
  } catch (cause) {
    error.value = message(cause)
  } finally {
    token.value = ''
    busy.value = false
  }
}

async function retry() {
  busy.value = true
  error.value = ''
  try {
    await apiPost(`/sessions/${props.session.id}/source/retry`, {})
    await refresh()
  } catch (cause) {
    error.value = message(cause)
  } finally {
    busy.value = false
  }
}

async function selectBranch() {
  if (!selectedBranch.value) return
  busy.value = true
  error.value = ''
  try {
    await apiPost(`/sessions/${props.session.id}/source/base-branch`, {
      branch: selectedBranch.value,
      expectedSourceVersion: branchVersion.value
    })
    branchDialogVisible.value = false
    await refresh()
  } catch (cause) {
    const failure = message(cause)
    await loadBranches()
    error.value = failure
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="session.sourceBinding" class="github-source-preparation" role="status" aria-live="polite">
    <div class="github-source-preparation__heading">
      <strong>{{ session.codeSource?.kind === 'remote_repository' ? session.codeSource.repositoryUrl : 'GitHub 仓库' }}</strong>
      <span v-if="session.sourceBinding.state === 'ready'">基础分支：{{ session.sourceBinding.baseBranch }}</span>
      <span v-else-if="session.sourceBinding.state === 'cloning'">正在克隆仓库</span>
      <span v-else-if="session.sourceBinding.state === 'binding'">正在绑定工作区</span>
      <span v-else-if="session.sourceBinding.state === 'awaiting_base_branch'">等待选择基础分支</span>
      <span v-else-if="session.sourceBinding.state === 'awaiting_auth'">等待 GitHub 授权</span>
      <span v-else>仓库准备暂停</span>
    </div>
    <template v-if="session.sourceBinding.state === 'awaiting_auth'">
      <div class="github-source-preparation__actions">
        <el-button :loading="busy" @click="startOAuth">GitHub 授权</el-button>
        <a v-if="authorizationUrl" :href="authorizationUrl" target="_blank" rel="noopener noreferrer">打开 GitHub 授权页</a>
      </div>
      <form class="github-source-preparation__token" @submit.prevent="saveToken">
        <el-input v-model="token" type="password" autocomplete="off" show-password placeholder="GitHub 访问令牌" aria-label="GitHub 访问令牌" />
        <el-button native-type="submit" type="primary" :disabled="!token.trim() || busy">保存授权</el-button>
      </form>
    </template>
    <el-button v-if="session.sourceBinding.state === 'failed' || session.sourceBinding.state === 'blocked'"
      :loading="busy" @click="retry">重试准备</el-button>
    <el-button v-if="session.sourceBinding.state === 'awaiting_base_branch' && !branchDialogVisible"
      @click="loadBranches">选择基础分支</el-button>
    <p v-if="session.sourceBinding.errorCode || error" class="github-source-preparation__error">
      {{ error || session.sourceBinding.errorCode }}
    </p>
  </section>
  <el-dialog v-model="branchDialogVisible" title="选择基础分支" width="min(520px, 94vw)" append-to-body>
    <label class="github-source-preparation__branch">
      <span>仓库分支</span>
      <el-select v-model="selectedBranch" filterable aria-label="仓库基础分支">
        <el-option v-for="branch in branches" :key="branch.name" :label="branch.name" :value="branch.name" />
      </el-select>
    </label>
    <p v-if="error" class="github-source-preparation__error">{{ error }}</p>
    <template #footer>
      <el-button @click="branchDialogVisible = false">稍后选择</el-button>
      <el-button type="primary" :disabled="!selectedBranch" :loading="busy" @click="selectBranch">确认分支</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.github-source-preparation { display: grid; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--el-border-color); background: var(--el-fill-color-light); }
.github-source-preparation__heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.github-source-preparation__heading strong { overflow-wrap: anywhere; }
.github-source-preparation__heading span { color: var(--el-text-color-secondary); }
.github-source-preparation__actions, .github-source-preparation__token { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.github-source-preparation__token :deep(.el-input) { width: min(320px, 100%); }
.github-source-preparation__branch { display: grid; gap: 8px; }
.github-source-preparation__branch :deep(.el-select) { width: 100%; }
.github-source-preparation__error { margin: 0; color: var(--el-color-danger); overflow-wrap: anywhere; }
</style>
