<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { frontendVersion } from '@/config/runtime'
import { useSessionStore } from '@/stores/session'

const sessionStore = useSessionStore()
const { runtimeHealth: health } = storeToRefs(sessionStore)
const loadError = computed(() => Boolean(sessionStore.runtimeHealthError && !health.value))

onMounted(async () => {
  try {
    await sessionStore.loadRuntimeHealth(true)
  } catch {}
})
</script>

<template>
  <div data-testid="runtime-frontend-version">
    <dt>前端版本</dt>
    <dd>{{ frontendVersion }}</dd>
  </div>
  <div data-testid="runtime-backend-version">
    <dt>后端版本</dt>
    <dd>{{ health?.version ?? (loadError ? '未连接' : '加载中') }}</dd>
  </div>
  <div>
    <dt>构建时间</dt>
    <dd>{{ health?.buildTime ?? '-' }}</dd>
  </div>
  <div>
    <dt>Commit</dt>
    <dd>{{ health?.commit ?? '-' }}</dd>
  </div>
  <div>
    <dt>Pipeline</dt>
    <dd>{{ health?.pipelineVersion ?? '-' }}</dd>
  </div>
  <div>
    <dt>Schema / Epoch</dt>
    <dd>{{ health ? `${health.dataSchemaVersion} / ${health.dataEpoch}` : '-' }}</dd>
  </div>
  <div>
    <dt>进程 / 启动时间</dt>
    <dd>{{ health ? `${health.processId} / ${health.startedAt}` : '-' }}</dd>
  </div>
  <div>
    <dt>持久化位置</dt>
    <dd>{{ health ? `${health.persistenceBackend}: ${health.persistenceLocation}` : '-' }}</dd>
  </div>
</template>
