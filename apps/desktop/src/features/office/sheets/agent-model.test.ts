import { describe, expect, it } from 'vitest'
import { caseValues, cleanActionOf, coerceValue, columnRuns, dateSerial, dateValues, dayOrderOf, dedupeRows, delimiterOf, fillGrid, findInGrid, numberValues, parseDate, parseNumber, replaceInGrid, SHEET_TEMPLATES, sheetEditsOf, sheetTemplateOf, splitValues, trimTable, trimValues, valuesOf } from './agent-model.ts'

describe('values as callers send them', () => {
  it('turns plain numbers in text into numbers, keeping ids with leading zeros and apostrophes as text', () => {
    expect(coerceValue('1200')).toBe(1200)
    expect(coerceValue('-3.5')).toBe(-3.5)
    expect(coerceValue('02134')).toBe('02134')
    expect(coerceValue("'42")).toBe('42')
    expect(coerceValue('=SUM(A1:A3)')).toBe('=SUM(A1:A3)')
    expect(coerceValue(true)).toBe(true)
  })

  it('reads rows as JSON text or lists, and one value alone', () => {
    expect(valuesOf('[["Item", "Cost"], ["Rent", "1200"]]')).toEqual([['Item', 'Cost'], ['Rent', 1200]])
    expect(valuesOf([['a', 1]])).toEqual([['a', 1]])
    expect(valuesOf('42')).toBe(42)
    expect(valuesOf('hello')).toBe('hello')
  })
})

describe('filling a formula', () => {
  it('moves relative references for each cell and keeps $ ones', () => {
    expect(fillGrid('=B2*C2', 3, 1)).toEqual([['=B2*C2'], ['=B3*C3'], ['=B4*C4']])
    expect(fillGrid('B2*$C$1', 2, 2)).toEqual([
      ['=B2*$C$1', '=C2*$C$1'],
      ['=B3*$C$1', '=C3*$C$1']
    ])
  })
})

describe('find and replace in cells', () => {
  const shown = [
    ['Name', 'Status', 'Total'],
    ['Acme Ltd', 'paid', '1,200.00'],
    ['Acme Pty', 'Due', '300.00']
  ]
  const formulas = [
    [null, null, null],
    [null, null, null],
    [null, null, '=B9*2']
  ]

  it('finds what cells show, and formulas when asked', () => {
    expect(findInGrid(shown, formulas, 'acme').map((hit) => [hit.row, hit.column])).toEqual([
      [1, 0],
      [2, 0]
    ])
    expect(findInGrid(shown, formulas, 'Paid', { caseSensitive: true })).toEqual([])
    expect(findInGrid(shown, formulas, 'paid', { wholeCell: true })).toHaveLength(1)
    expect(findInGrid(shown, formulas, 'B9', { formulas: true })).toEqual([{ row: 2, column: 2, text: '300.00', formula: '=B9*2' }])
  })

  it('replaces in text cells only, and in formulas when asked', () => {
    const values = [
      ['Name', 'Status', 'Total'],
      ['Acme Ltd', 'paid', 1200],
      ['Acme Pty', 'Due', 300]
    ]

    expect(replaceInGrid(values, formulas, 'Acme', 'Apex')).toEqual([
      { row: 1, column: 0, value: 'Apex Ltd' },
      { row: 2, column: 0, value: 'Apex Pty' }
    ])
    expect(replaceInGrid(values, formulas, '00', '11')).toEqual([])
    expect(replaceInGrid(values, formulas, 'B9', 'B10', { formulas: true })).toEqual([{ row: 2, column: 2, value: '=B10*2' }])
  })
})

