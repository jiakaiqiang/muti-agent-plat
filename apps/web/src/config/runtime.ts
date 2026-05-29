const enabledValues = new Set(['1', 'true', 'yes', 'on'])

function isEnabled(value: unknown) {
  return enabledValues.has(String(value ?? '').trim().toLowerCase())
}

export const mockFallbackEnabled = isEnabled(import.meta.env.VITE_ENABLE_MOCKS)
