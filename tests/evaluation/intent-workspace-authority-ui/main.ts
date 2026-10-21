import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import IntentWorkspaceAuthorityPanel from '../../../apps/web/src/components/IntentWorkspaceAuthorityPanel.vue'
const { data: session } = await (await fetch('/fixture-session')).json()
document.body.style.cssText = 'margin:0;background:#f5f7fa;font:14px system-ui;color:#303133;'
createApp({ render: () => h('main', { style: 'max-width:900px;margin:32px auto;background:white;' }, [
  h('h1', { style: 'padding:16px;font-size:20px;' }, '工作区读取授权验证'),
  h('p', { style: 'padding:0 16px;' }, '共享产品组件 · 隔离真实 API · 临时工作区'),
  h(IntentWorkspaceAuthorityPanel, { session })
]) }).use(createPinia()).mount('#app')
