import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet, apiGetText, apiPostMultipart } from './client'

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

  it('reads a Markdown response without requiring the JSON API envelope', async () => {
    fetchMock.mockResolvedValue(new Response('# plan\n', {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' }
    }))

    await expect(apiGetText('/sessions/session-1/discussion-documents/document-1/content')).resolves.toBe('# plan\n')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/sessions/session-1/discussion-documents/document-1/content'),
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ accept: 'text/markdown' }) })
    )
  })

  it('does not duplicate the API prefix when a published event supplies an absolute API path', async () => {
    fetchMock.mockResolvedValue(new Response('# plan\n', { status: 200 }))
    await apiGetText('/api/sessions/session-1/discussion-documents/document-1/content')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/session-1/discussion-documents/document-1/content')
  })

  it('sends multipart uploads without overriding the browser boundary header', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { accepted: 1 }, requestId: 'request-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
    const form = new FormData()
    form.append('file', new Blob(['bytes'], { type: 'text/plain' }), 'notes.txt')

    await expect(apiPostMultipart('/sessions/session-1/attachments', form)).resolves.toEqual({ accepted: 1 })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBe(form)
    expect(init.headers).not.toHaveProperty('content-type')
  })
})
