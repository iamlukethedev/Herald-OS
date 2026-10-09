import { type ICommandInfo, type IDisposable, type IMutationInfo, IUniverInstanceService, type Univer } from '@univerjs/core'
import { EffectRefRangId, getSheetCommandTarget, handleDefaultRangeChangeWithEffectRefCommands, SheetInterceptorService } from '@univerjs/sheets'
import { DrawingApplyType, ISheetDrawingService, SetDrawingApplyMutation } from '@univerjs/sheets-drawing'
import { CHART_COMPONENT, type ChartDrawing, type ChartRange, type ChartSeries, type ChartSpec, isChartData } from '../../../../../shared/office/charts.ts'

/*
 * A chart's ranges move with their cells: rows and columns inserted, deleted or moved before or inside
 * them shift, stretch and shrink them as they do formulas, in the same step to undo as the change. A
 * series whose cells are all deleted goes; so do categories and a name cell that are.
 */

const MOVING = new Set<string>([
  EffectRefRangId.InsertRowCommandId,
  EffectRefRangId.InsertColCommandId,
  EffectRefRangId.RemoveRowCommandId,
  EffectRefRangId.RemoveColCommandId,
  EffectRefRangId.MoveRowsCommandId,
  EffectRefRangId.MoveColsCommandId,
  EffectRefRangId.MoveRangeCommandId,
  EffectRefRangId.DeleteRangeMoveUpCommandId,
  EffectRefRangId.DeleteRangeMoveLeftCommandId,
  EffectRefRangId.InsertRangeMoveDownCommandId,
  EffectRefRangId.InsertRangeMoveRightCommandId
])

/** Where `range` goes when `command` runs on sheet `sheetId`: moved, resized, or null when its cells are gone. */
function moved(range: ChartRange, command: ICommandInfo, sheetId: string): ChartRange | null {
  if (range.sheet !== sheetId) {
    return range
  }

  const next = handleDefaultRangeChangeWithEffectRefCommands({ startRow: range.startRow, endRow: range.endRow, startColumn: range.startColumn, endColumn: range.endColumn }, command)

  return next ? { sheet: range.sheet, startRow: next.startRow, endRow: next.endRow, startColumn: next.startColumn, endColumn: next.endColumn } : null
}

const same = (a: ChartRange, b: ChartRange) => a.startRow === b.startRow && a.endRow === b.endRow && a.startColumn === b.startColumn && a.endColumn === b.endColumn

/** A chart's spec after `command` on sheet `sheetId`: the same spec when none of its ranges move. */
export function specAfter(spec: ChartSpec, command: ICommandInfo, sheetId: string): ChartSpec {
  let changed = false
  const move = (range: ChartRange) => {
    const next = moved(range, command, sheetId)
    changed ||= !next || !same(next, range)

    return next
  }
  const series = spec.series.flatMap((entry): ChartSeries[] => {
    const values = move(entry.values)

    if (!values) {
      return []
    }

    const next: ChartSeries = { ...entry, values }
    const categories = entry.categories ? move(entry.categories) : null
    const cell = entry.name?.cell ? move(entry.name.cell) : null

    if (entry.categories && !categories) {
      delete next.categories
    } else if (categories) {
      next.categories = categories
    }

    if (entry.name?.cell && !cell) {
      delete next.name
    } else if (cell) {
      next.name = { cell }
    }

    return [next]
  })

  return changed ? { ...spec, series } : spec
}

/** The sheet a command changes, when its cells stay on that sheet. */
function sheetOf(instances: IUniverInstanceService, command: ICommandInfo): { unitId: string; subUnitId: string } | null {
  const params = (command.params ?? {}) as { unitId?: string; subUnitId?: string; fromUnitId?: string; fromSubUnitId?: string; toUnitId?: string; toSubUnitId?: string }

  if (command.id === EffectRefRangId.MoveRangeCommandId && (params.toSubUnitId ?? params.fromSubUnitId) !== params.fromSubUnitId) {
    return null
  }

  const target = getSheetCommandTarget(instances, { unitId: params.unitId ?? params.fromUnitId, subUnitId: params.subUnitId ?? params.fromSubUnitId })

  return target ? { unitId: target.unitId, subUnitId: target.subUnitId } : null
}

/** Keep the charts of every workbook in `univer` on their cells as rows and columns move; gives what stops it. */
export function trackChartRanges(univer: Univer): IDisposable {
  const injector = univer.__getInjector()
  const instances = injector.get(IUniverInstanceService)
  const drawings = injector.get(ISheetDrawingService)

  return injector.get(SheetInterceptorService).interceptCommand({
    getMutations: (command) => {
      const redos: IMutationInfo[] = []
      const undos: IMutationInfo[] = []
      const changed = MOVING.has(command.id) ? sheetOf(instances, command) : null

      if (!changed) {
        return { redos, undos }
      }

      const { unitId, subUnitId: sheetId } = changed

      for (const [subUnitId, sheet] of Object.entries(drawings.getDrawingDataForUnit(unitId) ?? {})) {
        for (const drawing of Object.values((sheet?.data ?? {}) as unknown as Record<string, ChartDrawing>)) {
          if (drawing.componentKey !== CHART_COMPONENT || !isChartData(drawing.data)) {
            continue
          }

          const spec = specAfter(drawing.data.spec, command, sheetId)

          if (spec === drawing.data.spec) {
            continue
          }

          const { undo, redo, objects } = drawings.getBatchUpdateOp([{ unitId, subUnitId, drawingId: drawing.drawingId, data: { ...drawing.data, spec } } as never]) as { undo: unknown; redo: unknown; objects: unknown }

          if (redo) {
            redos.push({ id: SetDrawingApplyMutation.id, params: { unitId, subUnitId, op: redo, objects, type: DrawingApplyType.UPDATE } })
            undos.push({ id: SetDrawingApplyMutation.id, params: { unitId, subUnitId, op: undo, objects, type: DrawingApplyType.UPDATE } })
          }
        }
      }

      return { redos, undos }
    }
  })
}
