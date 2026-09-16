import type { WorkspaceChange } from '@agent-cluster/shared'

export type HistoricalFile = {
  path: string
  previousPath?: string
  operation: WorkspaceChange['operation'] | 'reference'
  before?: string
  after?: string
  notice?: string
}
export type DiffLine = { kind: 'equal' | 'add' | 'remove'; text: string; before?: number; after?: number }
export function splitDiffRows(lines: DiffLine[]) {
  const result: Array<{ left?: DiffLine; right?: DiffLine }> = []
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === 'equal') { result.push({ left: lines[i], right: lines[i] }); i++; continue }
    const removed: DiffLine[] = []; const added: DiffLine[] = []
    while (i < lines.length && lines[i].kind !== 'equal') {
      const line = lines[i++]; (line.kind === 'remove' ? removed : added).push(line)
    }
    for (let j = 0; j < Math.max(removed.length, added.length); j++) result.push({ left: removed[j], right: added[j] })
  }
  return result
}
export function filesFromChanges(changes: WorkspaceChange[]): HistoricalFile[] {
  return changes.map(change => {
    if (change.operation === 'move') return { path: change.toPath, previousPath: change.fromPath, operation: 'move', notice: '已记录重命名；此历史证据未保存文件内容。' }
    const before = change.operation === 'create' ? '' : change.baseContent
    const after = change.operation === 'delete' ? '' : change.content
    return { path: change.path, operation: change.operation, before, after, ...(before === undefined ? { notice: '此轮未保存修改前内容，仅可查看已保存的目标内容。' } : {}) }
  })
}

/** Bounded LCS; never use a workspace's current content as a historical baseline. */
export function diffLines(before: string, after: string): DiffLine[] | undefined {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  if (a.length * b.length > 2_000_000 || a.length + b.length > 12_000 || before.length + after.length > 1_000_000) return undefined
  const width = b.length + 1
  const matrix = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    matrix[i * width + j] = a[i] === b[j] ? 1 + matrix[(i + 1) * width + j + 1] : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1])
  }
  const rows: DiffLine[] = []
  let i = 0; let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ kind: 'equal', text: a[i], before: ++i, after: ++j }) }
    else if (i < a.length && (j === b.length || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) { rows.push({ kind: 'remove', text: a[i], before: ++i }) }
    else { rows.push({ kind: 'add', text: b[j], after: ++j }) }
  }
  return rows
}
