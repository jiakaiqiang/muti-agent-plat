import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet } from './client'

describe('API client cancellation handling', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('turns a browser-native abort into the configured timeout error', async () => {
    fetchMock.mockRejectedValue(new DOMException('signal is aborted without reason', 'AbortError'))

    const request = apiGet('/health', {
      timeoutMs: 5_000,
      timeoutMessage: '后端健康检查超时，请确认后端服务已启动后重试。'
    })

    await expect(request).rejects.toThrow('后端健康检查超时')
  })

  it('preserves an abort requested by the caller', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('signal is aborted without reason', 'AbortError'))
        }, { once: true })
      })
    ))

    const request = apiGet('/sessions', {
      signal: controller.signal,
      timeoutMs: 5_000,
      timeoutMessage: 'request timed out'
    })
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not invent a timeout for requests without a timeout policy', async () => {
    fetchMock.mockRejectedValue(new DOMException('signal is aborted without reason', 'AbortError'))

    await expect(apiGet('/events')).rejects.toMatchObject({ name: 'AbortError' })
  })
})
