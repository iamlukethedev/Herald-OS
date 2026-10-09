import { describe, expect, it } from 'vitest'
import { cleanActionOf, coerceValue, DEPTH_EDIT_OPS, dayOrderOf, fillGrid, findInGrid, isDepthEdit, replaceInGrid, SHEET_EDIT_OPS, SHEET_TEMPLATES, sheetEditsOf, sheetTemplateOf, trimTable, valuesOf } from './agent-model.ts'

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

  it('tells which way round day and month go in dates, from a number over 12', () => {
    expect(dayOrderOf([['13/02/2025']], 'mdy')).toBe('dmy')
    expect(dayOrderOf([['Date'], ['02/13/2025']], 'dmy')).toBe('mdy')
    expect(dayOrderOf([['02/03/2025']], 'dmy')).toBe('dmy')
    expect(dayOrderOf([['02/03/2025']], 'mdy')).toBe('mdy')
  })
})

describe('batches, templates and tables', () => {
  it('reads a batch of edits and refuses unknown ones', () => {
    expect(sheetEditsOf([{ op: 'WRITE', range: 'A1', values: [[1]] }, { op: 'addsheet' }]).map((edit) => edit.op)).toEqual(['write', 'addSheet'])
    expect(() => sheetEditsOf('[{"op": "chart"}]')).toThrow(/Edit 1: op is one of/)
  })

  it('takes the changing sheets commands as ops of their own, named as the commands, and no previews', () => {
    const edits = sheetEditsOf([{ op: 'insertchart', range: 'A1:B5' }, { op: 'removeChart', chart: 1 }, { op: 'addComment', cell: 'B2', text: 'Check' }, { op: 'write', range: 'A1', values: [[1]] }])

    expect(edits.map((edit) => edit.op)).toEqual(['insertChart', 'removeChart', 'addComment', 'write'])
    expect(edits.map((edit) => isDepthEdit(edit))).toEqual([true, true, true, false])
    expect(DEPTH_EDIT_OPS.every((op) => (SHEET_EDIT_OPS as readonly string[]).includes(op))).toBe(true)
    expect(DEPTH_EDIT_OPS).not.toContain('listCharts')
    expect(DEPTH_EDIT_OPS).not.toContain('goToName')
    expect(() => sheetEditsOf([{ op: 'write', range: 'A1', values: [[1]] }, { op: 'removeDuplicates', range: 'A1:C9', preview: true }])).toThrow(/Edit 2: a batch makes its changes, so preview has no place in it: preview with sheets.removeDuplicates alone/)
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
