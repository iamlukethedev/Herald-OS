import { IconRectangle, IconRectangleVertical } from '@tabler/icons-react'
import type { Editor } from '@tiptap/core'
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_HEADER_DISTANCE, defaultPage, type PageMargins, PAGE_SIZES, type PageSettings, type PageSizeName, pageSizeName, round } from '../../../../shared/office/document.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { messageOf } from '../../canvas/errors.ts'
import { Modal } from '../shell/dialogs.tsx'
import { applyLive, documentSections, type PageChange, pageProblem, setPage, setSectionPage } from './model.ts'

/*
 * Format > Page Setup…: the paper's size and orientation, the margins, and how far the header and
 * footer sit from the edges, in centimetres or inches, for the whole document or for the section
 * the caret is in, with a small picture of the page as it will be.
 */

type Unit = 'cm' | 'in'

const POINTS: Record<Unit, number> = { cm: 72 / 2.54, in: 72 }

type Paper = PageSizeName | 'custom'

const PAPERS: readonly { id: Paper; label: string }[] = [...(Object.keys(PAGE_SIZES) as PageSizeName[]).map((id) => ({ id, label: PAGE_SIZES[id].label })), { id: 'custom', label: 'Custom' }]

type Field = 'width' | 'height' | 'top' | 'bottom' | 'left' | 'right' | 'header' | 'footer'

const MARGINS: readonly { id: Field; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' }
]

/** Inches where Letter is the usual paper, centimetres elsewhere. */
const usualUnit = (): Unit => (pageSizeName(defaultPage()) === 'letter' ? 'in' : 'cm')

const inUnit = (points: number, unit: Unit): string => (Number.isFinite(points) ? String(round(points / POINTS[unit], 2)) : '')

function pointsIn(text: string, unit: Unit): number {
  const value = Number(text.trim().replace(',', '.'))

  return text.trim() && Number.isFinite(value) ? round(value * POINTS[unit], 2) : Number.NaN
}

/** The margins to set: header and footer distances the page did not have stay unset while they are Word's own, so that OK without a change changes nothing. */
function marginsOf(values: Record<Field, number>, start: PageSettings): PageMargins {
  const margins: PageMargins = { top: values.top, right: values.right, bottom: values.bottom, left: values.left }

  if (start.margins.header !== undefined || values.header !== DEFAULT_HEADER_DISTANCE) {
    margins.header = values.header
  }

  if (start.margins.footer !== undefined || values.footer !== DEFAULT_HEADER_DISTANCE) {
    margins.footer = values.footer
  }

  return margins
}

