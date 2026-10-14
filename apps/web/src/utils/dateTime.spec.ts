import { describe, expect, it } from 'vitest'
import { formatDateTime } from './dateTime'

describe('formatDateTime', () => {
  it('uses the exact Chinese date and 24-hour time format', () => {
    expect(formatDateTime(new Date(2026, 8, 29, 15, 4, 5))).toBe('2026年09月29日 15:04:05')
  })

  it('zero-pads single-digit months, dates, hours, minutes and seconds', () => {
    expect(formatDateTime(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026年01月02日 03:04:05')
    expect(formatDateTime(new Date(2026, 0, 2, 0, 0, 0))).toBe('2026年01月02日 00:00:00')
  })

  it('formats ISO and offset timestamps in local time without mutating the input', () => {
    const date = new Date(2026, 8, 29, 15, 4, 5)
    const epoch = date.getTime()
    expect(formatDateTime(date.toISOString())).toBe('2026年09月29日 15:04:05')
    expect(formatDateTime(epoch)).toBe('2026年09月29日 15:04:05')
    expect(formatDateTime('2026-09-29T15:04:05+08:00')).toBe(formatDateTime('2026-09-29T07:04:05Z'))
    formatDateTime(date)
    expect(date.getTime()).toBe(epoch)
  })

  it('retains leap days and year boundaries', () => {
    expect(formatDateTime(new Date(2024, 1, 29, 23, 59, 59))).toBe('2024年02月29日 23:59:59')
    expect(formatDateTime(new Date(2027, 0, 1, 0, 0, 0))).toBe('2027年01月01日 00:00:00')
  })

  it('uses safe fallback text for missing or invalid values', () => {
    for (const value of [undefined, null, '', 'invalid', new Date(Number.NaN), Number.NaN]) {
      expect(formatDateTime(value)).toBe('—')
      expect(formatDateTime(value, '暂无记录')).toBe('暂无记录')
    }
    expect(formatDateTime(0)).toMatch(/^\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}:\d{2}$/)
  })
})
