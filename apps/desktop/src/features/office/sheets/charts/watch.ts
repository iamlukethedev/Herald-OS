import { CommandType, ICommandService, type Univer } from '@univerjs/core'
import type { ChartRange, ChartSpec } from '../../../../../shared/office/charts.ts'

/*
 * Charts follow their cells. One listener per Univer hears every change to the workbook and tells the
 * charts whose cells it touched, a moment later, as a paste or a recalculation is many changes at once.
 */

interface Watcher {
  unitId: string
  ranges: ChartRange[]
  notify: () => void
  timer?: ReturnType<typeof setTimeout>
}

/** Values typed, pasted, sorted in or worked out by formulas: the one change precise enough to check cell by cell. */
const SET_VALUES = 'sheet.mutation.set-range-values'
/** Changes that move or size things without touching what cells hold. */
const UNRELATED = new Set(['sheet.mutation.set-drawing-apply', 'sheet.mutation.set-worksheet-row-height', 'sheet.mutation.set-worksheet-col-width', 'sheet.mutation.set-worksheet-row-auto-height', 'sheet.mutation.set-worksheet-row-is-auto-height'])
/** How long after the last change a chart reads its cells again. */
const SETTLE = 80

const hubs = new WeakMap<Univer, Set<Watcher>>()

/** Every range a chart reads: its series' values, names and categories. */
export const rangesOf = (spec: ChartSpec): ChartRange[] => spec.series.flatMap((series) => [series.values, ...(series.categories ? [series.categories] : []), ...(series.name?.cell ? [series.name.cell] : [])])

/** Whether a change to a sheet touches any of `ranges`: any change to their sheet does, but new values only where they land. */
function touches(ranges: ChartRange[], id: string, params: { subUnitId?: string; cellValue?: Record<string, Record<string, unknown>> }): boolean {
  const onSheet = ranges.filter((range) => !params.subUnitId || range.sheet === params.subUnitId)

  if (!onSheet.length || id !== SET_VALUES || !params.cellValue) {
    return onSheet.length > 0
  }

  const box = { startRow: Infinity, endRow: -Infinity, startColumn: Infinity, endColumn: -Infinity }

  for (const [row, columns] of Object.entries(params.cellValue)) {
    for (const column of Object.keys(columns ?? {})) {
      box.startRow = Math.min(box.startRow, Number(row))
      box.endRow = Math.max(box.endRow, Number(row))
      box.startColumn = Math.min(box.startColumn, Number(column))
      box.endColumn = Math.max(box.endColumn, Number(column))
    }
  }

  return onSheet.some((range) => range.startRow <= box.endRow && box.startRow <= range.endRow && range.startColumn <= box.endColumn && box.startColumn <= range.endColumn)
}

function hubOf(univer: Univer): Set<Watcher> {
  const known = hubs.get(univer)

  if (known) {
    return known
  }

  const watchers = new Set<Watcher>()
  univer
    .__getInjector()
    .get(ICommandService)
    .onCommandExecuted((command) => {
      const params = command.params as { unitId?: string; subUnitId?: string; cellValue?: Record<string, Record<string, unknown>> } | undefined

      if (command.type !== CommandType.MUTATION || !params?.unitId || UNRELATED.has(command.id)) {
        return
      }

      for (const watcher of watchers) {
        if (watcher.unitId === params.unitId && touches(watcher.ranges, command.id, params)) {
          clearTimeout(watcher.timer)
          watcher.timer = setTimeout(watcher.notify, SETTLE)
        }
      }
    })
  hubs.set(univer, watchers)

  return watchers
}

/** Call `notify` a moment after changes touch `ranges` in workbook `unitId`; gives what stops it. */
export function watchCells(univer: Univer, unitId: string, ranges: ChartRange[], notify: () => void): () => void {
  const watchers = hubOf(univer)
  const watcher: Watcher = { unitId, ranges, notify }
  watchers.add(watcher)

  return () => {
    clearTimeout(watcher.timer)
    watchers.delete(watcher)
  }
}
