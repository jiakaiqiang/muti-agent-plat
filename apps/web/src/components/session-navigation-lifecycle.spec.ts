import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, onMounted, onUnmounted } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import AppShell from './AppShell.vue'
import { useAgentStore } from '@/stores/agent'
import { useLocalRuntimeStore } from '@/stores/localRuntime'

describe('workspace route identity', () => {
  it('reuses the workspace across session/query/history navigation, but isolates management views', async () => {
    const pinia = createPinia(); setActivePinia(pinia)
    vi.spyOn(useAgentStore(), 'loadAgents').mockResolvedValue()
    vi.spyOn(useLocalRuntimeStore(), 'loadDevices').mockResolvedValue([])
    vi.spyOn(useLocalRuntimeStore(), 'resolveLaunchServerUrl').mockResolvedValue('')
    const mounted = vi.fn(); const unmounted = vi.fn()
    const view = defineComponent({ setup() {
      onMounted(mounted); onUnmounted(unmounted)
      return () => h('div', 'workspace fixture')
    } })
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/workspace/:sessionId', component: view, meta: { section: 'session' } },
      { path: '/agents', component: view, meta: { section: 'agents' } },
      { path: '/skills', component: view, meta: { section: 'skills' } }
    ] })
    await router.push('/workspace/A'); await router.isReady()
    const wrapper = mount(AppShell, { global: { plugins: [pinia, router], stubs: { RuntimeUpgradeDialog: true } } })
    await flushPromises()
    await router.push('/workspace/B'); await flushPromises()
    await router.push('/workspace/B?view=workflow'); await flushPromises()
    router.back(); await flushPromises()
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
    await router.push('/agents'); await flushPromises()
    await router.push('/skills'); await flushPromises()
    expect(mounted).toHaveBeenCalledTimes(3)
    expect(unmounted).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
})
