import { describe, expect, it } from 'vitest'
import { CELL_TYPE, type CellMatrix, newSheet, newWorkbook, type SheetSnapshot, type WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import { workbookFromXlsx } from '../../../../shared/office/xlsx/read.ts'
import { xlsxFromWorkbook } from '../../../../shared/office/xlsx/write.ts'
import { type Deck, findElement, findSlide, type TableElement } from './deck.ts'
import { addSlideFromSheet, addTableFromSheet, formatNumber, sheetRange } from './from-sheet.ts'
import { placeholderFor } from './layouts.ts'
import * as model from './model.ts'
import { tableElement } from './tables.ts'
import { plainText } from './text.ts'

const texts = (table: TableElement) => table.cells.map((row) => row.map((cell) => plainText(cell.body)))
const aligns = (table: TableElement, row: number) => table.cells[row].map((cell) => cell.body.paragraphs[0].align)
const tableOn = (deck: Deck, slideId: string): TableElement => findSlide(deck, slideId)!.elements.find((element) => element.kind === 'table') as TableElement

function titleOn(deck: Deck, slideId: string): string {
  const title = placeholderFor(findSlide(deck, slideId)!, 'title')

  return title && (title.kind === 'text' || title.kind === 'shape') ? plainText(title.body) : ''
}

function bookOf(cellData: CellMatrix, sheet: Partial<SheetSnapshot> = {}, styles: Record<string, unknown> = {}): WorkbookSnapshot {
  return { ...newWorkbook('book', 'Book', [{ ...newSheet('s1', 'Sales', cellData), ...sheet }]), styles }
}

/** A header row over `count` rows of a region, its units and their share. */
function salesBook(count: number): WorkbookSnapshot {
  const cellData: CellMatrix = { 0: { 0: { v: 'Region', t: CELL_TYPE.string }, 1: { v: 'Units', t: CELL_TYPE.string }, 2: { v: 'Share', t: CELL_TYPE.string } } }

  for (let row = 1; row <= count; row++) {
    cellData[row] = { 0: { v: `Region ${row}`, t: CELL_TYPE.string }, 1: { v: row * 100, t: CELL_TYPE.number }, 2: { v: row / 100, t: CELL_TYPE.number, s: 'share' } }
  }

  return bookOf(cellData, {}, { share: { n: { pattern: '0%' } } })
}

describe('number formats', () => {
  it('shows General as Excel does in a standard column', () => {
    expect(formatNumber(1234.5)).toBe('1234.5')
    expect(formatNumber(0.1 + 0.2, 'General')).toBe('0.3')
    expect(formatNumber(-7)).toBe('-7')
    expect(formatNumber(1234567.891234)).toBe('1234567.891')
    expect(formatNumber(123456789012)).toBe('1.23457E+11')
    expect(formatNumber(0)).toBe('0')
  })

  it('rounds whole numbers and decimals as written in decimal, half away from zero', () => {
    expect(formatNumber(2.5, '0')).toBe('3')
    expect(formatNumber(-2.5, '0')).toBe('-3')
    expect(formatNumber(1.005, '0.00')).toBe('1.01')
    expect(formatNumber(3, '0.00')).toBe('3.00')
    expect(formatNumber(0.5, '#.00')).toBe('.50')
    expect(formatNumber(1.5, '0.0#')).toBe('1.5')
    expect(formatNumber(1.234, '0.0#')).toBe('1.23')
    expect(formatNumber(42, '00000')).toBe('00042')
  })

  it('separates thousands', () => {
    expect(formatNumber(1234567.4, '#,##0')).toBe('1,234,567')
    expect(formatNumber(-1234.5, '#,##0.00')).toBe('-1,234.50')
    expect(formatNumber(0.4, '#,##0')).toBe('0')
  })

  it('shows percentages', () => {
    expect(formatNumber(0.256, '0%')).toBe('26%')
    expect(formatNumber(0.12345, '0.00%')).toBe('12.35%')
  })

  it('shows currency with its symbol, and the sections for negative numbers and zero', () => {
    expect(formatNumber(1234.5, '"$"#,##0.00')).toBe('$1,234.50')
    expect(formatNumber(-1234.5, '"$"#,##0.00')).toBe('-$1,234.50')
    expect(formatNumber(5, '"$"#,##0.00_);("$"#,##0.00)')).toBe('$5.00')
    expect(formatNumber(-5, '"$"#,##0.00_);("$"#,##0.00)')).toBe('($5.00)')
    expect(formatNumber(-5, '"$"#,##0.00;[Red]\\-"$"#,##0.00')).toBe('-$5.00')
    expect(formatNumber(1234.5, '[$€-407] #,##0.00')).toBe('€ 1,234.50')
    expect(formatNumber(1234.5, '£#,##0')).toBe('£1,235')

    const accounting = '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)'

    expect([1234.5, -1234.5, 0].map((value) => formatNumber(value, accounting))).toEqual(['$ 1,234.50', '$ (1,234.50)', '$ -'])
  })

  it('shows numbers in thousands and millions, and in scientific notation', () => {
    expect(formatNumber(1234567, '#,##0,"K"')).toBe('1,235K')
    expect(formatNumber(1234567, '0.0,,"M"')).toBe('1.2M')
    expect(formatNumber(12345, '0.00E+00')).toBe('1.23E+04')
    expect(formatNumber(0.00012, '0.0E+0')).toBe('1.2E-4')
  })

  it('shows serial numbers as dates and times', () => {
    const monday = 45306

    expect(formatNumber(monday, 'm/d/yyyy')).toBe('1/15/2024')
    expect(formatNumber(monday, 'yyyy-mm-dd')).toBe('2024-01-15')
    expect(formatNumber(monday, 'd-mmm-yy')).toBe('15-Jan-24')
    expect(formatNumber(monday, 'mmm-yy')).toBe('Jan-24')
    expect(formatNumber(monday, 'dddd, mmmm d, yyyy')).toBe('Monday, January 15, 2024')
    expect(formatNumber(monday + 0.75, 'h:mm')).toBe('18:00')
    expect(formatNumber(monday + 0.75, 'h:mm AM/PM')).toBe('6:00 PM')
    expect(formatNumber(monday + 0.5, 'dd/mm/yyyy hh:mm')).toBe('15/01/2024 12:00')
    expect(formatNumber(1.5, '[h]:mm')).toBe('36:00')
    expect(formatNumber(90 / 86400, 'mm:ss')).toBe('01:30')
    expect(formatNumber(0, 'yyyy-mm-dd', true)).toBe('1904-01-01')
  })

  it('shows numbers in the text format and fractions as General', () => {
    expect(formatNumber(12.5, '@')).toBe('12.5')
    expect(formatNumber(1.25, '# ?/?')).toBe('1.25')
  })
})

describe('ranges', () => {
  const book = bookOf(
    {
      0: { 0: { v: 'Region' }, 1: { v: 'Units' }, 2: { v: 'Revenue' }, 3: { v: 'Share' }, 4: { v: 'Launched' }, 5: { v: 'Active' }, 6: { v: 'Code' } },
      1: {
        0: { p: { body: { dataStream: 'North\r\n' } } },
        1: { v: 1200, t: CELL_TYPE.number },
        2: { v: 1234.5, t: CELL_TYPE.number, s: 'money' },
        3: { v: 0.256, t: CELL_TYPE.number, s: { n: { pattern: '0.0%' } } },
        4: { v: 45306, t: CELL_TYPE.number, s: 'date' },
        5: { v: 1, t: CELL_TYPE.boolean },
        6: { v: '0042', t: CELL_TYPE.text }
      },
      2: { 0: { v: 'South', s: 'bold' }, 1: { f: '=B2*2', v: 2400, t: CELL_TYPE.number }, 2: { f: '=C2*2' }, 5: { v: 0, t: CELL_TYPE.boolean } }
    },
    {},
    { money: { n: { pattern: '"$"#,##0.00' } }, date: { n: { pattern: 'yyyy-mm-dd' } }, bold: { bl: 1 } }
  )
  const sheet = book.sheets.s1

  it('takes the used range as its cells show, numbers right-aligned', () => {
    const range = sheetRange(sheet, undefined, book)

    expect(range.ref).toBe('A1:G3')
    expect(range.cells.map((row) => row.map((cell) => cell.text))).toEqual([
      ['Region', 'Units', 'Revenue', 'Share', 'Launched', 'Active', 'Code'],
      ['North', '1200', '$1,234.50', '25.6%', '2024-01-15', 'TRUE', '0042'],
      ['South', '2400', '', '', '', 'FALSE', '']
    ])
    expect(range.cells[1].map((cell) => cell.align)).toEqual([undefined, 'right', 'right', 'right', 'right', undefined, undefined])
    expect(range.cells[1].map((cell) => cell.number)).toEqual([false, true, true, true, true, false, false])
    expect(range.cells[2][0]).toMatchObject({ text: 'South', bold: true })
  })

  it('takes an A1 range, whole columns as far as the sheet is used, and says when a range is not one', () => {
    expect(sheetRange(sheet, 'B2:C3', book).cells.map((row) => row.map((cell) => cell.text))).toEqual([
      ['1200', '$1,234.50'],
      ['2400', '']
    ])
    expect(sheetRange(sheet, 'Sales!A:B', book)).toMatchObject({ ref: 'A1:B3' })
    expect(sheetRange(sheet, 'E9:F10', book).cells).toEqual([
      [
        { text: '', number: false },
        { text: '', number: false }
      ],
      [
        { text: '', number: false },
        { text: '', number: false }
      ]
    ])
    expect(sheetRange(newSheet('empty', 'Empty'))).toEqual({ ref: '', cells: [], merges: [] })
    expect(() => sheetRange(sheet, 'here and there')).toThrow(/not a range of cells/)
  })

  it('leaves out hidden rows and columns and keeps merged cells', () => {
    const merged = bookOf(
      {
        0: { 0: { v: 'Quarterly sales' } },
        1: { 0: { v: 'Q1' }, 1: { v: 'hidden' }, 2: { v: 10, t: CELL_TYPE.number } },
        2: { 0: { v: 'secret' } },
        3: { 0: { v: 'Q2' }, 2: { v: 20, t: CELL_TYPE.number } }
      },
      { rowData: { 2: { hd: 1 } }, columnData: { 1: { hd: 1 } }, mergeData: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 2 }] }
    )
    const range = sheetRange(merged.sheets.s1, undefined, merged)

    expect(range.ref).toBe('A1:C4')
    expect(range.cells.map((row) => row.map((cell) => cell.text))).toEqual([
      ['Quarterly sales', ''],
      ['Q1', '10'],
      ['Q2', '20']
    ])
    expect(range.merges).toEqual([{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 }])
  })

  it('shows a cell in its column’s format, else its row’s, when it has none of its own', () => {
    const styled = bookOf(
      { 0: { 0: { v: 0.5, t: CELL_TYPE.number }, 1: { v: 0.5, t: CELL_TYPE.number } }, 1: { 0: { v: 0.5, t: CELL_TYPE.number, s: 'fixed' }, 1: { v: 0.5, t: CELL_TYPE.number } } },
      { columnData: { 1: { s: 'share' } }, rowData: { 1: { s: 'fixed' } } },
      { share: { n: { pattern: '0%' } }, fixed: { n: { pattern: '0.000' } } }
    )

    expect(sheetRange(styled.sheets.s1, undefined, styled).cells.map((row) => row.map((cell) => cell.text))).toEqual([
      ['0.5', '50%'],
      ['0.500', '50%']
    ])
  })

  it('takes no more rows and columns than a table holds', () => {
    const cellData: CellMatrix = {}

    for (let row = 0; row < 100; row++) {
      cellData[row] = Object.fromEntries(Array.from({ length: 80 }, (_, column) => [column, { v: row * 80 + column, t: CELL_TYPE.number }]))
    }

    const range = sheetRange(bookOf(cellData).sheets.s1)

    expect([range.cells.length, range.cells[0].length, range.ref]).toEqual([75, 75, 'A1:BW75'])
  })
})

