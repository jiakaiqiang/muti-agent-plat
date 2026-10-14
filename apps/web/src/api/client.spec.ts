import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet, apiGetText, apiPostMultipart, ApiRequestError, isSessionNotFoundError } from './client'

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

  it.each([apiGet, apiGetText])('shows Chinese network errors for JSON and Markdown requests', async (get) => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(get('/health')).rejects.toThrow('连接服务失败')
    await expect(get('/health')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 })
  })

  it('recognises missing sessions by stable code, not translated text or unrelated 404 errors', () => {
    expect(isSessionNotFoundError(new ApiRequestError('会话不存在。', 404, 'SESSION_NOT_FOUND'))).toBe(true)
    expect(isSessionNotFoundError(new ApiRequestError('产物不存在。', 404, 'ARTIFACT_NOT_FOUND'))).toBe(false)
    expect(isSessionNotFoundError(new Error('Session not found: old-backend'))).toBe(true)
  })

  it.each([apiGet, apiGetText])('localises legacy API errors without losing machine code or details', async (get) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: {
      message: 'GITHUB_APP_OAUTH_NOT_CONFIGURED',
      code: 'GITHUB_APP_OAUTH_NOT_CONFIGURED',
      details: { retryable: false }
    } }), { status: 500 }))
    await expect(get('/authorize')).rejects.toMatchObject({
      name: 'ApiRequestError', message: expect.stringContaining('平台尚未配置 GitHub App 授权'),
      code: 'GITHUB_APP_OAUTH_NOT_CONFIGURED', status: 500, details: { retryable: false }
    })
  })

  it('preserves Chinese validation details and an intentional cancellation of Markdown fetch', async () => {
    fetchMock.mockRejectedValue(new ApiRequestError('请补充问题回答。', 409, 'brief_has_open_questions', { questions: ['目标是什么？'] }))
    await expect(apiGetText('/brief')).rejects.toMatchObject({ message: '请补充问题回答。', details: { questions: ['目标是什么？'] } })
    const controller = new AbortController()
    controller.abort()
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'))
    await expect(apiGetText('/brief', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
