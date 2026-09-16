<script setup lang="ts">
import { computed, ref } from 'vue'
import { useHistoryDiffStore } from '@/stores/historyDiff'
import { diffLines, splitDiffRows } from '@/utils/historyDiffModel'
const store = useHistoryDiffStore()
const mode = ref('split')
const file = computed(() => store.files.find(item => item.path === store.selectedPath))
const binary = computed(() => (file.value?.before ?? '').includes('\0') || (file.value?.after ?? '').includes('\0'))
const rows = computed(() => file.value?.before !== undefined && file.value?.after !== undefined && !binary.value ? diffLines(file.value.before, file.value.after) : undefined)
const counts = computed(() => ({ add: rows.value?.filter(row => row.kind === 'add').length ?? 0, remove: rows.value?.filter(row => row.kind === 'remove').length ?? 0 }))
const splitRows = computed(() => splitDiffRows(rows.value ?? []))
</script>
<template>
  <el-dialog v-model="store.visible" :title="store.title || '文件修改'" width="92vw" top="5vh" class="history-diff-dialog" destroy-on-close :close-on-click-modal="false" @close="store.close()">
    <p class="diff-source">{{ store.source }}</p>
    <div class="diff-toolbar"><el-radio-group v-model="mode" aria-label="对比布局"><el-radio-button value="split">左右对比</el-radio-button><el-radio-button value="unified">行内对比</el-radio-button></el-radio-group><span v-if="rows">+{{ counts.add }} / −{{ counts.remove }}</span><span>只读</span></div>
    <div class="diff-layout"><nav aria-label="变更文件"><button v-for="item in store.files" :key="item.path" type="button" :class="{ selected: item.path === store.selectedPath }" @click="store.selectedPath = item.path">{{ item.previousPath ? `${item.previousPath} → ` : '' }}{{ item.path }}</button><p v-if="!store.files.length">没有可用的文件变更记录</p></nav>
      <main v-if="file"><h3>{{ file.path }}</h3><el-alert v-if="file.notice" :title="file.notice" type="info" :closable="false" />
        <p v-if="binary">二进制文件不支持文本对比。</p>
        <template v-else-if="rows">
          <p v-if="counts.add === 0 && counts.remove === 0">内容无变化{{ file.operation === 'create' ? '（新增空文件）' : file.operation === 'delete' ? '（删除空文件）' : '' }}</p>
          <section v-if="mode === 'split'"><div class="diff-columns"><h4>修改前</h4><h4>修改后</h4></div><div v-for="(row,index) in splitRows" :key="index" class="diff-columns"><div :class="['diff-row', row.left?.kind ?? 'equal']"><small>{{ row.left?.before }}</small><pre>{{ row.left ? `${row.left.kind === 'remove' ? '−' : ' '} ${row.left.text}` : '' }}</pre></div><div :class="['diff-row', row.right?.kind ?? 'equal']"><small>{{ row.right?.after }}</small><pre>{{ row.right ? `${row.right.kind === 'add' ? '+' : ' '} ${row.right.text}` : '' }}</pre></div></div></section>
          <section v-else><div v-for="(row,index) in rows" :key="index" :class="['diff-row',row.kind]"><small>{{ row.before }}</small><small>{{ row.after }}</small><pre>{{ row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' ' }} {{ row.text }}</pre></div></section>
        </template>
        <template v-else><p>{{ file.before !== undefined && file.after !== undefined ? '文件超过对比显示上限，未生成或伪造截断 Diff。' : '历史两端不完整，以下为已保存内容。' }}</p><pre class="saved-content">{{ (file.after ?? file.before ?? '内容不可用').slice(0, 100000) }}</pre><p v-if="(file.after ?? file.before ?? '').length > 100000">仅预览前 100,000 个字符。</p></template>
      </main>
    </div>
  </el-dialog>
</template>
<style scoped>
.diff-source { color: #606266; overflow-wrap: anywhere; }.diff-toolbar { display: flex; gap: 16px; align-items: center; margin-bottom: 12px; }.diff-layout { display: grid; grid-template-columns: 220px minmax(0,1fr); height: 65vh; border: 1px solid #e4e7ed; }nav { padding: 8px; overflow: auto; border-right: 1px solid #e4e7ed; }nav button { display:block; padding:10px; width:100%; text-align:left; overflow-wrap:anywhere; border:0; background:white; cursor:pointer; }nav button.selected { background:#ecf5ff; color:#245d96; }main { overflow:auto; min-width:0; }h3,h4 { padding:8px 12px; margin:0; background:#f5f7fa; font-size:13px; }.diff-columns { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); }.diff-columns>section { overflow:auto; border-right:1px solid #e4e7ed; }.diff-row { display:flex; min-height:21px; font:12px/21px Consolas,monospace; }.diff-row small { flex:0 0 40px; text-align:right; padding-right:8px; color:#606266; user-select:none; }.diff-row pre { margin:0; font:inherit; white-space:pre; }.diff-row.add { background:#e6ffec; color:#164b28; }.diff-row.remove { background:#ffebe9; color:#7d2020; }.saved-content { padding:12px; white-space:pre-wrap; overflow-wrap:anywhere; }@media(max-width:720px){.diff-layout{grid-template-columns:130px minmax(0,1fr)}}
</style>
