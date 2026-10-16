import { describe, expect, it } from 'vitest'
import type { LineResult } from '../engine/types.ts'
import { alignResults, displayParts, lineAt, lineEnd, lineStart, plainKind, resultCell, rowBoxes, segments, SIDEBAR_INLINE_PX, sidebarShown, splitLines } from './layout.ts'

const value = (index: number, source: string, display: string, extra: Partial<LineResult> = {}): LineResult => ({ index, kind: 'value', source, display, tokens: [{ from: 0, to: 1, type: 'number' }], ...extra })

describe('lines and offsets', () => {
  const text = 'a = 1\nb = 2\n\nsum'

  it('splits as the textarea shows them, a trailing newline making an empty last line', () => {
    expect(splitLines(text)).toEqual(['a = 1', 'b = 2', '', 'sum'])
    expect(splitLines('x\n')).toEqual(['x', ''])
    expect(splitLines('')).toEqual([''])
  })

  it('finds the line an offset is on, clamped to the text', () => {
    expect(lineAt(text, 0)).toBe(0)
    expect(lineAt(text, 5)).toBe(0)
    expect(lineAt(text, 6)).toBe(1)
    expect(lineAt(text, 12)).toBe(2)
    expect(lineAt(text, 999)).toBe(3)
    expect(lineAt(text, -4)).toBe(0)
  })

  it('finds where lines start and end', () => {
    expect(lineStart(text, 1)).toBe(6)
    expect(lineEnd(text, 1)).toBe(11)
    expect(lineStart(text, 2)).toBe(12)
    expect(lineEnd(text, 2)).toBe(12)
    expect(lineEnd(text, 3)).toBe(text.length)
    expect(lineStart(text, 9)).toBe(text.length)
  })
})

describe('alignResults', () => {
  const before = [value(0, '1 + 1', '2'), value(1, '2 + 2', '4'), value(2, '3 + 3', '6')]

  it('waits for the engine when there is no answer yet', () => {
    expect(alignResults(['1 + 1'], null)).toEqual([{ result: null, tokens: [], fresh: false }])
  })

  it('keeps every result while the lines are the same', () => {
    const views = alignResults(['1 + 1', '2 + 2', '3 + 3'], before)

    expect(views.map(view => [view.result?.display, view.fresh])).toEqual([
      ['2', true],
      ['4', true],
      ['6', true]
    ])
  })

  it('moves the results under an added line down with their lines', () => {
    const views = alignResults(['1 + 1', 'new', '2 + 2', '3 + 3'], before)

    expect(views.map(view => view.result?.display ?? null)).toEqual(['2', null, '4', '6'])
    expect(views[2].fresh).toBe(true)
  })

  it('moves them up when a line goes', () => {
    expect(alignResults(['1 + 1', '3 + 3'], before).map(view => view.result?.display ?? null)).toEqual(['2', '6'])
  })

  it('keeps an edited line its old result until the new one comes, and its colours only while typed at its end', () => {
    const typed = alignResults(['1 + 1', '2 + 25', '3 + 3'], before)

    expect(typed[1]).toMatchObject({ fresh: false, tokens: before[1].tokens })
    expect(typed[1].result?.display).toBe('4')

    const erased = alignResults(['1 + 1', '2 +', '3 + 3'], before)

    expect(erased[1].tokens).toBe(before[1].tokens)

    const rewritten = alignResults(['1 + 1', '9 + 2', '3 + 3'], before)

    expect(rewritten[1]).toMatchObject({ fresh: false, tokens: [] })
  })

  it('waits for the engine on lines pasted in the middle', () => {
    const views = alignResults(['1 + 1', 'a', 'b', 'c', '3 + 3'], before)

    expect(views.map(view => view.result?.display ?? null)).toEqual(['2', null, null, null, '6'])
  })

  it('never matches one line against itself from both ends', () => {
    const repeated = [value(0, 'sum', '1'), value(1, 'sum', '2')]

    expect(alignResults(['sum'], repeated).map(view => view.result?.display)).toEqual(['1'])
  })
})

describe('segments', () => {
  it('cuts a line into coloured runs with plain text between them', () => {
    expect(
      segments('20% of 84.50', [
        { from: 0, to: 3, type: 'number' },
        { from: 4, to: 6, type: 'keyword' },
        { from: 7, to: 12, type: 'number' }
      ])
    ).toEqual([
      { text: '20%', type: 'number' },
      { text: ' ', type: null },
      { text: 'of', type: 'keyword' },
      { text: ' ', type: null },
      { text: '84.50', type: 'number' }
    ])
  })

  it('sorts tokens, drops overlaps and clips to the line as it is now', () => {
    expect(
      segments('5 km', [
        { from: 2, to: 9, type: 'unit' },
        { from: 0, to: 1, type: 'number' },
        { from: 0, to: 3, type: 'variable' }
      ])
    ).toEqual([
      { text: '5', type: 'number' },
      { text: ' ', type: null },
      { text: 'km', type: 'unit' }
    ])
  })

  it('leaves a line without tokens plain, and an empty one empty', () => {
    expect(segments('hello', [])).toEqual([{ text: 'hello', type: null }])
    expect(segments('', [{ from: 0, to: 2, type: 'number' }])).toEqual([])
  })
})

