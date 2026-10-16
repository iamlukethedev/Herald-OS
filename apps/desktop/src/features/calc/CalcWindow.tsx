import { useStore } from '@nanostores/react'
import { IconCalculator, IconChartLine, IconHistory, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconNotes } from '@tabler/icons-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CalcHistoryEntry } from '../../../shared/calc.ts'
import { cn } from '../../lib/cn.ts'
import { logFailure } from '../../lib/report.ts'
import { keysLabel, matches } from '../../lib/shortcuts.ts'
import { updatePrefs } from '../../store/backend.ts'
import { isPanels } from '../../store/shell.ts'
import { useReducedMotion } from '../pet/hooks.ts'
import { GraphView } from './graph/GraphView.tsx'
import type { GraphEntry } from './graph/types.ts'
import { HistoryView } from './history/HistoryView.tsx'
import { useElementSize } from './hooks.ts'
import { KeypadView } from './keypad/KeypadView.tsx'
import { sidebarShown } from './notepad/layout.ts'
import { Notepad } from './notepad/Notepad.tsx'
import { NotesActions } from './notepad/NotesActions.tsx'
import { CALC_VIEWS, type CalcRequest, type CalcView, planRequest, readCalcRequest } from './requests.ts'
import { SettingsMenu } from './settings/SettingsMenu.tsx'
import { $calcGraph, $calcRequest, $calcView, $historyQuery, $noteScope, $notesSidebar, signalNotepad, takeCalcRequest } from './store.ts'

const VIEWS: Record<CalcView, { label: string; icon: React.ReactNode }> = {
  notes: { label: 'Notes', icon: <IconNotes size={16} /> },
  keypad: { label: 'Keypad', icon: <IconCalculator size={16} /> },
  graph: { label: 'Graph', icon: <IconChartLine size={16} /> },
  history: { label: 'History', icon: <IconHistory size={16} /> }
}

/** From this wide the view switcher names its views. */
const VIEW_LABELS_PX = 560
/** From this wide the copy buttons name where they copy to. */
const ACTION_LABELS_PX = 820
const HEADER_PX = 48

/** Act on a request once: its keypad, its note, its graph and its search, then its view. */
function handleRequest(request: CalcRequest | null): void {
  if (!request || !takeCalcRequest(request)) {
    return
  }

  const plan = planRequest(request)

  if (plan.plot) {
    $calcGraph.set({
      entries: (plan.plot.entries ?? []).map((text, index) => ({ id: `request-${request.at}-${index}`, text })),
      series: plan.plot.series ?? [],
      xMin: plan.plot.xMin,
      xMax: plan.plot.xMax,
      version: $calcGraph.get().version + 1
    })
  }

  if (plan.search !== undefined) {
    $historyQuery.set(plan.search)
  }

  if (plan.text) {
    signalNotepad('new', plan.text, false)
  }

  const show = () => {
    if (plan.view) {
      $calcView.set(plan.view)
    }
  }

  // The keypad asked for is in the prefs before the Keypad view shows, so the old one never flashes.
  if (plan.keypad) {
    updatePrefs({ calc: { keypad: plan.keypad } })
      .catch(logFailure('prefs.set'))
      .finally(show)
  } else {
    show()
  }
}

/** A past calculation back in the note in front, as its last line. */
function insertFromHistory(entry: CalcHistoryEntry): void {
  signalNotepad('insert', entry.input, true)
  $calcView.set('notes')
}

/**
 * Herald Calc: the sentence notepad, the keypads, the graph and the history, one view at a time
 * under a compact header. Views stay mounted once shown, so each keeps its state; hidden ones are
 * inert and never take the keyboard. In a floating window (desktop mode) or its own (panels mode).
 */
