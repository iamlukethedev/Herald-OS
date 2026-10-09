import { describe, expect, it } from 'vitest'
import { newSheet, newWorkbook, type WorkbookSnapshot } from '../../../../../shared/office/workbook.ts'
import { withHeadlessSheets } from '../headless.ts'
import { readRange, settled } from '../model.ts'
import { changeAndUndo, matrixOf, salesBook, type Value } from './fixtures.ts'
import { changeCase, convertToDates, convertToNumbers, describeTable, fillDown, highlightDuplicates, removeDuplicates, sortBy, splitText, trimText } from './model.ts'

/** A workbook with one sheet, "Data", holding `rows` from A1 (and `styles` by id). */
const book = (rows: Value[][], styles: Record<string, unknown> = {}, columnStyles: Record<number, string> = {}): WorkbookSnapshot => ({ ...newWorkbook('book', 'Book', [newSheet('data', 'Data', matrixOf(rows, columnStyles)), newSheet('other', 'Other')]), styles })

const PEOPLE: Value[][] = [
  ['Name', 'City', 'Amount'],
  ['Ada', 'London', 10],
  ['Grace', 'New York', 20],
  ['ada', 'london', 10],
  ['Alan', 'London', 30],
  ['Grace', 'New York', 25],
  ['Ada', 'London', 10]
]

describe('removing duplicates', () => {
  it('takes out repeated rows in one step, text compared in any case; the rows under them move up and nothing outside the range moves', async () => {
    const styled = book([...PEOPLE, [], ['Total', null, '=SUM(C2:C7)']], { bold: { bl: 1 } })
    styled.sheets.data.cellData[3][0].s = 'bold'
    const result = await changeAndUndo(styled, async (target) => {
      const done = await removeDuplicates(target, { range: 'A1:C7' })
      await settled(target)

      return { done, read: readRange(target, { range: 'A1:C9' }) }
    })
    const cell = (row: number) => result.after.sheets!.data.cellData![row][0]

    expect(result.value.done).toEqual({ sheet: 'Data', range: 'A1:C7', header: true, columns: ['A', 'B', 'C'], duplicates: 2, kept: 4, removed: [4, 7], preview: false })
    expect(result.value.read.values).toEqual([['Name', 'City', 'Amount'], ['Ada', 'London', 10], ['Grace', 'New York', 20], ['Alan', 'London', 30], ['Grace', 'New York', 25], [null, null, null], [null, null, null], [null, null, null], ['Total', null, 85]])
    expect(result.value.read.formulas[8][2]).toBe('=SUM(C2:C7)')
    expect([cell(3).s ?? null, cell(4).s ?? null]).toEqual([null, null])
    expect(result.undone).toBe(true)
  })

  it('compares the columns named, by header or letter, and finds the table around one cell', async () => {
    const result = await changeAndUndo(book(PEOPLE), (target) => removeDuplicates(target, { range: 'B3', columns: ['Name', 'B'] }))

    expect(result.value).toMatchObject({ range: 'A1:C7', duplicates: 3, kept: 3, removed: [4, 6, 7] })
  })

  it('previews without changing anything', async () => {
    const result = await changeAndUndo(book(PEOPLE), (target) => removeDuplicates(target, { range: 'A1:C7', preview: true, header: false }))

    expect(result.value).toMatchObject({ header: false, duplicates: 2, preview: true })
    expect(result.unchanged).toBe(true)
  })

  it('says what to give instead', async () => {
    await withHeadlessSheets(book(PEOPLE), async ({ univer, workbook }) => {
      const target = { univer, workbook }

      await expect(removeDuplicates(target, { range: 'A1:C7', columns: ['Country'] })).rejects.toThrow(/a header \(Name, City, Amount\)/)
      await expect(removeDuplicates(target, { range: 'A1:C7', header: 'maybe' })).rejects.toThrow(/header is true or false/)
      await expect(removeDuplicates(target, { range: 'H40' })).rejects.toThrow(/There is no table at H40/)
      await expect(removeDuplicates(target, { range: '' })).rejects.toThrow(/Give a range/)
    })
  })
})

