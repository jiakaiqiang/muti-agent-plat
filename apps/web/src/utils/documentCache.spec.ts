import { describe, expect, it } from 'vitest'
import { DocumentCache } from './documentCache'
describe('rebuildable document cache', () => {
  it('keeps version keys distinct and evicts by byte/session budget', () => {
    const cache = new DocumentCache(9, 2)
    cache.set('A:v1', 'A', '中文')
    cache.set('A:v2', 'A', 'new')
    expect(cache.get('A:v1')).toBe('中文')
    cache.set('B:v1', 'B', 'next')
    expect(cache.bytes).toBeLessThanOrEqual(9)
    cache.set('C:v1', 'C', 'c')
    expect(cache.get('A:v1')).toBeUndefined()
    expect(cache.get('C:v1')).toBe('c')
  })
})
