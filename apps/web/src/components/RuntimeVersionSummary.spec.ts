import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import RuntimeVersionSummary from './RuntimeVersionSummary.vue'

function apiResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(status >= 400 ? { error: data } : { data, requestId: 'runtime-version-spec' }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function requestPath(input: RequestInfo | URL) {
  if (typeof input === 'string') return new URL(input).pathname
  if (input instanceof URL) return input.pathname
  return new URL(input.url).pathname
}

describe('RuntimeVersionSummary', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('显示前端版本和后端 health 返回的运行版本', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (requestPath(input) === '/api/health') {
        return apiResponse({
          status: 'ok',
          service: 'agent-cluster-server',
          version: '0.1.0',
          buildTime: '2026-07-11T02:00:00.000Z',
          commit: 'abc1234',
          pipelineVersion: 'v2',
          defaultContextPipelineVersion: 'v1',
          contextPipelineVersion: 'v2',
          contextPipelineV2Enabled: true,
          supportedContextPipelineVersions: ['v1', 'v2'],
          timestamp: '2026-07-11T02:01:00.000Z'
        })
      }
      return apiResponse({ message: 'Unexpected request' }, 500)
    })

    const wrapper = mount(RuntimeVersionSummary)
    await flushPromises()

    expect(wrapper.text()).toContain('前端版本')
    expect(wrapper.text()).toContain('0.1.0')
    expect(wrapper.text()).toContain('后端版本')
    expect(wrapper.text()).toContain('abc1234')
    expect(wrapper.text()).toContain('v2')
  })
})
