<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { artifactDownloadUrl } from '@/api/client'
import { useEventStore } from '@/stores/event'
import { useSessionStore } from '@/stores/session'
import type { Artifact } from '@/types/contracts'
import UiIcon from './UiIcon.vue'

const props = defineProps<{ sessionId: string }>()

const sessionStore = useSessionStore()
const eventStore = useEventStore()

const artifacts = ref<Artifact[]>([])
const loading = ref(false)
const expandedId = ref<string | undefined>()
const detail = ref<Artifact | undefined>()

const artifactTypeLabel: Record<string, string> = {
  text: '文本',
  markdown: 'Markdown',
  json: 'JSON',
  code_diff: '代码改动',
  test_report: '测试报告',
  feishu_draft: '飞书草稿',
  url: '链接',
  file: '文件'
}

async function load() {
  if (!props.sessionId) return
  loading.value = true
  try {
    artifacts.value = await sessionStore.fetchArtifacts(props.sessionId)
  } finally {
    loading.value = false
  }
}

async function toggleDetail(artifact: Artifact) {
  if (expandedId.value === artifact.id) {
    expandedId.value = undefined
    detail.value = undefined
    return
  }
  expandedId.value = artifact.id
  detail.value = await sessionStore.fetchArtifact(artifact.id)
}

function artifactContent(artifact?: Artifact) {
  if (!artifact) return ''
  const metadata = (artifact.metadata ?? {}) as Record<string, unknown>
  if (typeof metadata.content === 'string') return metadata.content as string
  return JSON.stringify(metadata.output ?? metadata, null, 2)
}

onMounted(load)
watch(() => props.sessionId, load)
// 新产物事件到达时刷新列表(写入文件、交付摘要等都会产生 artifact_created)。
watch(
  () => eventStore.eventsForSession(props.sessionId).filter((event) => event.type === 'artifact_created').length,
  load
)
</script>

<template>
  <section class="panel-section artifact-panel">
    <header>
      <h2>产物</h2>
      <span class="artifact-count">{{ artifacts.length }} 个</span>
    </header>
    <p v-if="loading && !artifacts.length" class="empty-state">读取中…</p>
    <p v-else-if="!artifacts.length" class="empty-state">暂无产物。</p>
    <ul v-else class="artifact-list">
      <li v-for="artifact in artifacts" :key="artifact.id" class="artifact-item">
        <div class="artifact-item__head">
          <div class="artifact-item__meta">
            <span class="artifact-item__type" :class="artifact.type">{{ artifactTypeLabel[artifact.type] ?? artifact.type }}</span>
            <strong class="artifact-item__title" :title="artifact.title">{{ artifact.title }}</strong>
          </div>
          <div class="artifact-item__actions">
            <button type="button" class="artifact-item__btn" @click="toggleDetail(artifact)">
              <UiIcon name="eye" :size="14" /> 查看
            </button>
            <a class="artifact-item__btn" :href="artifactDownloadUrl(artifact.id)" target="_blank" rel="noopener">
              <UiIcon name="download" :size="14" /> 下载
            </a>
          </div>
        </div>
        <p v-if="artifact.contentSummary" class="artifact-item__summary">{{ artifact.contentSummary }}</p>
        <pre v-if="expandedId === artifact.id" class="artifact-item__content">{{ artifactContent(detail) }}</pre>
      </li>
    </ul>
  </section>
</template>
