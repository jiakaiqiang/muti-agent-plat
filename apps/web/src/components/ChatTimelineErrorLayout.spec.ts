import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

function declarationsFor(selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return styles.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}

describe('ChatTimeline long error layout', () => {
  it('allows the message hierarchy to shrink within the timeline', () => {
    expect(declarationsFor('.timeline-item')).toContain('min-width: 0')
    expect(declarationsFor('.message-bubble')).toContain('min-width: 0')
    expect(declarationsFor('.structured-block')).toContain('min-width: 0')
  })

  it('wraps long error fields and preformatted error output', () => {
    const errorFieldStyles = declarationsFor('.structured-block dd')
    const errorStackStyles = declarationsFor('.error-stack')

    expect(errorFieldStyles).toContain('overflow-wrap: anywhere')
    expect(errorFieldStyles).toContain('word-break: break-word')
    expect(errorStackStyles).toContain('white-space: pre-wrap')
    expect(errorStackStyles).toContain('overflow-wrap: anywhere')
    expect(errorStackStyles).toContain('word-break: break-word')
    expect(errorStackStyles).toContain('overflow-x: hidden')
  })
})