describe('splitting text', () => {
  const NAMES: Value[][] = [['Full name'], ['Lovelace, Ada'], ['Hopper,Grace, Brewster'], ['Turing'], [42], ['"Doe, Jane", 31']]

  it('splits one column into the columns to its right, numbers as numbers', async () => {
    const result = await changeAndUndo(book(NAMES), async (target) => ({ done: await splitText(target, { range: 'A1:A6', delimiter: 'comma' }), read: readRange(target, { range: 'A1:C6' }).values }))

    expect(result.value.done).toMatchObject({ range: 'A1:A6', destination: 'A1:C6', columns: 3, rows: 3, overwrites: 0, changed: true })
    expect(result.value.read).toEqual([['Full name', null, null], ['Lovelace', 'Ada', null], ['Hopper', 'Grace', 'Brewster'], ['Turing', null, null], [42, null, null], ['Doe, Jane', 31, null]])
    expect(result.undone).toBe(true)
  })

  it('does not write over data unless told, and previews the first rows', async () => {
    const withNotes = book(NAMES.map((row, index) => [...row, index === 2 ? 'keep me' : null]))

    await withHeadlessSheets(withNotes, async ({ univer, workbook }) => {
      const target = { univer, workbook }
      const preview = await splitText(target, { range: 'A2', delimiter: 'comma', preview: true })

      expect(preview).toMatchObject({ range: 'A1:A6', overwrites: 1, changed: false })
      expect(preview.preview.slice(0, 3)).toEqual([['Full name'], ['Lovelace', 'Ada'], ['Hopper', 'Grace', 'Brewster']])
      expect(readRange(target, { range: 'B3' }).values).toEqual([['keep me']])
      await expect(splitText(target, { range: 'A1:A6', delimiter: 'comma' })).rejects.toThrow(/writes over a cell with data in A1:C6: give overwrite: true/)
      await splitText(target, { range: 'A1:A6', delimiter: 'comma', overwrite: true })

      expect(readRange(target, { range: 'B3' }).values).toEqual([['Grace']])
    })
  })

  it('splits at other text and into another place, runs of a delimiter as one', async () => {
    const result = await changeAndUndo(book([['a | b'], ['c |  | d']]), async (target) => {
      await splitText(target, { range: 'A1:A2', delimiter: 'other', other: '|', consecutive: true, destination: 'Other!B2' })

      return readRange(target, { range: 'B2:C3', sheet: 'Other' }).values
    })

    expect(result.value).toEqual([['a', 'b'], ['c', 'd']])
    expect(result.undone).toBe(true)
  })

  it('says what to give instead', async () => {
    await withHeadlessSheets(book(PEOPLE), async ({ univer, workbook }) => {
      const target = { univer, workbook }

      await expect(splitText(target, { range: 'A1:B7', delimiter: 'comma' })).rejects.toThrow(/split one column at a time, like A1:A7/)
      await expect(splitText(target, { range: 'A1:A7', delimiter: 'pipe' })).rejects.toThrow(/delimiter is comma, semicolon, tab, space, other/)
      await expect(splitText(target, { range: 'A1:A7', delimiter: 'other' })).rejects.toThrow(/Give the text to split at/)
    })
  })
})

describe('cleaning and case', () => {
  const MESSY: Value[][] = [['  Ada   Lovelace '], ['grace\u00a0HOPPER\u200b'], [42], ['=UPPER("formula ")'], ['fine']]

  it('trims and cleans text, leaving numbers and formulas alone', async () => {
    const result = await changeAndUndo(book(MESSY), async (target) => {
      const done = await trimText(target, { range: 'A1:A5' })
      await settled(target)

      return { done, read: readRange(target, { range: 'A1:A5' }) }
    })

    expect(result.value.done).toEqual({ sheet: 'Data', range: 'A1:A5', cells: 3, changed: 2 })
    expect(result.value.read.values.flat()).toEqual(['Ada Lovelace', 'grace HOPPER', 42, 'FORMULA ', 'fine'])
    expect(result.value.read.formulas[3][0]).toBe('=UPPER("formula ")')
    expect(result.undone).toBe(true)
  })

  it('changes case, in one step', async () => {
    const result = await changeAndUndo(book([['ada LOVELACE'], ['the first. the second'], [7]]), async (target) => {
      const done = await changeCase(target, { range: 'A1:A3', to: 'title' })

      return { done, read: readRange(target, { range: 'A1:A3' }).values.flat() }
    })

    expect(result.value.done).toMatchObject({ changed: 2, to: 'title' })
    expect(result.value.read).toEqual(['Ada Lovelace', 'The First. The Second', 7])
    expect(result.undone).toBe(true)
    await withHeadlessSheets(book([['x']]), ({ univer, workbook }) => expect(() => changeCase({ univer, workbook }, { range: 'A1', to: 'shouting' })).toThrow(/to is upper, lower, title, sentence/))
  })
})

