import { IconChartLine, IconInfoCircle } from '@tabler/icons-react'
import { memo, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../../lib/cn.ts'
import type { TokenType } from '../engine/types.ts'
import { type LineView, plainKind, type ResultCell, resultCell, type RowBox, rowBoxes, segments } from './layout.ts'
import { ResultPopover } from './ResultPopover.tsx'

/** One row of the editor, in px; the type below sets the same line height. */
export const ROW_PX = 26
const PAD_TOP = 16
/**
 * The type both layers share. Any difference in font, size, spacing, wrapping or padding moves the
 * caret off the letters under it, and kerning or ligatures could differ between the textarea's one
 * run of text and the mirror's coloured spans, so they are off in both.
 */
const TYPE = 'm-0 border-0 px-5 pt-4 font-sans text-[15px] leading-[26px] font-normal tracking-normal tabular-nums whitespace-pre-wrap break-words [font-kerning:none] [font-variant-ligatures:none] [tab-size:4]'
/**
 * styles.css gives every textarea `font: inherit; color: inherit` and every focused control an
 * outline, outside Tailwind's layers, which beats the classes above.
 */
const TEXTAREA_STYLE = { fontSize: 15, lineHeight: `${ROW_PX}px`, fontWeight: 400, fontKerning: 'none', fontVariantLigatures: 'none', fontVariantNumeric: 'tabular-nums', letterSpacing: 'normal', color: 'transparent', outline: 'none' } as const
/** Headings are drawn heavier with a stroke, which leaves each letter's width as it is, unlike a bolder weight. */
const HEADING_STROKE = { WebkitTextStroke: '0.45px currentColor' } as const
const HOVER_OPEN_MS = 260
const HOVER_CLOSE_MS = 180
/** Room a popover needs under its row before it opens above instead. */
const POPOVER_ROOM = 190
/** An error this short is written beside its icon; a longer one waits in the popover, so it never widens the results. */
const SHORT_ERROR_CHARS = 18

const TOKEN: Record<TokenType, string> = {
  number: 'text-fg',
  unit: 'text-info',
  currency: 'text-ok',
  operator: 'text-fg-3',
  keyword: 'text-accent-strong',
  variable: 'text-progress',
  function: 'text-warn',
  comment: 'text-fg-4',
  heading: 'text-fg',
  label: 'text-fg-3',
  date: 'text-info'
}

interface Measure {
  tops: number[]
  end: number
}

interface Popover {
  index: number
  /** Opened by a click: stays until dismissed. Opened by hovering: goes when the pointer does. */
  pinned: boolean
  above: boolean
}

export interface EditorProps {
  text: string
  lines: readonly string[]
  views: readonly LineView[]
  /** The line being typed on: its error waits. */
  typingLine: number | null
  inputRef: RefObject<HTMLTextAreaElement | null>
  reduced: boolean
  placeholder: string
  onText: (text: string, caret: number) => void
  onCaret: (caret: number) => void
  onBlur: () => void
  onInsertBelow: (index: number, value: string) => void
  onShowGraph: () => void
}

/**
 * The sentence notepad's editor: a textarea with transparent text and a visible caret over a
 * mirror that draws the same text in colour, with each line's result beside it. The mirror's lines
 * are measured, so a result sits on the first row of its line through wrapping and resizing.
 */
export function Editor({ text, lines, views, typingLine, inputRef, reduced, placeholder, onText, onCaret, onBlur, onInsertBelow, onShowGraph }: EditorProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [measure, setMeasure] = useState<Measure | null>(null)
  const [popover, setPopover] = useState<Popover | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const focusInside = useRef(false)
  const boxes = useMemo(() => rowBoxes(lines.length, measure, ROW_PX, PAD_TOP), [lines.length, measure])
  const boxesRef = useRef<RowBox[]>(boxes)
  boxesRef.current = boxes
  const cells = useMemo(() => views.map((view, index) => resultCell(view, index === typingLine)), [views, typingLine])

  // Layout offsets, not client rects: a window opening scales its content, and its lines with it.
  const remeasure = useCallback(() => {
    const element = mirror.current

    if (!element) {
      return
    }

    const rows = [...element.children] as HTMLElement[]
    const tops = rows.map(row => row.offsetTop)
    const last = rows.at(-1)
    const end = last ? last.offsetTop + last.offsetHeight : 0
    setMeasure(current => (current && current.end === end && current.tops.length === tops.length && current.tops.every((top, index) => top === tops[index]) ? current : { tops, end }))
  }, [])

  useLayoutEffect(remeasure, [lines, remeasure])

  useEffect(() => {
    const element = mirror.current

    if (!element) {
      return
    }

    const observer = new ResizeObserver(() => remeasure())
    observer.observe(element)

    return () => observer.disconnect()
  }, [remeasure])

  const place = useCallback((index: number, pinned: boolean): Popover => {
    const view = scroller.current
    const box = boxesRef.current[index]
    const above = Boolean(view && box && box.top + ROW_PX + POPOVER_ROOM > view.scrollTop + view.clientHeight && box.top - POPOVER_ROOM > view.scrollTop)

    return { index, pinned, above }
  }, [])

  const hover = useCallback(
    (index: number) => {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = setTimeout(() => setPopover(current => (current?.pinned ? current : place(index, false))), HOVER_OPEN_MS)
    },
    [place]
  )

  const unhover = useCallback(() => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setPopover(current => (current?.pinned ? current : null)), HOVER_CLOSE_MS)
  }, [])

  const keep = useCallback(() => clearTimeout(hoverTimer.current), [])

  const toggle = useCallback(
    (index: number, keyboard: boolean) => {
      clearTimeout(hoverTimer.current)
      focusInside.current = keyboard
      setPopover(current => (current?.index === index && current.pinned ? null : place(index, true)))
    },
    [place]
  )

  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  // Opened from the keyboard, the popover takes it, so its actions come next rather than after every result.
  useEffect(() => {
    if (popover?.pinned && focusInside.current) {
      focusInside.current = false
      popoverRef.current?.querySelector('button')?.focus()
    }
  }, [popover])

  // Typing moves lines about, so a popover goes with any edit.
  useEffect(() => {
    setPopover(null)
  }, [text])

  useEffect(() => {
    if (!popover) {
      return
    }

    const onPointer = (event: PointerEvent) => {
      const target = event.target

      if (target instanceof Node && popoverRef.current?.contains(target)) {
        return
      }

      if (target instanceof Element && target.closest('[data-calc-result]')) {
        return
      }

      setPopover(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setPopover(null)
        inputRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)

    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [popover, inputRef])

  const shownCell = popover ? cells[popover.index] : null
  const shownResult = popover ? views[popover.index]?.result : null
  const shown = popover && shownCell && shownCell.kind !== 'graph' && shownResult ? popover : null
  const shownBox = shown ? boxes[shown.index] : null

  return (
    <div ref={scroller} className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div className="relative flex min-h-full">
        {shownBox && <div aria-hidden="true" className="pointer-events-none absolute inset-x-1.5 rounded-lg bg-white/5" style={{ top: shownBox.top - 1, height: shownBox.height + 2 }} />}
        <div className="relative min-w-0 flex-1">
          <div ref={mirror} aria-hidden="true" className={cn(TYPE, 'pointer-events-none relative pb-10 text-fg-2')}>
            {lines.map((line, index) => (
              <MirrorLine key={index} line={line} view={views[index]} />
            ))}
          </div>
          <textarea
            ref={inputRef}
            value={text}
            aria-label="Note"
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            onChange={event => onText(event.target.value, event.target.selectionStart)}
            onSelect={event => onCaret(event.currentTarget.selectionStart)}
            onBlur={onBlur}
            // It grows with the mirror and never scrolls itself; the column around both does.
            onScroll={event => {
              event.currentTarget.scrollTop = 0
            }}
            className={cn(TYPE, 'selectable absolute inset-0 size-full resize-none overflow-hidden bg-transparent pb-4 text-transparent caret-fg outline-none placeholder:text-fg-4')}
            style={TEXTAREA_STYLE}
          />
        </div>
        <div role="group" aria-label="Results" className="relative max-w-[45%] shrink-0 pr-3 pl-2" style={{ paddingTop: boxes[0]?.top ?? PAD_TOP }}>
          {cells.map((cell, index) => (
            <ResultRow key={index} index={index} height={boxes[index]?.height ?? ROW_PX} cell={cell} open={shown?.index === index} onHover={hover} onLeave={unhover} onToggle={toggle} onGraph={onShowGraph} />
          ))}
        </div>
        {shown && shownBox && shownCell && shownResult && (
          <ResultPopover
            ref={popoverRef}
            result={shownResult}
            cell={shownCell}
            reduced={reduced}
            className={cn('right-3', shown.above && '-translate-y-full')}
            style={{ top: shown.above ? shownBox.top - 4 : shownBox.top + ROW_PX + 4 }}
            onPointerEnter={keep}
            onPointerLeave={unhover}
            onInsertBelow={() => {
              setPopover(null)

              if (shownCell.kind === 'value') {
                onInsertBelow(shown.index, shownCell.display)
              }
            }}
          />
        )}
      </div>
    </div>
  )
}

const MirrorLine = memo(
  function MirrorLine({ line, view }: { line: string; view: LineView }) {
    if (!line) {
      return <div>{'\u200b'}</div>
    }

    const engineKind = view.fresh ? view.result?.kind : undefined
    const kind = engineKind === 'heading' || engineKind === 'comment' ? engineKind : engineKind ? null : plainKind(line)

    if (kind === 'heading') {
      const mark = /^\s*#+\s*/.exec(line)?.[0] ?? ''

      return (
        <div className="text-fg" style={HEADING_STROKE}>
          {mark && <span className="text-fg-4">{mark}</span>}
          {line.slice(mark.length)}
        </div>
      )
    }

    if (kind === 'comment') {
      return <div className="text-fg-4">{line}</div>
    }

    return (
      <div>
        {segments(line, view.tokens).map((run, index) =>
          run.type ? (
            <span key={index} className={TOKEN[run.type]}>
              {run.text}
            </span>
          ) : (
            run.text
          )
        )}
      </div>
    )
  },
  (before, after) => before.line === after.line && before.view.result === after.view.result && before.view.tokens === after.view.tokens && before.view.fresh === after.view.fresh
)

interface ResultRowProps {
  index: number
  height: number
  cell: ResultCell | null
  open: boolean
  onHover: (index: number) => void
  onLeave: () => void
  /** `keyboard`: pressed with Enter or Space, which give a click no pointer detail. */
  onToggle: (index: number, keyboard: boolean) => void
  onGraph: () => void
}

function sameCell(a: ResultCell | null, b: ResultCell | null): boolean {
  if (!a || !b) {
    return a === b
  }

  if (a.kind === 'value' && b.kind === 'value') {
    return a.display === b.display && a.value === b.value && a.unit === b.unit
  }

  if (a.kind === 'error' && b.kind === 'error') {
    return a.message === b.message
  }

  return a.kind === b.kind
}

const ResultRow = memo(
  function ResultRow({ index, height, cell, open, onHover, onLeave, onToggle, onGraph }: ResultRowProps) {
    return (
      <div className="flex justify-end" style={{ height }}>
        {cell && (
          <div className="flex h-[26px] max-w-full items-center">
            {cell.kind === 'value' && (
              <button
                type="button"
                data-calc-result=""
                aria-label={`${cell.display}: show the working`}
                aria-expanded={open}
                onClick={event => onToggle(index, event.detail === 0)}
                onPointerEnter={() => onHover(index)}
                onPointerLeave={onLeave}
                className={cn('max-w-full truncate rounded-md px-1.5 text-right text-[15px] font-medium text-fg tabular-nums transition-colors duration-150 hover:bg-white/8', open && 'bg-white/8')}
              >
                {cell.value}
                {cell.unit && <span className="font-normal text-fg-3">{cell.unit}</span>}
              </button>
            )}
            {cell.kind === 'error' && (
              <button
                type="button"
                data-calc-result=""
                aria-label={cell.message}
                aria-expanded={open}
                onClick={event => onToggle(index, event.detail === 0)}
                onPointerEnter={() => onHover(index)}
                onPointerLeave={onLeave}
                className={cn('flex h-6 max-w-full items-center gap-1 rounded-md px-1 text-fg-4 transition-colors duration-150 hover:bg-white/8 hover:text-fg-3', open && 'bg-white/8 text-fg-3')}
              >
                {cell.message.length <= SHORT_ERROR_CHARS && <span className="truncate text-[12.5px]">{cell.message}</span>}
                <IconInfoCircle size={15} stroke={1.75} className="shrink-0" />
              </button>
            )}
            {cell.kind === 'graph' && (
              <button type="button" aria-label="Show the graph" title="Show the graph" onClick={onGraph} className="flex size-6 items-center justify-center rounded-md text-fg-4 transition-colors duration-150 hover:bg-white/8 hover:text-fg-2">
                <IconChartLine size={15} stroke={1.75} />
              </button>
            )}
          </div>
        )}
      </div>
    )
  },
  (before, after) => before.index === after.index && before.height === after.height && before.open === after.open && sameCell(before.cell, after.cell) && before.onHover === after.onHover && before.onLeave === after.onLeave && before.onToggle === after.onToggle && before.onGraph === after.onGraph
)
