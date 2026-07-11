<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiGet } from '@/api/client'
import { frontendVersion } from '@/config/runtime'
import type { OpsHealth } from '@/types/contracts'

const health = ref<OpsHealth | undefined>()
const loadError = ref(false)

onMounted(async () => {
  try {
    health.value = await apiGet<OpsHealth>('/health')
  } catch {
    loadError.value = true
  }
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
</template>