describe('converting text', () => {
  it('turns text holding numbers into numbers with formats that show them the same, and says what it could not read', async () => {
    const rows: Value[][] = [['1,234.50'], ['$12'], ['(45)'], ['12.5%'], ['7-'], ['n/a'], [5], ['99']]
    const result = await changeAndUndo(book(rows, { text: { n: { pattern: '@' } } }, {}), async (target) => {
      target.workbook.getActiveSheet().getRange('A8').setNumberFormat('@')
      const done = await convertToNumbers(target, { range: 'A1:A8' })

      return { done, read: readRange(target, { range: 'A1:A8' }) }
    })

    expect(result.value.done).toEqual({
      sheet: 'Data',
      range: 'A1:A8',
      converted: 6,
      examples: [
        { cell: 'A1', text: '1,234.50', value: 1234.5 },
        { cell: 'A2', text: '$12', value: 12 },
        { cell: 'A3', text: '(45)', value: -45 }
      ],
      failed: 1,
      notConverted: [{ cell: 'A6', text: 'n/a' }],
      preview: false
    })
    expect(result.value.read.values.flat()).toEqual([1234.5, 12, -45, 0.125, -7, 'n/a', 5, 99])
    expect(result.value.read.text.flat()).toEqual(['1,234.50', '$12', '-45', '12.5%', '-7', 'n/a', '5', '99'])
  })

  it('turns text dates into dates in the order given, with a date format', async () => {
    const rows: Value[][] = [['31/12/2025'], ['1/2/2026'], ['3 Mar 2026'], ['2026-04-05 09:30'], ['31/31/2025'], ['soon']]
    const result = await changeAndUndo(book(rows), async (target) => {
      const done = await convertToDates(target, { range: 'A1:A6', order: 'DMY' })

      return { done, read: readRange(target, { range: 'A1:A6' }) }
    })

    expect(result.value.done).toMatchObject({ converted: 4, failed: 2, notConverted: [{ cell: 'A5', text: '31/31/2025' }, { cell: 'A6', text: 'soon' }], order: 'DMY' })
    expect(result.value.read.text.flat().slice(0, 4)).toEqual(['2025-12-31', '2026-02-01', '2026-03-03', '2026-04-05 09:30'])
    expect(result.value.read.values[0][0]).toBe(46022)
    expect(result.undone).toBe(true)
  })

  it('previews dates in another order and format without changing anything', async () => {
    const result = await changeAndUndo(book([['12/31/2025'], ['31/12/2025']]), (target) => convertToDates(target, { range: 'A1:A2', order: 'mdy', format: 'd mmm yyyy', preview: true }))

    expect(result.value).toMatchObject({ converted: 1, failed: 1, preview: true })
    expect(result.unchanged).toBe(true)
    await withHeadlessSheets(book([['x']]), ({ univer, workbook }) => {
      expect(() => convertToDates({ univer, workbook }, { range: 'A1', order: 'DM' })).toThrow(/order is DMY/)
      expect(() => convertToDates({ univer, workbook }, { range: 'A1', order: 'DMY', format: 42 })).toThrow(/format is a date format/)
    })
  })
})

describe('filling down', () => {
  it('fills each empty cell with the one above, formulas moving their references', async () => {
    const rows: Value[][] = [['Region', 'Amount', 'Double'], ['East', 10, '=B2*2'], [null, 20, null], [null, 30, null], ['West', 40, '=B5*$B$2'], [null, 50, null]]
    const result = await changeAndUndo(book(rows, { money: { n: { pattern: '#,##0.00' } } }, { 0: 'money' }), async (target) => {
      const done = await fillDown(target, { range: 'A1:C6' })
      await settled(target)

      return { done, read: readRange(target, { range: 'A1:C6' }) }
    })

    expect(result.value.done).toEqual({ sheet: 'Data', range: 'A1:C6', filled: 6 })
    expect(result.value.read.values.map((row) => row[0])).toEqual(['Region', 'East', 'East', 'East', 'West', 'West'])
    expect(result.value.read.formulas.map((row) => row[2])).toEqual([null, '=B2*2', '=B3*2', '=B4*2', '=B5*$B$2', '=B6*$B$2'])
    expect(result.value.read.values.map((row) => row[2])).toEqual(['Double', 20, 40, 60, 400, 500])
    expect(result.undone).toBe(true)
  })
})