describe('plainKind', () => {
  it('knows headings and comments by their first characters', () => {
    expect(plainKind('## Units')).toBe('heading')
    expect(plainKind('  // a note')).toBe('comment')
    expect(plainKind('5 # 3')).toBeNull()
  })
})

describe('rowBoxes', () => {
  it('puts each result on the first row of its line, spanning its wrapped rows', () => {
    expect(rowBoxes(3, { tops: [16, 42, 94], end: 120 }, 26, 16)).toEqual([
      { top: 16, height: 26 },
      { top: 42, height: 52 },
      { top: 94, height: 26 }
    ])
  })

  it('gives every line one row until a measure fits these lines', () => {
    const uniform = [
      { top: 16, height: 26 },
      { top: 42, height: 26 }
    ]

    expect(rowBoxes(2, null, 26, 16)).toEqual(uniform)
    expect(rowBoxes(2, { tops: [16, 42, 68], end: 94 }, 26, 16)).toEqual(uniform)
    expect(rowBoxes(2, { tops: [0, 0], end: 0 }, 26, 16)).toEqual(uniform)
    expect(rowBoxes(2, { tops: [42, 16], end: 94 }, 26, 16)).toEqual(uniform)
  })

  it('never makes a row shorter than one line', () => {
    expect(rowBoxes(2, { tops: [16, 30], end: 40 }, 26, 16).map(box => box.height)).toEqual([26, 26])
  })
})

describe('resultCell', () => {
  const fresh = (result: LineResult) => ({ result, tokens: result.tokens ?? [], fresh: true })

  it('shows a value with its unit apart', () => {
    expect(resultCell(fresh(value(0, '5 km in miles', '3.11 mi', { value: { kind: 'unit', exact: '3.11', number: 3.11, unit: 'mi' } })), false)).toEqual({ kind: 'value', display: '3.11 mi', value: '3.11', unit: ' mi' })
  })

  it('marks lines that draw', () => {
    expect(resultCell(fresh({ index: 0, kind: 'function', source: 'y = x', plot: { name: 'y', expression: 'x', variable: 'x', index: 0 } }), false)).toEqual({ kind: 'graph' })
    expect(resultCell(fresh({ index: 0, kind: 'plot', source: 'plot column B of Budget.xlsx', plotSource: 'column B of Budget.xlsx' }), false)).toEqual({ kind: 'graph' })
  })

  it('keeps an error back while it is stale or the line is being typed, and gives it gentle words', () => {
    const error: LineResult = { index: 0, kind: 'error', source: '5 km + 3 kg', error: "A length and a mass don't add up" }

    expect(resultCell(fresh(error), false)).toEqual({ kind: 'error', message: "A length and a mass don't add up" })
    expect(resultCell(fresh(error), true)).toBeNull()
    expect(resultCell({ result: error, tokens: [], fresh: false }, false)).toBeNull()
    expect(resultCell(fresh({ ...error, error: undefined }), false)).toEqual({ kind: 'error', message: "This line doesn't work out yet" })
  })

  it('shows nothing for words, headings, comments and blank lines', () => {
    expect(resultCell(fresh({ index: 0, kind: 'heading', source: '# Trip', label: 'Trip' }), false)).toBeNull()
    expect(resultCell(fresh({ index: 0, kind: 'blank', source: '' }), false)).toBeNull()
    expect(resultCell({ result: null, tokens: [], fresh: false }, false)).toBeNull()
  })
})

describe('displayParts', () => {
  it('sets a unit, a currency code or a duration apart from its number', () => {
    expect(displayParts('3.11 mi', 'unit')).toEqual({ value: '3.11', unit: ' mi' })
    expect(displayParts('176.67°C', 'unit')).toEqual({ value: '176.67', unit: '°C' })
    expect(displayParts('523.10 BRL', 'currency')).toEqual({ value: '523.10', unit: ' BRL' })
    expect(displayParts('98 days', 'duration')).toEqual({ value: '98', unit: ' days' })
  })

  it('leaves symbols, compound units and other kinds whole', () => {
    expect(displayParts('$1,234.50', 'currency')).toEqual({ value: '$1,234.50', unit: '' })
    expect(displayParts('R$ 523.10', 'currency')).toEqual({ value: 'R$ 523.10', unit: '' })
    expect(displayParts('5 ft 3 in', 'unit')).toEqual({ value: '5 ft 3 in', unit: '' })
    expect(displayParts('Fri, Dec 25', 'date')).toEqual({ value: 'Fri, Dec 25', unit: '' })
    expect(displayParts('16.90')).toEqual({ value: '16.90', unit: '' })
  })
})

describe('sidebarShown', () => {
  it('follows the window on auto, and the person otherwise', () => {
    expect(sidebarShown('auto', SIDEBAR_INLINE_PX)).toBe(true)
    expect(sidebarShown('auto', SIDEBAR_INLINE_PX - 1)).toBe(false)
    expect(sidebarShown('auto', 0)).toBe(true)
    expect(sidebarShown('open', 360)).toBe(true)
    expect(sidebarShown('closed', 1200)).toBe(false)
  })
})
