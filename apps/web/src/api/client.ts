import type { CollaborationEvent } from '@/types/contracts'

type ApiResponse<T> = {
  data: T
  requestId: string
}

type PageResponse<T> = {
  items: T[]
  hasMore: boolean
  nextCursor?: string
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3000/api').replace(/\/$/, '')
const sseBaseUrl = (import.meta.env.VITE_SSE_BASE_URL ?? apiBaseUrl).replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {})
    },
    ...init
  })

  if (!response.ok) {
    const body = await response.json().catch(() => undefined)
    const message = body?.error?.message ?? `${init?.method ?? 'GET'} ${path} failed: ${response.status}`
    throw new Error(message)
  }

  return (await response.json()) as ApiResponse<T>
}

export async function apiGet<T>(path: string) {
  return (await request<T>(path)).data
}

export async function apiPost<T>(path: string, body?: unknown) {
  return (
    await request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  ).data
}

export async function apiPage<T>(path: string) {
  return apiGet<PageResponse<T>>(path)
}

export function eventStreamUrl(sessionId: string) {
  return `${sseBaseUrl}/sessions/${sessionId}/events/stream`
}

export function parseSseEvent(message: MessageEvent) {
  return JSON.parse(message.data) as CollaborationEvent
}
