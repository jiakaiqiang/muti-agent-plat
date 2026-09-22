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

function remoteConfig(withPricing = false): RuntimeModelConfig {
  const model = {
    id: 'remote:openai-compatible:server:https-relay-test-v1:test-model',
    label: 'Test relay',
    provider: 'openai-compatible' as const,
    source: 'remote' as const,
    kind: 'remote' as const,
    credentialLocation: 'server' as const,
    compatibleRuntimeTypes: ['generic_llm', 'codex'] as const,
    model: 'test-model',
    baseUrl: 'https://relay.test/v1',
    hasApiKey: true,
    persisted: true,
    ...(withPricing ? {
      pricing: {
        priceVersion: 'relay-v1',
        currency: 'USD' as const,
        inputPerMillion: 0.12,
        outputPerMillion: 0.34
      }
    } : {})
  }
  return {
    provider: 'openai-compatible',
    baseUrl: model.baseUrl,
    currentModelId: model.id,
    currentModel: model.model,
    defaultModel: model.model,
    currentModelOption: model,
    availableModels: [model],
    mockFallbackEnabled: false
  }
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

  it('submits relay input/output pricing together and blocks a partial price', async () => {
    const modelStore = useRuntimeModelStore()
    modelStore.config = remoteConfig()
    modelStore.addMode = 'remote'
    modelStore.remoteModelName = 'priced-model'
    modelStore.remoteBaseUrl = 'https://priced.test/v1'
    modelStore.remoteApiKey = 'sk-form-value'
    modelStore.remoteInputPerMillion = '0.1'
    let submittedBody: Record<string, unknown> | undefined
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        submittedBody = JSON.parse(String(init.body)) as Record<string, unknown>
        return response({ data: remoteConfig(true), requestId: 'runtime-model-manager-spec' })
      }
      return response({ data: [], requestId: 'runtime-model-manager-spec' })
    })

    const wrapper = mount(RuntimeModelManager, {
      global: { plugins: [pinia], stubs: { UiIcon: true } }
    })
    await nextTick()
    expect(wrapper.get('[data-testid="add-remote-model"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="remote-input-price"]').attributes('aria-invalid')).toBe('true')
    expect(wrapper.text()).toContain('输入价格和输出价格需要一起填写')

    await wrapper.get('[data-testid="remote-output-price"]').setValue('0.4')
    modelStore.remotePriceVersion = 'relay-2026-09'
    await nextTick()
    expect(wrapper.get('[data-testid="add-remote-model"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="add-remote-model"]').trigger('click')
    await flushPromises()

    expect(submittedBody).toMatchObject({
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
      priceVersion: 'relay-2026-09'
    })
    expect(submittedBody).toHaveProperty('apiKey', 'sk-form-value')
  })

  it('shows unknown pricing and clears persisted pricing without exposing the API key', async () => {
    const modelStore = useRuntimeModelStore()
    modelStore.config = remoteConfig()
    let submittedBody: Record<string, unknown> | undefined
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        submittedBody = JSON.parse(String(init.body)) as Record<string, unknown>
        return response({ data: remoteConfig(), requestId: 'runtime-model-manager-spec' })
      }
      return response({ data: [], requestId: 'runtime-model-manager-spec' })
    })

    const wrapper = mount(RuntimeModelManager, {
      global: { plugins: [pinia], stubs: { UiIcon: true } }
    })
    await nextTick()
    expect(wrapper.get('[data-testid="pricing-unknown"]').text()).toContain('费用未知')

    modelStore.config = remoteConfig(true)
    await nextTick()
    await wrapper.get('[data-testid="edit-model"]').trigger('click')
    await nextTick()
    expect(wrapper.get('[data-testid="edit-input-price"]').element).toHaveProperty('value', '0.12')
    expect(wrapper.get('[data-testid="edit-output-price"]').element).toHaveProperty('value', '0.34')
    expect(wrapper.get('[data-testid="edit-api-key"]').element).toHaveProperty('value', '')

    await wrapper.get('[data-testid="edit-input-price"]').setValue('')
    await wrapper.get('[data-testid="edit-output-price"]').setValue('')
    await wrapper.get('[data-testid="model-edit-form"]').trigger('submit')
    await flushPromises()

    expect(submittedBody).toMatchObject({ inputPerMillion: null, outputPerMillion: null })
    expect(submittedBody).not.toHaveProperty('apiKey')
  })
})
