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

export async function apiPatch<T>(path: string, body?: unknown) {
  return (
    await request<T>(path, {
      method: 'PATCH',
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
