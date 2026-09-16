import type { CollaborationEvent } from '@/types/contracts'
import { apiBaseUrl, sseBaseUrl } from '@/config/runtime'

type ApiResponse<T> = {
  data: T
  requestId: string
}

type PageResponse<T> = {
  items: T[]
  hasMore: boolean
  nextCursor?: string
}

type ApiRequestInit = RequestInit & {
  timeoutMs?: number
  timeoutMessage?: string
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

export function isAbortError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown }
  return candidate.name === 'AbortError' ||
    candidate.name === 'CanceledError' ||
    candidate.code === 'ABORT_ERR' ||
    (typeof candidate.message === 'string' && /signal is aborted without reason/i.test(candidate.message))
}

async function request<T>(path: string, init?: ApiRequestInit) {
  const { timeoutMs, timeoutMessage, ...requestInit } = init ?? {}
  const resolvedTimeoutMs = timeoutMs && timeoutMs > 0 ? timeoutMs : undefined
  const resolvedTimeoutMessage =
    timeoutMessage ?? `${requestInit.method ?? 'GET'} ${path} timed out after ${timeoutMs}ms`
  const timeoutController = resolvedTimeoutMs ? new AbortController() : undefined
  const upstreamSignal = requestInit.signal
  const forwardAbort = () => timeoutController?.abort(upstreamSignal?.reason)
  if (timeoutController && upstreamSignal) {
    if (upstreamSignal.aborted) forwardAbort()
    else upstreamSignal.addEventListener('abort', forwardAbort, { once: true })
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const responsePromise = fetch(`${apiBaseUrl}${path}`, {
    ...requestInit,
    signal: timeoutController?.signal ?? upstreamSignal,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(requestInit.headers ?? {})
    }
  })

  let response: Response
  try {
    response = timeoutController
      ? await Promise.race([
          responsePromise,
          new Promise<Response>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              const timeoutError = new Error(resolvedTimeoutMessage)
              timeoutController.abort(timeoutError)
              reject(timeoutError)
            }, resolvedTimeoutMs)
          })
        ])
      : await responsePromise
  } catch (error) {
    // Browsers may reject fetch with their own AbortError before the timeout
    // race settles. Do not leak that implementation detail to the UI.
    if (timeoutController && isAbortError(error) && !upstreamSignal?.aborted) {
      throw new Error(resolvedTimeoutMessage)
    }
    throw error
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    upstreamSignal?.removeEventListener('abort', forwardAbort)
  }

  if (!response.ok) {
    const body = await response.json().catch(() => undefined)
    const message = body?.error?.message ?? `${requestInit.method ?? 'GET'} ${path} failed: ${response.status}`
    throw new ApiRequestError(message, response.status, body?.error?.code, body?.error?.details)
  }

  return (await response.json()) as ApiResponse<T>
}

export async function apiGet<T>(path: string, init?: ApiRequestInit) {
  return (await request<T>(path, init)).data
}

export async function apiPost<T>(path: string, body?: unknown, init?: ApiRequestInit) {
  return (
    await request<T>(path, {
      ...init,
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: init?.headers
    })
  ).data
}

export async function apiPut<T>(path: string, body?: unknown, init?: ApiRequestInit) {
  return (
    await request<T>(path, {
      ...init,
      method: 'PUT',
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: init?.headers
    })
  ).data
}

export async function apiPatch<T>(path: string, body?: unknown, init?: ApiRequestInit) {
  return (
    await request<T>(path, {
      ...init,
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  ).data
}

export async function apiDelete<T>(path: string, init?: ApiRequestInit) {
  return (
    await request<T>(path, {
      ...init,
      method: 'DELETE'
    })
  ).data
}

export async function apiPage<T>(path: string, init?: ApiRequestInit) {
  return apiGet<PageResponse<T>>(path, init)
}

export function eventStreamUrl(sessionId: string) {
  return `${sseBaseUrl}/sessions/${sessionId}/events/stream`
}

export function parseSseEvent(message: MessageEvent) {
  return JSON.parse(message.data) as CollaborationEvent
}
