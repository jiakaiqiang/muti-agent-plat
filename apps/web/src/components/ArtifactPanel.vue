<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { artifactDownloadUrl } from '@/api/client'
import { useEventStore } from '@/stores/event'
import { useSessionStore } from '@/stores/session'
import type { Artifact } from '@/types/contracts'
import UiIcon from './UiIcon.vue'

const props = defineProps<{ sessionId: string }>()

type ArtifactStage = 'brief' | 'execution' | 'write_preview' | 'written_file' | 'review' | 'delivery' | 'notification' | 'other'

type ArtifactGroup = {
  key: ArtifactStage
  title: string
  description: string
  items: Artifact[]
}

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

const groupMeta: Record<ArtifactStage, { title: string; description: string }> = {
  brief: { title: '任务简报', description: '需求讨论与简报确认阶段产物' },
  execution: { title: '任务执行', description: '各执行任务的结果摘要' },
  write_preview: { title: '待写入预览', description: '文件真正落盘前的 diff 预览' },
  written_file: { title: '已写入文件', description: '已确认并写入会话运行环境目录的文件' },
  review: { title: '复盘评审', description: '一致性检查、测试与复盘结果' },
  delivery: { title: '最终交付', description: '最终交付摘要与汇总说明' },
  notification: { title: '通知草稿', description: '对外通知前的草稿产物' },
  other: { title: '其它产物', description: '未归入标准阶段的补充产物' }
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

function artifactStage(artifact: Artifact): ArtifactStage {
  const metadata = (artifact.metadata ?? {}) as Record<string, unknown>
  const phase = typeof metadata.phase === 'string' ? metadata.phase : undefined
  if (phase === 'brief_generation' || String(artifact.title).startsWith('任务简报')) return 'brief'
  if (phase === 'file_write_proposal' || artifact.type === 'code_diff') return 'write_preview'
  if (phase === 'file_write' || artifact.type === 'file') return 'written_file'
  if (artifact.type === 'feishu_draft') return 'notification'
  if (artifact.type === 'test_report') return 'review'
  if (phase === 'task_execution') return 'execution'
  if (String(artifact.title).includes('最终交付')) return 'delivery'
  return 'other'
}

const groupedArtifacts = computed<ArtifactGroup[]>(() => {
  const order: ArtifactStage[] = ['brief', 'execution', 'write_preview', 'written_file', 'review', 'delivery', 'notification', 'other']
  const groups = new Map<ArtifactStage, Artifact[]>()
  for (const artifact of artifacts.value) {
    const key = artifactStage(artifact)
    groups.set(key, [...(groups.get(key) ?? []), artifact])
  }
  return order
    .filter((key) => (groups.get(key)?.length ?? 0) > 0)
    .map((key) => ({ key, title: groupMeta[key].title, description: groupMeta[key].description, items: groups.get(key) ?? [] }))
})

onMounted(load)
watch(() => props.sessionId, load)
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
    <div v-else class="artifact-groups">
      <section v-for="group in groupedArtifacts" :key="group.key" class="artifact-group">
        <header class="artifact-group__header">
          <div>
            <h3>{{ group.title }}</h3>
            <p>{{ group.description }}</p>
          </div>
          <span class="artifact-group__count">{{ group.items.length }} 个</span>
        </header>
        <ul class="artifact-list">
          <li v-for="artifact in group.items" :key="artifact.id" class="artifact-item">
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
    </div>
  </section>
</template>