describe('highlighting duplicates', () => {
  it('adds a duplicate-values rule over the column, recolours it, and takes it off', async () => {
    await withHeadlessSheets(book(PEOPLE), async ({ univer, workbook }) => {
      const target = { univer, workbook }
      const sheet = workbook.getActiveSheet()
      const added = await highlightDuplicates(target, { range: 'B2' })

      expect(added).toEqual({ sheet: 'Data', range: 'B1:B7', duplicates: 6, cleared: 0, color: '#ffc7ce' })
      expect(sheet.getConditionalFormattingRules().map((rule) => ({ type: (rule.rule as { subType?: string }).subType, ranges: rule.ranges }))).toEqual([{ type: 'duplicateValues', ranges: [{ startRow: 0, startColumn: 1, endRow: 6, endColumn: 1 }] }])

      await highlightDuplicates(target, { range: 'B1:B7', color: '#fff3bf' })
      expect(sheet.getConditionalFormattingRules()).toHaveLength(1)
      expect(sheet.getConditionalFormattingRules()[0].rule).toEqual({ type: 'highlightCell', subType: 'duplicateValues', style: { bg: { rgb: 'rgb(255,243,191)' } } })

      workbook.undo()
      expect(sheet.getConditionalFormattingRules()[0].rule).toEqual({ type: 'highlightCell', subType: 'duplicateValues', style: { bg: { rgb: 'rgb(255,199,206)' }, cl: { rgb: 'rgb(156,0,6)' } } })
      expect(await highlightDuplicates(target, { range: 'B1:B7', clear: true })).toMatchObject({ cleared: 1 })
      expect(sheet.getConditionalFormattingRules()).toHaveLength(0)
      await expect(highlightDuplicates(target, { range: 'B1:B7', color: 'reddish' })).rejects.toThrow(/color is a colour like/)
    })
  })
})

describe('sorting by several columns', () => {
  it('sorts by each key in turn, keeping the headers on top, in one step', async () => {
    const result = await changeAndUndo(salesBook(), async (target) => {
      const done = await sortBy(target, { range: 'C4', keys: [{ column: 'Region', ascending: true }, { column: 'D', ascending: false }] })

      return { done, read: readRange(target, { range: 'A1:D11' }).values }
    })

    expect(result.value.done).toEqual({ sheet: 'Sales', range: 'A2:D11', header: true, keys: [{ column: 'A', ascending: true }, { column: 'D', ascending: false }] })
    expect(result.value.read.map((row) => `${row[0]} ${row[3]}`)).toEqual(['Region Amount', 'East 120', 'East 110', 'East 45.5', 'East 15', 'North 200', 'North 75', 'West 90', 'West 80', 'west 60', 'null 30'])
    expect(result.undone).toBe(true)
  })

  it('sorts a table that does not start in column A', async () => {
    const sheet = newSheet('data', 'Data', matrixOf([['Name', 'Score'], ['Cy', 3], ['Al', 1], ['Bo', 2]], {}, { row: 2, column: 3 }))
    const result = await changeAndUndo(newWorkbook('book', 'Book', [sheet]), async (target) => {
      await sortBy(target, { range: 'D3:E6', keys: ['Score'] })

      return readRange(target, { range: 'D4:D6' }).values.flat()
    })

    expect(result.value).toEqual(['Al', 'Bo', 'Cy'])
  })

  it('says what to give instead', async () => {
    await withHeadlessSheets(salesBook(), async ({ univer, workbook }) => {
      const target = { univer, workbook }

      await expect(sortBy(target, { range: 'A1:D11', keys: [] })).rejects.toThrow(/keys is a list like/)
      await expect(sortBy(target, { range: 'A1:D11', keys: ['Region', 'region'] })).rejects.toThrow(/Sort by each column once/)
      await expect(sortBy(target, { range: 'A1:D11', keys: [{ column: 'Price' }] })).rejects.toThrow(/Say which column to sort by/)
      await expect(sortBy(target, { range: 'A1:D11', keys: [{ column: 'Region', ascending: 'up' }] })).rejects.toThrow(/ascending is true or false/)
    })
  })
})

describe('tables', () => {
  it('describes the table around a cell, whole columns cut to the data', async () => {
    await withHeadlessSheets(salesBook(), ({ univer, workbook }) => {
      expect(describeTable({ univer, workbook }, { range: 'B5' })).toEqual({ sheet: 'Sales', range: 'A1:D11', header: true, columns: [{ name: 'Region', letter: 'A' }, { name: 'Product', letter: 'B' }, { name: 'Quarter', letter: 'C' }, { name: 'Amount', letter: 'D' }], rows: 10 })
      expect(describeTable({ univer, workbook }, { range: 'B:C' }).range).toBe('B1:C11')
    })
  })
})