export function CalcWindow({ payload }: { payload?: Record<string, unknown> }) {
  const root = useRef<HTMLDivElement>(null)
  const size = useElementSize(root)
  const view = useStore($calcView)
  const stored = useStore($calcRequest)
  const graph = useStore($calcGraph)
  const scope = useStore($noteScope)
  const query = useStore($historyQuery)
  const sidebar = useStore($notesSidebar)
  const reduced = useReducedMotion()
  const requested = useMemo(() => readCalcRequest(payload), [payload])
  const [mounted, setMounted] = useState<ReadonlySet<CalcView>>(() => new Set([view]))

  if (!mounted.has(view)) {
    setMounted(new Set([...mounted, view]))
  }

  useEffect(() => {
    handleRequest(requested)
  }, [requested])

  useEffect(() => {
    handleRequest(stored)
  }, [stored])

  // ⌘1-4 switch views and ⌘N starts a note, ahead of the desktop's own shortcuts while Calc has the
  // keyboard; panels mode gives Calc a window of its own, so there the whole page listens.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const index = CALC_VIEWS.findIndex((_, position) => matches(event, `mod+${position + 1}`))
      const newNote = index < 0 && $calcView.get() === 'notes' && matches(event, 'mod+n')

      if (index < 0 && !newNote) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (newNote) {
        signalNotepad('new', '', true)
      } else {
        $calcView.set(CALC_VIEWS[index])
      }
    }

    if (isPanels) {
      window.addEventListener('keydown', onKeyDown)

      return () => window.removeEventListener('keydown', onKeyDown)
    }

    const element = root.current
    element?.addEventListener('keydown', onKeyDown)

    return () => element?.removeEventListener('keydown', onKeyDown)
  }, [])

  const editGraph = useCallback((entries: GraphEntry[]) => $calcGraph.set({ ...$calcGraph.get(), entries }), [])
  const search = useCallback((next: string) => $historyQuery.set(next), [])
  const labels = size.width === 0 || size.width >= VIEW_LABELS_PX
  const listShown = sidebarShown(sidebar, size.width)

  const render = (id: CalcView) => {
    switch (id) {
      case 'notes':
        return <Notepad active={view === 'notes'} width={size.width} />
      case 'keypad':
        return <KeypadView active={view === 'keypad'} className="min-h-0 min-w-0 flex-1" />
      case 'graph':
        return <GraphView key={graph.version} entries={graph.entries} series={graph.series} xMin={graph.xMin} xMax={graph.xMax} scope={scope} onEntriesChange={editGraph} className="min-h-0 min-w-0 flex-1" />
      case 'history':
        return <HistoryView query={query} onQueryChange={search} onUse={insertFromHistory} className="min-h-0 min-w-0 flex-1" />
    }
  }

  return (
    <div ref={root} tabIndex={-1} className="flex h-full min-h-0 w-full min-w-0 flex-col text-fg outline-none">
      <header className="flex shrink-0 items-center gap-1 border-b border-line px-2" style={{ height: HEADER_PX }}>
        {view === 'notes' && (
          <button
            type="button"
            aria-label={listShown ? 'Hide the notes list' : 'Show the notes list'}
            aria-pressed={listShown}
            title={listShown ? 'Hide the notes list' : 'Show the notes list'}
            onClick={() => $notesSidebar.set(listShown ? 'closed' : 'open')}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors duration-150 hover:bg-white/8 hover:text-fg"
          >
            {listShown ? <IconLayoutSidebarLeftCollapse size={17} /> : <IconLayoutSidebarLeftExpand size={17} />}
          </button>
        )}
        <div role="tablist" aria-label="Calc views" className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-black/15 p-1 hairline">
          {CALC_VIEWS.map((id, index) => {
            const selected = id === view

            return (
              <button
                key={id}
                type="button"
                role="tab"
                id={`calc-tab-${id}`}
                aria-selected={selected}
                aria-controls={`calc-view-${id}`}
                aria-label={labels ? undefined : VIEWS[id].label}
                title={`${VIEWS[id].label} (${keysLabel(`mod+${index + 1}`)})`}
                onClick={() => $calcView.set(id)}
                className={cn('flex h-7 items-center gap-1.5 rounded-md text-[12.5px] transition-colors duration-150', labels ? 'px-2.5' : 'w-8 justify-center', selected ? 'bg-accent text-accent-fg' : 'text-fg-2 hover:bg-white/6 hover:text-fg')}
              >
                {VIEWS[id].icon}
                {labels && VIEWS[id].label}
              </button>
            )
          })}
        </div>
        <div className="min-w-0 flex-1" />
        {view === 'notes' && <NotesActions labels={size.width >= ACTION_LABELS_PX} />}
        <SettingsMenu maxHeight={size.height > HEADER_PX ? size.height - HEADER_PX - 12 : undefined} />
      </header>
      <div className="relative min-h-0 flex-1">
        {CALC_VIEWS.filter(id => mounted.has(id)).map(id => (
          <section
            key={id}
            id={`calc-view-${id}`}
            role="tabpanel"
            aria-labelledby={`calc-tab-${id}`}
            inert={id !== view}
            className={cn('absolute inset-0 flex min-h-0 min-w-0', id !== view && 'invisible', id === view && !reduced && 'animate-fade-in')}
          >
            {render(id)}
          </section>
        ))}
      </div>
    </div>
  )
}
