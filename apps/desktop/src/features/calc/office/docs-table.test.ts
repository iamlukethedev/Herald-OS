import { describe, expect, it } from 'vitest'
import { documentFromMarkdown } from '../../../../shared/office/doc-text.ts'
import type { DocNode } from '../../../../shared/office/document.ts'
import type { DocumentResult, LineResult } from '../engine/types.ts'
import { docsTable, SHORT_COMMENT, toDocsMarkdown } from './docs-table.ts'

type Line = Omit<LineResult, 'index'>

const note = (lines: Line[], totalDisplay: string | null = null): DocumentResult => ({ lines: lines.map((line, index) => ({ ...line, index })), total: null, totalDisplay, usesRates: false, functions: [] })

const heading = (text: string): Line => ({ kind: 'heading', source: `# ${text}`, label: text })
const comment = (text: string): Line => ({ kind: 'comment', source: `// ${text}`, label: text })
const value = (source: string, display: string): Line => ({ kind: 'value', source, display, value: { kind: 'number', exact: display.replace(/[^\d.-]/g, ''), number: Number(display.replace(/[^\d.-]/g, '')) } })
const failed = (source: string): Line => ({ kind: 'error', source, error: 'A length and a mass don’t add up' })
const blank: Line = { kind: 'blank', source: '' }

/** What Herald Docs reads the Markdown as: each block's type and its text, a table as rows of cells. */
function read(markdown: string): unknown[] {
  const textOf = (node: DocNode): string => (node.text ?? '') + (node.content ?? []).map(textOf).join('')

  return (documentFromMarkdown(markdown).document.content ?? []).map(block =>
    block.type === 'table'
      ? { table: (block.content ?? []).map(tableRow => (tableRow.content ?? []).map(cell => `${cell.type === 'tableHeader' ? 'th' : 'td'}:${textOf(cell)}`)) }
      : { [block.type === 'heading' ? `h${String(block.attrs?.level)}` : block.type]: textOf(block) }
  )
}

describe('a note as a Docs table', () => {
  it('has the note’s name as its title, its calculations in a table and the total in bold last', () => {
    const trip = note([value('Flights: $1,200', '$1,200.00'), value('Hotel: 4 nights × $180', '$720.00')], '$1,920.00')

    expect(toDocsMarkdown(trip, 'Trip')).toBe(
      ['# Trip', '', '| Calculation | Result |', '| --- | ---: |', '| Flights: $1,200 | $1,200.00 |', '| Hotel: 4 nights × $180 | $720.00 |', '| **Total** | **$1,920.00** |', ''].join('\n')
    )
    expect(docsTable(trip, 'Trip').lines).toBe(2)
  })

  it('leaves out the total when the note has none', () => {
    expect(toDocsMarkdown(note([value('2 + 2', '4')]), 'Sums')).not.toContain('Total')
  })

  it('makes each heading a section of its own, with the whole note’s total standing alone at the end', () => {
    const budget = note([value('Rent: 1,200', '1,200'), blank, heading('Food'), value('Dinners: 5 × 60', '300'), heading('Fun'), value('Cinema: 2 × 18', '36')], '1,536')

    expect(read(toDocsMarkdown(budget, 'Budget'))).toEqual([
      { h1: 'Budget' },
      { table: [['th:Calculation', 'th:Result'], ['td:Rent: 1,200', 'td:1,200']] },
      { h2: 'Food' },
      { table: [['th:Calculation', 'th:Result'], ['td:Dinners: 5 × 60', 'td:300']] },
      { h2: 'Fun' },
      { table: [['th:Calculation', 'th:Result'], ['td:Cinema: 2 × 18', 'td:36']] },
      { table: [['th:Total', 'th:1,536']] }
    ])
    expect(docsTable(budget, 'Budget').lines).toBe(5)
  })

  it('takes a first heading that is the note’s name as its title, rather than saying it twice', () => {
    const trip = note([heading('Trip to Japan'), value('Flights', '$1,200')])

    expect(read(toDocsMarkdown(trip, 'trip to japan'))).toEqual([{ h1: 'Trip to Japan' }, { table: [['th:Calculation', 'th:Result'], ['td:Flights', 'td:$1,200']] }])
    expect(docsTable(trip, 'Trip to Japan').lines).toBe(1)
  })

  it('takes the whole of a long first heading the note’s name was cut from', () => {
    const long = 'A rather long heading for the renovation of the kitchen and the bathroom upstairs'
    const markdown = toDocsMarkdown(note([heading(long), value('Tiles', '$800')]), `${long.slice(0, 59)}…`)

    expect(read(markdown).slice(0, 2)).toEqual([{ h1: long }, { table: [['th:Calculation', 'th:Result'], ['td:Tiles', 'td:$800']] }])
  })

  it('shows a line that has no answer with an em dash', () => {
    const markdown = toDocsMarkdown(note([failed('5 km + 3 kg'), { kind: 'value', source: 'x = 3', value: { kind: 'number', exact: '3', number: 3 } }, { kind: 'value', source: 'y = 4' }]), 'Units')

    expect(markdown).toContain('| 5 km + 3 kg | — |')
    expect(markdown).toContain('| x = 3 | 3 |')
    expect(markdown).toContain('| y = 4 | — |')
  })

  it('keeps short comments as quiet lines where they stand, and long ones out', () => {
    const long = 'n'.repeat(SHORT_COMMENT + 1)
    const markdown = toDocsMarkdown(note([comment('Prices from October'), value('Rent', '1,200'), comment(long), comment('Check the bond'), value('Bond', '4,800')]), 'Flat')

    expect(read(markdown)).toEqual([
      { h1: 'Flat' },
      { paragraph: 'Prices from October' },
      { table: [['th:Calculation', 'th:Result'], ['td:Rent', 'td:1,200']] },
      { paragraph: 'Check the bond' },
      { table: [['th:Calculation', 'th:Result'], ['td:Bond', 'td:4,800']] }
    ])
    expect(markdown).toContain('_Prices from October_')
    expect(docsTable(note([comment('Prices from October'), comment(long)]), 'Flat').lines).toBe(1)
  })

  it('leaves out blank lines, functions and plots', () => {
    const markdown = toDocsMarkdown(note([blank, { kind: 'function', source: 'f(x) = x^2' }, { kind: 'plot', source: 'plot f' }, value('f(3)', '9')]), 'Square')

    expect(read(markdown)).toEqual([{ h1: 'Square' }, { table: [['th:Calculation', 'th:Result'], ['td:f(3)', 'td:9']] }])
  })

  it('escapes what Markdown would read as something else, pipes first', () => {
    const tricky = note([heading('Costs | #2'), value('a | b', '1 | 2'), value('5*60*2', '600'), value('x_1 + x_2 [old] <b>', '~3~'), comment('*not* a list: 1. 2. & `code`')], '2 | 3')
    const blocks = read(toDocsMarkdown(tricky, 'Tricky_one *'))

    expect(blocks).toEqual([
      { h1: 'Tricky_one *' },
      { h2: 'Costs | #2' },
      { table: [['th:Calculation', 'th:Result'], ['td:a | b', 'td:1 | 2'], ['td:5*60*2', 'td:600'], ['td:x_1 + x_2 [old] <b>', 'td:~3~'], ['td:Total', 'td:2 | 3']] },
      { paragraph: '*not* a list: 1. 2. & `code`' }
    ])
  })

  it('is the title alone for a note with nothing to show', () => {
    expect(docsTable(note([blank, comment('n'.repeat(SHORT_COMMENT + 5))]), '  ')).toEqual({ markdown: '# Calculations\n', lines: 0 })
  })
})