describe('cleaning data', () => {
  it('names the tools', () => {
    expect(cleanActionOf('Remove duplicates')).toBe('dedupe')
    expect(cleanActionOf('dates')).toBe('dates')
    expect(() => cleanActionOf('sparkle')).toThrow(/action is one of/)
  })

  it('removes repeated rows, by every column or by some, keeping the header', () => {
    const rows = [
      ['Name', 'Email'],
      ['Sam', 'sam@x.io'],
      ['sam ', 'SAM@x.io'],
      ['Ana', 'ana@x.io'],
      ['Sam', 'other@x.io']
    ]
    const all = dedupeRows(rows, null, true)

    expect(all.removed).toBe(1)
    expect(all.values).toEqual([['Name', 'Email'], ['Sam', 'sam@x.io'], ['Ana', 'ana@x.io'], ['Sam', 'other@x.io'], [null, null]])
    expect(dedupeRows(rows, [0], true).removed).toBe(2)
  })

  it('trims spaces and changes case', () => {
    expect(trimValues([['  a  b ', 3, '\u00a0c']])).toEqual({ values: [['a b', 3, 'c']], changed: 2 })
    expect(caseValues([['new york', 'MARY-JANE o’neil']], 'title').values).toEqual([['New York', 'Mary-Jane O’neil']])
    expect(caseValues([['abc']], 'upper').values).toEqual([['ABC']])
    expect(() => caseValues([['a']], 'sponge')).toThrow(/case is/)
  })

  it('reads numbers kept as text', () => {
    expect(parseNumber('1,200')).toBe(1200)
    expect(parseNumber('$5.50')).toBe(5.5)
    expect(parseNumber('(300)')).toBe(-300)
    expect(parseNumber('12%')).toBe(0.12)
    expect(parseNumber('AUD 40')).toBe(40)
    expect(parseNumber('12a')).toBeNull()
    expect(parseNumber('1,20')).toBeNull()
    expect(numberValues([['1,200', 'x', 4]])).toEqual({ values: [[1200, 'x', 4]], changed: 1 })
  })

  it('reads dates kept as text, day or month first', () => {
    expect(dateSerial(2025, 3, 4)).toBe(45720)
    expect(dateSerial(2025, 2, 30)).toBeNull()
    expect(parseDate('2025-03-04', 'mdy')).toBe(45720)
    expect(parseDate('04/03/2025', 'dmy')).toBe(45720)
    expect(parseDate('03/04/2025', 'mdy')).toBe(45720)
    expect(parseDate('4 March 2025', 'mdy')).toBe(45720)
    expect(parseDate('March 4th, 2025', 'dmy')).toBe(45720)
    expect(parseDate('04-Mar-25', 'mdy')).toBe(45720)
    expect(parseDate('soon', 'dmy')).toBeNull()
    expect(dayOrderOf([['13/02/2025']], 'mdy')).toBe('dmy')
    expect(dayOrderOf([['02/13/2025']], 'dmy')).toBe('mdy')
    expect(dayOrderOf([['02/03/2025']], 'dmy')).toBe('dmy')
    expect(dateValues([['Date'], ['2025-03-04'], ['n/a']], 'dmy')).toEqual({ values: [['Date'], [45720], ['n/a']], cells: [{ row: 1, column: 0 }] })
  })

  it('splits a column and groups cells into runs', () => {
    expect(splitValues(['Full name', 'Ada Lovelace', 'Grace Brewster Hopper', 7], ' ', true)).toEqual({
      values: [
        ['Full name', null, null],
        ['Ada', 'Lovelace', null],
        ['Grace', 'Brewster', 'Hopper'],
        [7, null, null]
      ],
      columns: 3
    })
    expect(delimiterOf('tab')).toBe('\t')
    expect(delimiterOf(undefined)).toBe(',')
    expect(columnRuns([{ row: 2, column: 0 }, { row: 1, column: 0 }, { row: 4, column: 0 }, { row: 1, column: 2 }])).toEqual([
      { row: 1, column: 0, rows: 2 },
      { row: 4, column: 0, rows: 1 },
      { row: 1, column: 2, rows: 1 }
    ])
  })
})

describe('batches, templates and tables', () => {
  it('reads a batch of edits and refuses unknown ones', () => {
    expect(sheetEditsOf([{ op: 'WRITE', range: 'A1', values: [[1]] }, { op: 'addsheet' }]).map((edit) => edit.op)).toEqual(['write', 'addSheet'])
    expect(() => sheetEditsOf('[{"op": "chart"}]')).toThrow(/Edit 1: op is one of/)
  })

  it('starts workbooks from templates whose formulas add up', () => {
    expect(sheetTemplateOf('To-do').id).toBe('todo')
    expect(() => sheetTemplateOf('gantt')).toThrow(/template is one of/)

    for (const template of Object.values(SHEET_TEMPLATES)) {
      const width = template.values[0].length

      expect(template.values.every((row) => row.length === width)).toBe(true)
    }
  })

  it('trims empty rows and columns off a table', () => {
    expect(
      trimTable([
        ['Item', 'Cost', ''],
        ['Rent', '1,200', ''],
        ['', '', '']
      ])
    ).toEqual([
      ['Item', 'Cost'],
      ['Rent', '1,200']
    ])
  })
})
