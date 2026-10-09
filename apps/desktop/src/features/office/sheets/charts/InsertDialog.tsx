import { useEffect, useMemo, useState } from 'react'
import { CHART_KINDS, type ChartKind, type ChartSpec } from '../../../../../shared/office/charts.ts'
import { GlassButton } from '../../../../components/ui/glass.tsx'
import { cn } from '../../../../lib/cn.ts'
import { messageOf } from '../../../canvas/errors.ts'
import { Modal } from '../../shell/dialogs.tsx'
import { liveTarget } from '../live.ts'
import { closeDialog, openDialog } from '../ui/overlay.tsx'
import { readGrid } from './cells.ts'
import { type ChartValues, chartValues } from './data.ts'
import { KindIcon } from './kinds.tsx'
import { insertChart } from './model.ts'
import { ChartPreview } from './Preview.tsx'
import { KIND_NAMES, KIND_REASONS, recommend } from './recommend.ts'
import { selectChart } from './select.ts'
import { newChart, rangeText } from './spec.ts'

/* Insert → Chart…: the kinds of chart that suit the selection first, each pictured with its data, then every kind. */

interface Choice {
  key: string
  kind: ChartKind
  stacking?: 'stacked' | 'percent'
  reason: string
  preview?: { spec: ChartSpec; values: ChartValues }
}

interface Plan {
  /** The cells charted, the table around a single cell included. */
  cells: string
  recommended: Choice[]
  all: Choice[]
  error: string
}

function planFor(docKey: string, range: string): Plan {
  const target = liveTarget(docKey)

  if (!target) {
    return { cells: '', recommended: [], all: [], error: 'This workbook is not on screen' }
  }

  try {
    const { block } = newChart(target, { range })
    const read = (cells: Parameters<typeof readGrid>[1]) => readGrid(target.workbook, cells)
    const pictured = (kind: ChartKind, stacking?: 'stacked' | 'percent') => {
      const { spec } = newChart(target, { range, kind, settings: stacking ? { stacking } : {} })

      return { spec, values: chartValues(spec, read) }
    }

    return {
      cells: rangeText(target.workbook, { sheet: block.sheet.getSheetId(), ...block.cells }),
      recommended: recommend(block.grid).map((entry) => ({ key: `${entry.kind} ${entry.stacking ?? ''}`, ...entry, preview: pictured(entry.kind, entry.stacking) })),
      all: CHART_KINDS.map((kind) => ({ key: kind, kind, reason: KIND_REASONS[kind] })),
      error: ''
    }
  } catch (error) {
    return { cells: '', recommended: [], all: [], error: messageOf(error) }
  }
}

const nameOf = (choice: Choice) => (choice.stacking === 'stacked' ? `Stacked ${KIND_NAMES[choice.kind].toLowerCase()}` : choice.stacking === 'percent' ? `100% ${KIND_NAMES[choice.kind].toLowerCase()}` : KIND_NAMES[choice.kind])

function InsertChartDialog({ docKey, range: initial }: { docKey: string; range: string }) {
  const [range, setRange] = useState(initial)
  const [typed, setTyped] = useState(initial)
  const plan = useMemo(() => planFor(docKey, range), [docKey, range])
  const [picked, setPicked] = useState<Choice | null>(plan.recommended[0] ?? null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPicked(plan.recommended[0] ?? plan.all[0] ?? null)
    setTyped(plan.cells || range)
  }, [plan])

  const insert = async (choice: Choice | null) => {
    const target = liveTarget(docKey)

    if (!target || !choice || busy) {
      return
    }

    setBusy(true)
    setError('')

    try {
      const { chart } = await insertChart(target, { range: plan.cells || range, kind: choice.kind, ...(choice.stacking ? { stacking: choice.stacking } : {}) })
      closeDialog()
      selectChart(target, chart)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Insert chart" onClose={closeDialog}>
      <label className="mb-3 flex items-center gap-2 text-[12px] text-fg-2">
        <span className="shrink-0">Data</span>
        <input
          value={typed}
          aria-label="Cells to chart"
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => setRange(typed)}
          onKeyDown={(event) => event.key === 'Enter' && setRange(typed)}
          className="glass-input h-7 min-w-0 flex-1 rounded-md px-2 text-[12px] text-fg outline-none"
        />
      </label>
      <div className="-mx-1 flex max-h-[min(30rem,60vh)] flex-col gap-3 overflow-y-auto px-1">
        {plan.error ? (
          <p className="text-[12.5px] text-fg-2">{plan.error}</p>
        ) : (
          <>
            <section>
              <div className="mb-1.5 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">Recommended</div>
              <div className="grid grid-cols-3 gap-2">
                {plan.recommended.map((choice) => (
                  <button
                    key={choice.key}
                    type="button"
                    onClick={() => setPicked(choice)}
                    onDoubleClick={() => void insert(choice)}
                    className={cn('flex flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors duration-120', picked?.key === choice.key ? 'border-accent bg-accent-soft' : 'border-line hover:bg-white/8')}
                  >
                    {choice.preview && <ChartPreview spec={choice.preview.spec} values={choice.preview.values} className="h-16 w-full" />}
                    <span className="px-0.5 text-[12px] text-fg">{nameOf(choice)}</span>
                    <span className="line-clamp-2 px-0.5 text-[11px] leading-snug text-fg-3">{choice.reason}</span>
                  </button>
                ))}
              </div>
            </section>
            <section>
              <div className="mb-1.5 text-[11.5px] font-medium tracking-wide text-fg-3 uppercase">All charts</div>
              <div className="flex flex-col gap-0.5">
                {plan.all.map((choice) => (
                  <button
                    key={choice.key}
                    type="button"
                    onClick={() => setPicked(choice)}
                    onDoubleClick={() => void insert(choice)}
                    className={cn('flex h-8 items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-120', picked?.key === choice.key ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg')}
                  >
                    <KindIcon kind={choice.kind} size={16} className="shrink-0 text-fg-2" />
                    <span className="w-16 shrink-0 text-[12px] text-fg">{KIND_NAMES[choice.kind]}</span>
                    <span className="truncate text-[11.5px] text-fg-3">{choice.reason}</span>
                  </button>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
      {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <GlassButton variant="ghost" onClick={closeDialog}>
          Cancel
        </GlassButton>
        <GlassButton variant="primary" disabled={!picked || Boolean(plan.error) || busy} onClick={() => void insert(picked)}>
          Insert
        </GlassButton>
      </div>
    </Modal>
  )
}

/** Open Insert chart for `range` (the selection, or a cell in a table) in a document. */
export function openInsertChart(docKey: string, range: string): void {
  openDialog(docKey, <InsertChartDialog docKey={docKey} range={range} />)
}