describe('tables from sheets', () => {
  it('puts a range under a slide’s title, its header row on the first accent and its numbers right-aligned', () => {
    const added = model.addSlide(model.newDeck('Deck'), { layout: 'title-only', title: 'Sales' })
    const change = addTableFromSheet(added.deck, added.slideId, salesBook(3))
    const slide = findSlide(change.deck, added.slideId)!
    const title = placeholderFor(slide, 'title')!
    const table = findElement(slide, change.elementId) as TableElement
    const bands = tableElement({ x: 0, y: 0, width: 90, height: 90 }, 3, 1).cells.map((row) => row[0].fill)

    expect(change).toMatchObject({ label: 'Table from Sheet', focus: { slideId: added.slideId, selected: [table.id] } })
    expect(table.y).toBeGreaterThanOrEqual(title.y + title.height)
    expect([table.x, Math.round(table.width)]).toEqual([60, 840])
    expect(table.columns.reduce((sum, width) => sum + width, 0)).toBeCloseTo(table.width)
    expect(table.rows.reduce((sum, height) => sum + height, 0)).toBeCloseTo(table.height)
    expect(texts(table)).toEqual([
      ['Region', 'Units', 'Share'],
      ['Region 1', '100', '1%'],
      ['Region 2', '200', '2%'],
      ['Region 3', '300', '3%']
    ])
    expect(table.cells[0].map((cell) => [cell.fill, cell.body.style.color, cell.body.style.bold])).toEqual(Array.from({ length: 3 }, () => [{ color: 'accent1' }, 'bg1', true]))
    expect(table.cells.slice(1).map((row) => row[0].fill)).toEqual([bands[1], bands[2], bands[1]])
    expect(aligns(table, 0)).toEqual([undefined, 'right', 'right'])
    expect(aligns(table, 2)).toEqual([undefined, 'right', 'right'])
    expect(table.cells[0][0].body.style.size).toBe(18)
  })

  it('fills an empty text placeholder, a box, or takes the first row as data', () => {
    const added = model.addSlide(model.newDeck('Deck'), { layout: 'title-content', title: 'Sales' })
    const body = placeholderFor(findSlide(added.deck, added.slideId)!, 'body')!
    const filled = addTableFromSheet(added.deck, added.slideId, salesBook(2))
    const slide = findSlide(filled.deck, added.slideId)!
    const table = tableOn(filled.deck, added.slideId)

    expect(placeholderFor(slide, 'body')).toBeUndefined()
    expect([table.x, table.y, Math.round(table.width)]).toEqual([body.x, body.y, body.width])

    const boxed = addTableFromSheet(added.deck, added.slideId, salesBook(2), { box: { x: 100, y: 200, width: 400, height: 200 }, header: false }).deck
    const plain = tableOn(boxed, added.slideId)

    expect([plain.x, plain.y, Math.round(plain.width)]).toEqual([100, 200, 400])
    expect(placeholderFor(findSlide(boxed, added.slideId)!, 'body')).toBeDefined()
    expect(texts(plain)[0]).toEqual(['Region', 'Units', 'Share'])
    expect(plain.cells[0][0].fill).not.toEqual({ color: 'accent1' })
    expect(plain.cells[0][0].body.style.bold).toBeUndefined()
  })

  it('takes a range of the sheet asked for, and says when there is no such sheet or nothing in it', () => {
    const book = salesBook(2)
    const added = model.addSlide(model.newDeck('Deck'), { layout: 'title-only' })
    const table = tableOn(addTableFromSheet(added.deck, added.slideId, book, { range: "'Sales'!A2:B3", header: false }).deck, added.slideId)

    expect(texts(table)).toEqual([
      ['Region 1', '100'],
      ['Region 2', '200']
    ])
    expect(() => addTableFromSheet(added.deck, added.slideId, book, { sheet: 'Costs' })).toThrow('There is no sheet called Costs; the workbook has Sales')
    expect(() => addTableFromSheet(added.deck, 'nope', book)).toThrow(/no slide nope/)
    expect(() => addTableFromSheet(added.deck, added.slideId, bookOf({}))).toThrow('Sales is empty')
  })

  it('makes a Title Only slide of a range, after the slide asked for', () => {
    const deck = model.addSlide(model.newDeck('Deck'), { layout: 'blank' }).deck
    const change = addSlideFromSheet(deck, salesBook(4), { title: 'Units by region', after: deck.slides[0].id })
    const slide = findSlide(change.deck, change.slideIds[0])!

    expect(change).toMatchObject({ label: 'Slide from Sheet', focus: { slideId: change.slideIds[0], selected: [] } })
    expect(change.deck.slides.map((entry) => entry.id)).toEqual([deck.slides[0].id, ...change.slideIds, deck.slides[1].id])
    expect(slide.layout).toBe('title-only')
    expect(titleOn(change.deck, slide.id)).toBe('Units by region')
    expect(texts(tableOn(change.deck, slide.id))).toHaveLength(5)
  })

  it('goes on over further slides with a range too tall for one, the header row repeated', () => {
    const change = addSlideFromSheet(model.newDeck('Deck'), salesBook(40))
    const tables = change.slideIds.map((id) => tableOn(change.deck, id))
    const titles = change.slideIds.map((id) => titleOn(change.deck, id))

    expect(change.label).toBe('Slides from Sheet')
    expect(tables.length).toBeGreaterThan(1)
    expect(titles).toEqual(['Sales', ...Array.from({ length: tables.length - 1 }, () => 'Sales (continued)')])
    expect(tables.map((table) => texts(table)[0])).toEqual(tables.map(() => ['Region', 'Units', 'Share']))
    expect(tables.flatMap((table) => texts(table).slice(1).map((row) => row[0]))).toEqual(Array.from({ length: 40 }, (_, n) => `Region ${n + 1}`))
    expect(tables.every((table) => table.y >= 136 && table.y + table.height <= 500 + 0.01)).toBe(true)
    expect(tables.every((table) => table.cells[0][0].body.style.size === 12)).toBe(true)
  })

  it('puts a range of an .xlsx file on a slide as Excel shows it', async () => {
    const sheet = newSheet('s1', 'Budget', {
      0: { 0: { v: 'Item', t: CELL_TYPE.string }, 1: { v: 'Cost', t: CELL_TYPE.string }, 2: { v: 'Due', t: CELL_TYPE.string }, 3: { v: 'Share', t: CELL_TYPE.string } },
      1: { 0: { v: 'Rent', t: CELL_TYPE.string }, 1: { v: 1200, t: CELL_TYPE.number, s: 'money' }, 2: { v: 45306, t: CELL_TYPE.number, s: 'date' }, 3: { v: 0.6, t: CELL_TYPE.number, s: 'share' } },
      2: { 0: { v: 'Power', t: CELL_TYPE.string }, 1: { v: 85.5, t: CELL_TYPE.number, s: 'money' }, 2: { v: 45337, t: CELL_TYPE.number, s: 'date' }, 3: { v: 0.04, t: CELL_TYPE.number, s: 'share' } },
      3: { 0: { v: 'Total', t: CELL_TYPE.string }, 1: { f: '=B2+B3', v: 1285.5, t: CELL_TYPE.number, s: 'money' } }
    })
    const written = { ...newWorkbook('budget', 'Budget', [sheet]), styles: { money: { n: { pattern: '#,##0.00' } }, date: { n: { pattern: 'yyyy-mm-dd' } }, share: { n: { pattern: '0%' } } } }
    const { bytes } = await xlsxFromWorkbook(written)
    const { workbook } = await workbookFromXlsx(bytes, { id: 'budget', name: 'Budget' })
    const change = addSlideFromSheet(model.newDeck('Deck'), workbook)
    const table = tableOn(change.deck, change.slideIds[0])

    expect(texts(table)).toEqual([
      ['Item', 'Cost', 'Due', 'Share'],
      ['Rent', '1,200.00', '2024-01-15', '60%'],
      ['Power', '85.50', '2024-02-15', '4%'],
      ['Total', '1,285.50', '', '']
    ])
    expect(aligns(table, 1)).toEqual([undefined, 'right', 'right', 'right'])
  })
})
