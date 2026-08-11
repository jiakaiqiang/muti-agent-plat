import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { RuntimeModelConfig } from '@/types/contracts'
import { useRuntimeModelStore } from '@/stores/runtimeModel'
import RuntimeModelManager from './RuntimeModelManager.vue'

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('RuntimeModelManager', () => {
  const fetchMock = vi.fn()
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return response({
          error: { message: '无法在本机安全保存 API Key。请确认 Local Runtime 正在运行后重试。' }
        }, 502)
      }
      return response({ data: [], requestId: 'runtime-model-manager-spec' })
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('keeps a failed model request inside the form instead of escalating to the route error boundary', async () => {
    const modelStore = useRuntimeModelStore()
    modelStore.config = {
      provider: 'openai-compatible',
      baseUrl: 'https://default.test/v1',
      currentModelId: 'remote:default',
      currentModel: 'default-model',
      defaultModel: 'default-model',
      currentModelOption: {
        id: 'remote:default',
        label: 'Default model',
        provider: 'openai-compatible',
        source: 'env',
        kind: 'remote',
        credentialLocation: 'server',
        compatibleRuntimeTypes: ['generic_llm', 'codex'],
        model: 'default-model',
        baseUrl: 'https://default.test/v1',
        hasApiKey: true,
        persisted: false
      },
      availableModels: [],
      mockFallbackEnabled: false
    } as RuntimeModelConfig
    modelStore.addMode = 'remote'
    modelStore.remoteModelName = 'test-model'
    modelStore.remoteBaseUrl = 'https://model.test/v1'
    modelStore.remoteApiKey = 'sk-form-value'
    const errorHandler = vi.fn()

    const wrapper = mount(RuntimeModelManager, {
      global: {
        plugins: [pinia],
        config: { errorHandler },
        stubs: { UiIcon: true }
      }
    })
    await nextTick()
    await wrapper.get('[data-testid="add-remote-model"]').trigger('click')
    await flushPromises()

    expect(errorHandler).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('无法在本机安全保存 API Key')
    expect(modelStore.remoteApiKey).toBe('sk-form-value')
  })
})