export function PageSetupDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const start = useMemo(() => {
    const sections = documentSections(editor.state.doc)
    const head = editor.state.selection.head
    const section = sections.filter((entry) => entry.from <= head).pop() ?? sections[0]

    return { count: sections.length, index: section.index, page: section.page }
  }, [editor])
  const [unit, setUnit] = useState<Unit>(usualUnit)
  const [paper, setPaper] = useState<Paper>(() => pageSizeName(start.page) ?? 'custom')
  const [values, setValues] = useState<Record<Field, number>>(() => {
    const { width, height, margins } = start.page

    return { width, height, ...margins, header: margins.header ?? DEFAULT_HEADER_DISTANCE, footer: margins.footer ?? DEFAULT_HEADER_DISTANCE }
  })
  const [typed, setTyped] = useState<Partial<Record<Field, string>>>({})
  const [scope, setScope] = useState<'all' | 'section'>(start.count > 1 ? 'section' : 'all')
  const [failed, setFailed] = useState<string | null>(null)
  const body = useRef<HTMLFormElement>(null)
  const page: PageSettings = { width: values.width, height: values.height, margins: marginsOf(values, start.page) }
  const problem = pageProblem(page)
  const shown = useRef(start.page)
  const landscape = values.width > values.height

  if (!problem) {
    shown.current = page
  }

  // The window's shortcuts wait while the dialog is open; Escape still closes it.
  useEffect(() => {
    const element = body.current
    const onKey = (event: KeyboardEvent) => event.stopPropagation()
    element?.addEventListener('keydown', onKey)

    return () => element?.removeEventListener('keydown', onKey)
  }, [])

  const type = (field: Field, text: string) => {
    setTyped({ ...typed, [field]: text })
    setValues({ ...values, [field]: pointsIn(text, unit) })
    setFailed(null)

    if (field === 'width' || field === 'height') {
      setPaper('custom')
    }
  }

  const settle = (field: Field) => {
    if (Number.isFinite(values[field])) {
      const { [field]: _done, ...rest } = typed
      setTyped(rest)
    }
  }

  const pick = (next: Paper) => {
    setPaper(next)
    setFailed(null)

    if (next !== 'custom') {
      const size = PAGE_SIZES[next]
      const { width: _width, height: _height, ...rest } = typed
      setTyped(rest)
      setValues({ ...values, width: landscape ? size.height : size.width, height: landscape ? size.width : size.height })
    }
  }

  const orient = (wide: boolean) => {
    if (wide !== landscape && Number.isFinite(values.width) && Number.isFinite(values.height)) {
      setValues({ ...values, width: values.height, height: values.width })
      setTyped({ ...typed, width: typed.height, height: typed.width })
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()

    if (problem) {
      return
    }

    const change: PageChange = { size: { width: page.width, height: page.height }, margins: page.margins }

    try {
      applyLive(editor.view, scope === 'section' ? setSectionPage(start.index, change) : setPage(change, 'all'))
      onClose()
    } catch (error) {
      setFailed(messageOf(error))
    }
  }

  const input = (field: Field, label: string) => {
    const bad = !Number.isFinite(values[field])

    return (
      <label key={field} className="flex min-w-0 flex-col gap-1 text-[11.5px] text-fg-3">
        {label}
        <span className="relative flex items-center">
          <input
            inputMode="decimal"
            value={typed[field] ?? inUnit(values[field], unit)}
            aria-invalid={bad}
            onChange={(event) => type(field, event.target.value)}
            onBlur={() => settle(field)}
            onFocus={(event) => event.target.select()}
            className={cn('glass-input h-7 w-full min-w-0 rounded-md pr-7 pl-2 text-[12.5px] text-fg tabular-nums outline-none', bad && 'ring-1 ring-danger/70')}
          />
          <span className="pointer-events-none absolute right-2 text-[11px] text-fg-3">{unit}</span>
        </span>
      </label>
    )
  }

  return (
    <Modal title="Page setup" onClose={onClose}>
      <form ref={body} onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
              Paper size
              <select autoFocus value={paper} onChange={(event) => pick(event.target.value as Paper)} style={{ colorScheme: 'dark' }} className="glass-input h-7 w-full rounded-md px-1.5 text-[12.5px] text-fg outline-none">
                {PAPERS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {input('width', 'Width')}
              {input('height', 'Height')}
            </div>
            <Choice label="Orientation" value={landscape ? 'landscape' : 'portrait'} onChange={(id) => orient(id === 'landscape')} options={[{ id: 'portrait', label: 'Portrait', icon: <IconRectangleVertical size={14} /> }, { id: 'landscape', label: 'Landscape', icon: <IconRectangle size={14} /> }]} />
          </div>
          <PagePreview page={shown.current} />
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-[12px] font-medium text-fg-2">Margins</legend>
          <div className="grid grid-cols-4 gap-2">{MARGINS.map((entry) => input(entry.id, entry.label))}</div>
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-[12px] font-medium text-fg-2">From the edge</legend>
          <div className="grid grid-cols-4 gap-2">
            {input('header', 'Header')}
            {input('footer', 'Footer')}
          </div>
        </fieldset>
        <div className="flex items-end gap-3">
          <Choice
            label="Units"
            value={unit}
            onChange={(id) => {
              setUnit(id as Unit)
              setTyped({})
            }}
            options={[
              { id: 'cm', label: 'Centimetres' },
              { id: 'in', label: 'Inches' }
            ]}
          />
          {start.count > 1 && (
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11.5px] text-fg-3">
              Apply to
              <select value={scope} onChange={(event) => setScope(event.target.value as 'all' | 'section')} style={{ colorScheme: 'dark' }} className="glass-input h-7 w-full rounded-md px-1.5 text-[12.5px] text-fg outline-none">
                <option value="section">
                  This section ({start.index + 1} of {start.count})
                </option>
                <option value="all">Whole document</option>
              </select>
            </label>
          )}
        </div>
        <p role="status" className={cn('min-h-4 text-[11.5px]', problem || failed ? 'text-danger' : 'text-fg-3')}>
          {problem ?? failed ?? (scope === 'section' ? 'Only this section’s pages change.' : start.count > 1 ? 'Every section gets this page.' : '')}
        </p>
        <div className="flex justify-end gap-2">
          <GlassButton variant="ghost" onClick={onClose}>
            Cancel
          </GlassButton>
          <GlassButton variant="primary" type="submit" disabled={Boolean(problem)}>
            OK
          </GlassButton>
        </div>
      </form>
    </Modal>
  )
}

/** A row of buttons of which one is chosen. */
function Choice({ label, value, options, onChange }: { label: string; value: string; options: readonly { id: string; label: string; icon?: ReactNode }[]; onChange: (id: string) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-[11.5px] text-fg-3">
      {label}
      <div role="radiogroup" aria-label={label} className="flex gap-1">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={option.id === value}
            onClick={() => onChange(option.id)}
            className={cn('flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md border border-line px-2 text-[12px] whitespace-nowrap text-fg-2 hover:bg-white/8 hover:text-fg', option.id === value && 'border-accent/60 bg-white/10 text-fg')}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The page's proportions, its text area inside the margins, and where its header and footer sit. */
function PagePreview({ page }: { page: PageSettings }) {
  const { width, height, margins } = page
  const scale = Math.min(112 / width, 132 / height)
  const header = margins.header ?? DEFAULT_HEADER_DISTANCE
  const footer = margins.footer ?? DEFAULT_HEADER_DISTANCE
  const textWidth = width - margins.left - margins.right
  const lines = Math.max(0, Math.min(14, Math.floor((height - margins.top - margins.bottom) / 40)))

  return (
    <div className="grid h-[140px] w-[120px] shrink-0 place-items-center" aria-hidden="true">
      <svg width={round(width * scale)} height={round(height * scale)} viewBox={`0 0 ${width} ${height}`} className="drop-shadow-md">
        <rect width={width} height={height} style={{ fill: 'var(--color-paper)' }} />
        {Array.from({ length: lines }, (_, index) => (
          <rect key={index} x={margins.left} y={margins.top + 12 + index * 40} width={index % 4 === 3 ? textWidth * 0.6 : textWidth} height={14} fill="#d7dbe2" />
        ))}
        <rect x={margins.left} y={margins.top} width={textWidth} height={height - margins.top - margins.bottom} fill="none" stroke="rgb(47 125 255 / 0.8)" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        <line x1={margins.left} x2={width - margins.right} y1={header} y2={header} stroke="#9aa1ad" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
        <line x1={margins.left} x2={width - margins.right} y1={height - footer} y2={height - footer} stroke="#9aa1ad" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}
