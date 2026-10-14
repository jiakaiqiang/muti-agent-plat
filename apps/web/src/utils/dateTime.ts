/** UI-only timestamp formatting. Preserve the viewer's local timezone and source data. */
export function formatDateTime(value?: string | number | Date | null, fallback = '—'): string {
  if (value == null || value === '') return fallback
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return fallback
  const twoDigits = (part: number) => String(part).padStart(2, '0')
  return `${String(date.getFullYear()).padStart(4, '0')}年${twoDigits(date.getMonth() + 1)}月${twoDigits(date.getDate())}日 ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`
}
