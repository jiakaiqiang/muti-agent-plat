import { describe, expect, it } from 'vitest'
import { diffLines, filesFromChanges, splitDiffRows } from '@/utils/historyDiffModel'

describe('historical file comparisons', () => {
  it('aligns replacements side by side without losing surplus deleted lines', () => {
    const rows = splitDiffRows(diffLines('old\nremoved\nkeep', 'new\nkeep')!)
    expect(rows.map(row => [row.left?.text, row.right?.text])).toEqual([['old', 'new'], ['removed', undefined], ['keep', 'keep']])
    expect(rows[2]).toMatchObject({ left: { before: 3 }, right: { after: 2 } })
  })
  it('keeps unchanged middle lines and both original line numbers', () => {
    const rows = diffLines('old\nkeep\nold2', 'new\nkeep\nnew2')!
    expect(rows.find(row => row.text === 'keep')).toEqual({ kind: 'equal', text: 'keep', before: 2, after: 2 })
    expect(rows.filter(row => row.kind === 'add').map(row => row.text)).toEqual(['new', 'new2'])
    expect(rows.filter(row => row.kind === 'remove').map(row => row.text)).toEqual(['old', 'old2'])
  })
  it('distinguishes a missing baseline from an empty file and never uses local content', () => {
    const files = filesFromChanges([
      { operation: 'update', path: 'a', content: 'after', encoding: 'utf-8', expectedHash: { algorithm: 'sha256', value: 'hash' } },
      { operation: 'delete', path: 'empty', baseContent: '', expectedHash: { algorithm: 'sha256', value: 'hash' } },
      { operation: 'move', fromPath: 'old', toPath: 'new', expectedHash: { algorithm: 'sha256', value: 'hash' } }
    ])
    expect(files[0].before).toBeUndefined()
    expect(files[0].notice).toContain('未保存')
    expect(files[1]).toMatchObject({ before: '', after: '' })
    expect(files[2]).toMatchObject({ previousPath: 'old', path: 'new' })
  })
  it('preserves trailing newline changes and handles empty files', () => {
    expect(diffLines('', '')).toEqual([])
    expect(diffLines('line', 'line\n')?.at(-1)).toMatchObject({ kind: 'add', text: '', after: 2 })
    expect(diffLines('one', '')).toEqual([{ kind: 'remove', text: 'one', before: 1 }])
  })
  it('bounds expensive comparisons instead of silently truncating', () => {
    expect(diffLines('a\n'.repeat(2000), 'b\n'.repeat(2000))).toBeUndefined()
  })
})
