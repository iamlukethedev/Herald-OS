import { describe, expect, it } from 'vitest'
import { CELL_TYPE, newSheet, newWorkbook, type WorkbookSnapshot } from '../../../../../shared/office/workbook.ts'
import { nameProblem } from '../../../../../shared/office/xlsx/rules.ts'
import { withHeadlessSheets } from '../headless.ts'
import { readRange, type SheetsTarget, settled, writeRange } from '../model.ts'
import { createName, deleteName, goToName, listNames, updateName } from './model.ts'

function budget(): WorkbookSnapshot {
  const sheet = newSheet('s1', 'Budget', {
    0: { 0: { v: 'Item', t: CELL_TYPE.string }, 1: { v: 'Cost', t: CELL_TYPE.string } },
    1: { 0: { v: 'Rent', t: CELL_TYPE.string }, 1: { v: 1200, t: CELL_TYPE.number } },
    2: { 0: { v: 'Food', t: CELL_TYPE.string }, 1: { v: 300, t: CELL_TYPE.number } },
    3: { 0: { v: 'Bus', t: CELL_TYPE.string }, 1: { v: 60, t: CELL_TYPE.number } }
  })

  return newWorkbook('book', 'Budget', [sheet, newSheet('s2', 'Q1 sales', { 0: { 0: { v: 5, t: CELL_TYPE.number } } })])
}

const run = <T>(work: (target: SheetsTarget) => Promise<T> | T) => withHeadlessSheets(budget(), ({ univer, workbook }) => work({ univer, workbook }))

describe('name rules', () => {
  it('takes the names Excel takes', () => {
    for (const name of ['Total', '_rate', '\\path', 'Tax.Rate', 'Größe', 'Q1_2026', 'a?b', 'ABCD1', 'XFE1', 'x'.repeat(255)]) {
      expect(nameProblem(name), name).toBeNull()
    }
  })

  it('says why Excel would not take a name', () => {
    expect(nameProblem('')).toBe('Give the name')
    expect(nameProblem('1st')).toMatch(/starts with a letter, an underscore \(_\) or a backslash/)
    expect(nameProblem('My total')).toMatch(/it has a space/)
    expect(nameProblem('cost-2')).toMatch(/it has “-”/)
    expect(nameProblem('A1')).toMatch(/it is a cell reference$/)
    expect(nameProblem('xfd1048576')).toMatch(/it is a cell reference$/)
    expect(nameProblem('R1C1')).toMatch(/R1C1 style/)
    expect(nameProblem('rc')).toMatch(/R1C1 style/)
    expect(nameProblem('R')).toMatch(/current row and column/)
    expect(nameProblem('c')).toMatch(/current row and column/)
    expect(nameProblem('TRUE')).toMatch(/logical value/)
    expect(nameProblem('x'.repeat(256))).toMatch(/256 characters long; a name has at most 255/)
  })
})

