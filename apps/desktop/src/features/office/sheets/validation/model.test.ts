import { describe, expect, it } from 'vitest'
import { CELL_TYPE, newSheet, newWorkbook, type WorkbookSnapshot } from '../../../../../shared/office/workbook.ts'
import { withHeadlessSheets } from '../headless.ts'
import { type SheetsTarget, writeRange } from '../model.ts'
import { clearValidation, getValidation, OPERATORS, setValidation } from './model.ts'

function book(): WorkbookSnapshot {
  return newWorkbook('book', 'Book', [newSheet('s1', 'Orders'), newSheet('s2', 'Lists', { 0: { 0: { v: 'Red', t: CELL_TYPE.string } }, 1: { 0: { v: 'Green', t: CELL_TYPE.string } } })])
}

const run = <T>(work: (target: SheetsTarget) => Promise<T> | T) => withHeadlessSheets(book(), ({ univer, workbook }) => work({ univer, workbook }))

/** What Univer makes of each value in the first cell of a range with its rule. */
async function statuses(target: SheetsTarget, range: string, values: unknown[]): Promise<string[]> {
  const found: string[] = []

  for (const value of values) {
    await writeRange(target, { range, values: [[value as string]] })
    const cell = target.workbook.getActiveSheet().getRange(range)
    found.push(String((await cell.getValidatorStatus())[0][0]))
  }

  return found
}

