import { useEffect, useRef } from 'react'
import type { WorkbookSnapshot } from '../../../../shared/office/workbook.ts'
import { quoteSheet } from '../../../../shared/office/xlsx/address.ts'
import type { EditorHandle, OfficeDocument } from '../types.ts'
import { type Mounted, mountIn, unmount } from '../univer/mount.ts'
import { createSheetsEngine, type SheetsEngine } from '../univer/sheets.ts'
import { setLiveEngine } from './live.ts'
import { activeSheetOf } from './print.ts'
import { sheetsSession } from './store.ts'

/** One workbook in Univer Sheets, its formulas worked out in a worker. */
export function SheetsEditor({ doc }: { doc: OfficeDocument<WorkbookSnapshot> }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let mounted: Mounted<SheetsEngine> | null = null
    let off = () => {}
    let changedAt = -Infinity
    const start = (model: WorkbookSnapshot) => {
      mounted = mountIn(host.current!, (element) => createSheetsEngine(element, model, { worker: true }))
      const { engine } = mounted
      const active = activeSheetOf(model)

      // The sheet the file had in front (Univer starts on the first one).
      if (active && engine.api.getWorkbook(engine.unitId)?.getSheetBySheetId(active)) {
        engine.api.getWorkbook(engine.unitId)?.setActiveSheet(active)
      }

      off = engine.onChange(() => {
        changedAt = performance.now()
        sheetsSession.changed(doc)
      })
      setLiveEngine(doc.key, engine)
    }
    const stop = (later: boolean) => {
      off()
      setLiveEngine(doc.key, null)
      unmount(mounted, later)
      mounted = null
    }
    const handle: EditorHandle<WorkbookSnapshot> = {
      snapshot: () => ({ ...mounted!.engine.snapshot(), activeSheetId: mounted!.engine.position().sheetId }),
      // Formula results come from the worker a moment after a change (about 150 ms on 50,000 cells); waiting
      // when nothing changed would only hold the save up, as Univer gives a calculation half a second to start.
      settle: async () => {
        if (mounted && performance.now() - changedAt < 1000) {
          await mounted.engine.api.getFormula().onCalculationResultApplied(5000).catch(() => {})
        }
      },
      load: (model) => {
        stop(false)
        start(model)
      },
      undo: () => mounted?.engine.undo(),
      redo: () => mounted?.engine.redo(),
      status: () => {
        const position = mounted?.engine.position()

        return position ? [position.sheet, position.selection].filter(Boolean).join(' · ') : ''
      },
      detail: () => {
        const position = mounted?.engine.position()

        return position ? `${position.sheet}${position.selection ? `!${position.selection}` : ''}` : undefined
      },
      selection: () => {
        const position = mounted?.engine.position()

        return position?.selection ? `${quoteSheet(position.sheet)}!${position.selection}` : undefined
      },
      dispose: () => stop(false)
    }
    start(doc.initial)
    sheetsSession.attach(doc, handle)

    return () => {
      // The workbook outlives its view (a closed window keeps it until Herald quits): it keeps what was typed.
      if (mounted) {
        doc.initial = mounted.engine.snapshot()
      }

      if (doc.editor === handle) {
        sheetsSession.attach(doc, null)
      }

      stop(true)
    }
  }, [doc.key])

  return <div ref={host} className="relative min-w-0 flex-1" />
}
