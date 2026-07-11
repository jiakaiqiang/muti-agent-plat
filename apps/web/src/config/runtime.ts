const enabledValues = new Set(['1', 'true', 'yes', 'on'])

function isEnabled(value: unknown) {
  return enabledValues.has(String(value ?? '').trim().toLowerCase())
}

export const mockFallbackEnabled = isEnabled(import.meta.env.VITE_ENABLE_MOCKS)
export const frontendVersion = import.meta.env.VITE_APP_VERSION ?? '0.1.0'
export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3000/api').replace(/\/$/, '')
export const sseBaseUrl = (import.meta.env.VITE_SSE_BASE_URL ?? apiBaseUrl).replace(/\/$/, '')
export const runtimeModeLabel = mockFallbackEnabled ? 'mock' : 'real'