describe('data validation', () => {
  it('sets a list of items with its messages, and gives it back as set', async () => {
    const { result } = await run((target) =>
      setValidation(target, {
        range: 'B2:B9',
        rule: { type: 'list', items: ['Small', 'Medium', 'Large', 'Small'] },
        input: { title: 'Size', message: 'Pick a size\nfrom the list' },
        error: { style: 'warning', title: 'Unusual size', message: 'That size is not on the list' }
      })
    )

    expect(result).toEqual({
      sheet: 'Orders',
      rules: [
        {
          range: 'B2:B9',
          rule: { type: 'list', items: ['Small', 'Medium', 'Large'] },
          allowBlank: true,
          dropdown: true,
          input: { title: 'Size', message: 'Pick a size\nfrom the list' },
          error: { style: 'warning', title: 'Unusual size', message: 'That size is not on the list' }
        }
      ]
    })
  })

  it('takes list items from cells, on the rule’s sheet or another', async () => {
    const { result } = await run(async (target) => [
      (await setValidation(target, { range: 'C2', rule: { type: 'list', source: "'lists'!A1:A2" }, dropdown: false })).rules[0],
      (await setValidation(target, { range: 'D2', rule: { type: 'list', source: 'F1:F9' }, error: false })).rules[0],
      await statuses(target, 'C2', ['Green', 'Blue'])
    ])

    expect(result[0]).toMatchObject({ rule: { type: 'list', source: 'Lists!$A$1:$A$2' }, dropdown: false, error: { style: 'stop' } })
    expect(result[1]).toMatchObject({ rule: { type: 'list', source: '$F$1:$F$9' }, error: null })
    expect(result[2]).toEqual(['valid', 'invalid'])
  })

  it('compares whole numbers with every operator, as Univer then checks values', async () => {
    const { result } = await run(async (target) => {
      const found: Record<string, unknown> = {}

      for (const operator of OPERATORS) {
        const two = operator === 'between' || operator === 'notBetween'
        const { rules } = await setValidation(target, { range: 'A1', rule: { type: 'whole', operator, ...(two ? { min: 1, max: 10 } : { value: 5 }) } })
        found[operator] = { rule: rules[0].rule, checks: await statuses(target, 'A1', [5, 11, 2.5]) }
      }

      return found
    })

    expect(result).toEqual({
      between: { rule: { type: 'whole', operator: 'between', min: 1, max: 10 }, checks: ['valid', 'invalid', 'invalid'] },
      notBetween: { rule: { type: 'whole', operator: 'notBetween', min: 1, max: 10 }, checks: ['invalid', 'valid', 'invalid'] },
      equal: { rule: { type: 'whole', operator: 'equal', value: 5 }, checks: ['valid', 'invalid', 'invalid'] },
      notEqual: { rule: { type: 'whole', operator: 'notEqual', value: 5 }, checks: ['invalid', 'valid', 'invalid'] },
      greaterThan: { rule: { type: 'whole', operator: 'greaterThan', value: 5 }, checks: ['invalid', 'valid', 'invalid'] },
      lessThan: { rule: { type: 'whole', operator: 'lessThan', value: 5 }, checks: ['invalid', 'invalid', 'invalid'] },
      greaterThanOrEqual: { rule: { type: 'whole', operator: 'greaterThanOrEqual', value: 5 }, checks: ['valid', 'valid', 'invalid'] },
      lessThanOrEqual: { rule: { type: 'whole', operator: 'lessThanOrEqual', value: 5 }, checks: ['valid', 'invalid', 'invalid'] }
    })
  })

  it('compares decimals, dates and text lengths, and takes formulas as bounds', async () => {
    const { result } = await run(async (target) => [
      (await setValidation(target, { range: 'A1', rule: { type: 'decimal', operator: 'between', min: '0.5', max: 2.25 } })).rules[0].rule,
      await statuses(target, 'A1', [1.75, 3]),
      (await setValidation(target, { range: 'B1', rule: { type: 'date', operator: 'between', min: '2026-01-01', max: '2026-12-31' } })).rules[0].rule,
      (await setValidation(target, { range: 'C1', rule: { type: 'date', operator: 'greaterThanOrEqual', value: '=TODAY()' } })).rules[0].rule,
      (await setValidation(target, { range: 'D1', rule: { type: 'textLength', operator: 'lessThanOrEqual', value: 5 } })).rules[0].rule,
      await statuses(target, 'D1', ['short', 'too long']),
      (await setValidation(target, { range: 'E1', rule: { type: 'decimal', operator: 'lessThan', value: '=Lists!B1' } })).rules[0].rule
    ])

    expect(result).toEqual([
      { type: 'decimal', operator: 'between', min: 0.5, max: 2.25 },
      ['valid', 'invalid'],
      { type: 'date', operator: 'between', min: '2026-01-01', max: '2026-12-31' },
      { type: 'date', operator: 'greaterThanOrEqual', value: '=TODAY()' },
      { type: 'textLength', operator: 'lessThanOrEqual', value: 5 },
      ['valid', 'invalid'],
      { type: 'decimal', operator: 'lessThan', value: '=Lists!B1' }
    ])
  })

  it('checks dates Univer reads as dates', async () => {
    const { result } = await run(async (target) => {
      await setValidation(target, { range: 'B1', rule: { type: 'date', operator: 'between', min: '2026-01-01', max: '2026-12-31' } })

      return statuses(target, 'B1', ['2026-06-15', '2027-02-01'])
    })

    expect(result).toEqual(['valid', 'invalid'])
  })

  it('sets a custom formula rule, worked out from the rule’s first cell', async () => {
    const { result } = await run(async (target) => {
      await writeRange(target, { range: 'A1:A2', values: [[10], [3]] })
      const { rules } = await setValidation(target, { range: 'B1:B2', rule: { type: 'custom', formula: 'B1<=A1' }, allowBlank: false })
      const checks = [...(await statuses(target, 'B1', [8, 12])), ...(await statuses(target, 'B2', [2, 4]))]

      return { rules, checks }
    })

    expect(result.rules).toEqual([{ range: 'B1:B2', rule: { type: 'custom', formula: '=B1<=A1' }, allowBlank: false, error: { style: 'stop', title: '', message: '' } }])
    expect(result.checks).toEqual(['valid', 'invalid', 'valid', 'invalid'])
  })

  it('takes any value with an input message alone', async () => {
    const { result } = await run(async (target) => ({
      set: (await setValidation(target, { range: 'H1:H3', rule: { type: 'any' }, input: { title: 'Tip', message: 'Anything goes here' }, error: { style: 'stop' } })).rules,
      bare: await setValidation(target, { range: 'H4', rule: { type: 'any' } }).catch((error: Error) => error.message)
    }))

    expect(result.set).toEqual([{ range: 'H1:H3', rule: { type: 'any' }, allowBlank: true, input: { title: 'Tip', message: 'Anything goes here' }, error: null }])
    expect(result.bare).toBe('A rule that takes any value is there for its input message: give input {"title": …, "message": …}, or clearValidation to take the rules off')
  })

  it('replaces the rules of the cells it sets, in one step to undo', async () => {
    const { result } = await run(async (target) => {
      await setValidation(target, { range: 'A1:A9', rule: { type: 'whole', operator: 'greaterThan', value: 0 } })
      await setValidation(target, { range: 'A3:A4', rule: { type: 'list', items: ['x'] }, error: { style: 'information', message: 'Usually x' } })
      const both = getValidation(target, { range: 'A1:A9' }).rules.map((rule) => [rule.range, rule.rule.type, rule.error?.style])
      target.workbook.undo()
      const undone = getValidation(target, { range: 'A1:A9' }).rules.map((rule) => [rule.range, rule.rule.type])

      return { both, undone }
    })

    expect(result.both).toEqual([
      ['A1:A2,A5:A9', 'whole', 'stop'],
      ['A3:A4', 'list', 'information']
    ])
    expect(result.undone).toEqual([['A1:A9', 'whole']])
  })

  it('clears rules from cells, leaving them on the rest, in one step to undo', async () => {
    const { result } = await run(async (target) => {
      await setValidation(target, { range: 'A1:A5', rule: { type: 'textLength', operator: 'equal', value: 3 } })
      const cleared = await clearValidation(target, { range: 'A2:A3' })
      const left = getValidation(target, { range: 'A1:A5' }).rules.map((rule) => rule.range)
      const none = await clearValidation(target, { range: 'C1' })
      target.workbook.undo()

      return { cleared, left, none, back: getValidation(target, { range: 'A1:A5' }).rules.map((rule) => rule.range) }
    })

    expect(result.cleared).toEqual({ sheet: 'Orders', range: 'A2:A3', cleared: 1 })
    expect(result.left).toEqual(['A1,A4:A5'])
    expect(result.none.cleared).toBe(0)
    expect(result.back).toEqual(['A1:A5'])
  })

  it('says what is wrong with a rule', async () => {
    const { result } = await run((target) =>
      Promise.all(
        [
          { rule: { type: 'colour' } },
          { rule: { type: 'list' } },
          { rule: { type: 'list', items: ['a,b'] } },
          { rule: { type: 'list', items: ['x'.repeat(200), 'y'.repeat(60)] } },
          { rule: { type: 'list', items: ['a'], source: 'A1:A2' } },
          { rule: { type: 'list', source: 'Nowhere!A1:A2' } },
          { rule: { type: 'whole', value: 3 } },
          { rule: { type: 'whole', operator: 'between', min: 1 } },
          { rule: { type: 'whole', operator: 'between', min: 9, max: 1 } },
          { rule: { type: 'whole', operator: 'equal', value: 2.5 } },
          { rule: { type: 'decimal', operator: 'equal', value: 'lots' } },
          { rule: { type: 'date', operator: 'equal', value: '9/10/2026' } },
          { rule: { type: 'textLength', operator: 'greaterThan', value: -1 } },
          { rule: { type: 'custom' } },
          { rule: { type: 'whole', operator: 'equal', value: 1 }, input: { title: 'x'.repeat(33) } },
          { rule: { type: 'whole', operator: 'equal', value: 1 }, error: { style: 'loud' } }
        ].map((args) => setValidation(target, { range: 'A1', ...args }).catch((error: Error) => error.message))
      )
    )

    expect(result).toEqual([
      'A rule\'s type is list, whole, decimal, date, textLength, custom, any: {"type": "list", "items": ["Yes", "No"]} or {"type": "whole", "operator": "between", "min": 1, "max": 10}',
      'Give the list its items (["Yes", "No"]) or the cells they are in (source: "A2:A9")',
      'List items cannot have commas in them (Excel separates items with commas): put such items in cells and give their range as source',
      'The items are 261 characters together; Excel keeps at most 255 written into a rule: put them in cells and give their range as source',
      'A list takes its items from items or from source (cells), not both',
      'There is no sheet called “Nowhere”; the sheets are Orders, Lists',
      'Say how to compare: operator is one of between, notBetween, equal, notEqual, greaterThan, lessThan, greaterThanOrEqual, lessThanOrEqual',
      'between takes a min and a max',
      'min (9) is more than max (1)',
      'The value is a whole number for a whole-number rule; not 2.5',
      'The value is a number, or a formula like =B1; not “lots”',
      'The date is a date as yyyy-mm-dd (2026-10-09), or a formula like =TODAY(); not “9/10/2026”',
      'The length is a length of text: 0 or more, not -1',
      'A custom rule is a formula that is TRUE for the values allowed, worked out for the first cell: {"type": "custom", "formula": "=B2<=C2"}',
      'The input message’s title is 33 characters long; Excel keeps at most 32',
      'An error alert’s style is stop (the value is refused), warning (the person may keep it) or information'
    ])
  })
})