describe('named ranges', () => {
  it('names cells for the workbook, which formulas can use, in one step to undo', async () => {
    const { result } = await run(async (target) => {
      const made = await createName(target, { name: 'Costs', refersTo: 'B2:B4', comment: 'What the month costs' })
      await writeRange(target, { range: 'D1', values: [['=SUM(Costs)']] })
      await settled(target)
      const total = readRange(target, { range: 'D1' }).values[0][0]
      target.workbook.undo()
      const afterFormulaUndo = listNames(target)
      target.workbook.undo()

      return { made, total, afterFormulaUndo, afterUndo: listNames(target) }
    })

    expect(result.made).toEqual({ name: 'Costs', refersTo: '=Budget!$B$2:$B$4', scope: 'workbook', comment: 'What the month costs' })
    expect(result.total).toBe(1560)
    expect(result.afterFormulaUndo.map((name) => name.name)).toEqual(['Costs'])
    expect(result.afterUndo).toEqual([])
  })

  it('names a formula, cells on a sheet with a space in its name, and several areas', async () => {
    const { result } = await run(async (target) => [
      await createName(target, { name: 'Rate', refersTo: '=0.07' }),
      await createName(target, { name: 'Sales', refersTo: "'q1 sales'!a1:a9" }),
      await createName(target, { name: 'Picked', refersTo: 'Budget!A2,Budget!B3:B4' }),
      await createName(target, { name: 'Whole', refersTo: '=Budget!B:B' }),
      await createName(target, { name: 'Total', refersTo: '=SUM(Budget!$B$2:$B$4)*(1+Rate)' })
    ])

    expect(result.map((name) => name.refersTo)).toEqual(['=0.07', "='Q1 sales'!$A$1:$A$9", '=Budget!$A$2,Budget!$B$3:$B$4', '=Budget!$B:$B', '=SUM(Budget!$B$2:$B$4)*(1+Rate)'])
  })

  it('lets a sheet have a name the workbook has, but not twice in one scope, whatever the case', async () => {
    const { result } = await run(async (target) => {
      await createName(target, { name: 'Total', refersTo: 'Budget!B2:B4' })
      const local = await createName(target, { name: 'TOTAL', refersTo: "'Q1 sales'!A1", scope: 'q1 sales' })
      const again = await createName(target, { name: 'total', refersTo: 'A1' }).catch((error: Error) => error.message)
      const onSheet = await createName(target, { name: 'Total', refersTo: 'A1', scope: 'Q1 sales' }).catch((error: Error) => error.message)

      return { local, again, onSheet, names: listNames(target) }
    })

    expect(result.local).toEqual({ name: 'TOTAL', refersTo: "='Q1 sales'!$A$1", scope: 'Q1 sales', comment: '' })
    expect(result.again).toBe('There is a name “Total” in the workbook already: give another name, or change that one')
    expect(result.onSheet).toBe('There is a name “TOTAL” on Q1 sales already: give another name, or change that one')
    expect(result.names.map((name) => `${name.name}@${name.scope}`)).toEqual(['Total@workbook', 'TOTAL@Q1 sales'])
  })

  it('says what is wrong with a name or what it stands for', async () => {
    const { result } = await run(async (target) =>
      Promise.all(
        [
          { name: 'Two words', refersTo: 'A1' },
          { name: 'B2', refersTo: 'A1' },
          { name: 'Fine', refersTo: '' },
          { name: 'Fine', refersTo: 'Nowhere!A1' },
          { name: 'Fine', refersTo: '=SUM(A1:A3' },
          { name: 'Fine', refersTo: 'A1', scope: 'Nowhere' }
        ].map((args) => createName(target, args).catch((error: Error) => error.message))
      )
    )

    expect(result).toEqual([
      '“Two words” cannot be a name: it has a space, and after its first character a name has only letters, digits, periods, underscores, backslashes and question marks',
      '“B2” cannot be a name: it is a cell reference',
      'Say what the name stands for: cells like Data!B2:D9 (on the sheet in front when no sheet is named), or a formula like =0.07',
      'There is no sheet called “Nowhere”; the sheets are Budget, Q1 sales',
      '“=SUM(A1:A3” is neither cells nor a whole formula: check its brackets and quotes',
      'There is no sheet called “Nowhere”; the sheets are Budget, Q1 sales'
    ])
  })

  it('renames a name and changes what it stands for and its comment, each in one step to undo', async () => {
    const { result } = await run(async (target) => {
      await createName(target, { name: 'Costs', refersTo: 'B2:B3', comment: 'Old' })
      const renamed = await updateName(target, { name: 'costs', newName: 'Spending', refersTo: 'B2:B4', comment: '' })
      target.workbook.undo()
      const undone = listNames(target)
      const commented = await updateName(target, { name: 'Costs', comment: 'New' })
      const none = await updateName(target, { name: 'Costs' }).catch((error: Error) => error.message)
      const missing = await updateName(target, { name: 'Nope', comment: 'x' }).catch((error: Error) => error.message)
      await createName(target, { name: 'Other', refersTo: 'A1' })
      const clash = await updateName(target, { name: 'Other', newName: 'COSTS' }).catch((error: Error) => error.message)

      return { renamed, undone, commented, none, missing, clash }
    })

    expect(result.renamed).toEqual({ name: 'Spending', refersTo: '=Budget!$B$2:$B$4', scope: 'workbook', comment: '' })
    expect(result.undone).toEqual([{ name: 'Costs', refersTo: '=Budget!$B$2:$B$3', scope: 'workbook', comment: 'Old' }])
    expect(result.commented.comment).toBe('New')
    expect(result.none).toBe('Say what to change: newName, refersTo or comment')
    expect(result.missing).toBe('There is no name called “Nope”; the names are Costs')
    expect(result.clash).toBe('There is a name “Costs” in the workbook already: give another name, or change that one')
  })

  it('removes a name in one step to undo, the one of the sheet in front first when two are spelled alike', async () => {
    const { result } = await run(async (target) => {
      await createName(target, { name: 'Total', refersTo: 'Budget!B2:B4' })
      await createName(target, { name: 'Total', refersTo: "'Q1 sales'!A1", scope: 'Q1 sales' })
      target.workbook.setActiveSheet(target.workbook.getSheetByName('Q1 sales')!)
      const removed = await deleteName(target, { name: 'total' })
      const left = listNames(target)
      target.workbook.undo()
      const back = listNames(target)
      const scoped = await deleteName(target, { name: 'Total', scope: 'workbook' })

      return { removed, left, back, scoped, last: listNames(target) }
    })

    expect(result.removed.scope).toBe('Q1 sales')
    expect(result.left.map((name) => name.scope)).toEqual(['workbook'])
    expect(result.back.map((name) => name.scope)).toEqual(['workbook', 'Q1 sales'])
    expect(result.scoped.scope).toBe('workbook')
    expect(result.last.map((name) => name.scope)).toEqual(['Q1 sales'])
  })

  it('goes to a name’s cells on their sheet, and says when a name is a formula', async () => {
    const { result, snapshot } = await run(async (target) => {
      await createName(target, { name: 'Sales', refersTo: "'Q1 sales'!A1:A3" })
      await createName(target, { name: 'Rate', refersTo: '=0.07' })
      const went = goToName(target, { name: 'sales' })
      const selected = target.workbook.getActiveSheet().getSelection()?.getActiveRange()?.getA1Notation()
      const formula = (() => {
        try {
          return goToName(target, { name: 'Rate' })
        } catch (error) {
          return (error as Error).message
        }
      })()

      return { went, selected, formula }
    })

    expect(result.went).toEqual({ name: 'Sales', sheet: 'Q1 sales', range: 'A1:A3' })
    expect(result.selected).toBe('A1:A3')
    expect(result.formula).toBe('“Rate” stands for a formula (=0.07), not cells to go to')
    expect(snapshot.activeSheetId).toBe('s2')
  })
})
