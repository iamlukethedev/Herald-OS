import { IconArrowRight, IconCheck, IconCircleDot } from '@tabler/icons-react'
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../../../lib/cn.ts'
import type { Color, Deck, Fill, FontRef, LayoutId, Slide, Theme } from '../deck.ts'
import { LAYOUTS, SLOTS } from '../deck.ts'
import { gradientFill } from '../elements.ts'
import { LAYOUT_NAMES, newSlide, placeholderFor } from '../layouts.ts'
import { COMMON_FONTS, fontStack, isSlot, normalHex, resolveColor, SLOT_NAMES, THEMES } from '../themes.ts'
import { gradientCss } from '../view/paint.tsx'
import { SlideView } from '../view/SlideView.tsx'

/*
 * The formatting bar's pop-up choosers: colours (the theme's slots first, so a colour follows the
 * theme), fills (a colour or a gradient between two), fonts (the theme's, then the computer's),
 * sizes, a table's rows and columns, layouts and themes, each drawn as it will look. They are
 * marked like the bar, so picking from them keeps the text being typed into.
 */

/**
 * A pop-up under its button; closes on Escape and on a press outside both. It is drawn over the
 * window, since the bar scrolls sideways and so would clip anything hanging below it.
 */
export function Popover({ open, onClose, anchor, children, className, align = 'left' }: { open: boolean; onClose: () => void; anchor: React.RefObject<HTMLElement | null>; children: ReactNode; className?: string; align?: 'left' | 'right' }) {
  const panel = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const onDown = (event: PointerEvent) => {
      const target = event.target as Node

      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) {
        onClose()
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)

    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, anchor])

  useLayoutEffect(() => {
    if (!open) {
      return
    }

    const place = () => {
      const box = anchor.current?.getBoundingClientRect()
      const self = panel.current

      if (!box || !self) {
        return
      }

      const left = align === 'right' ? box.right - self.offsetWidth : box.left
      setAt({ left: Math.max(8, Math.min(left, window.innerWidth - self.offsetWidth - 8)), top: Math.max(8, Math.min(box.bottom + 4, window.innerHeight - self.offsetHeight - 8)) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)

    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, align])

  if (!open) {
    return null
  }

  return createPortal(
    <div ref={panel} role="dialog" data-slides-keep-editing="" className={cn('float menu-surface fixed z-50 rounded-xl p-2 animate-pop', className)} style={at ?? { left: 0, top: 0, visibility: 'hidden' }} onMouseDown={(event) => event.preventDefault()}>
      {children}
    </div>,
    document.body
  )
}

/** A bar button that opens a pop-up. */
export function PopoverButton({ label, children, panel, className, active, disabled, align, panelClassName }: { label: string; children: ReactNode; panel: (close: () => void) => ReactNode; className?: string; active?: boolean; disabled?: boolean; align?: 'left' | 'right'; panelClassName?: string }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const close = () => setOpen(false)

  return (
    <div className="relative">
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
        className={cn('flex h-7 items-center gap-1 rounded-md px-1.5 text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-40 [&_svg]:size-4', (open || active) && 'bg-white/12 text-fg', className)}
      >
        {children}
      </button>
      <Popover open={open} onClose={close} anchor={anchor} align={align} className={panelClassName}>
        {panel(close)}
      </Popover>
    </div>
  )
}

const STANDARD = ['#000000', '#404040', '#7f7f7f', '#bfbfbf', '#ffffff', '#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0']

export function ColorGrid({ theme, value, onPick, none, noneLabel = 'None' }: { theme: Theme; value: Color | null; onPick: (color: Color | null) => void; none?: boolean; noneLabel?: string }) {
  const custom = useRef<HTMLInputElement>(null)
  const swatch = (color: Color, title: string) => (
    <button
      key={color}
      type="button"
      title={title}
      aria-label={title}
      onClick={() => onPick(color)}
      className={cn('grid size-6 place-items-center rounded-md border border-black/10', value === color && 'ring-2 ring-accent ring-offset-1 ring-offset-transparent')}
      style={{ background: resolveColor(color, theme) }}
    />
  )

  return (
    <div className="flex w-[232px] flex-col gap-2">
      <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">Theme</div>
      <div className="grid grid-cols-8 gap-1.5">{SLOTS.map((slot) => swatch(slot, `${SLOT_NAMES[slot]} (${theme.name})`))}</div>
      <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">Standard</div>
      <div className="grid grid-cols-8 gap-1.5">{STANDARD.map((hex) => swatch(hex as Color, hex))}</div>
      <div className="flex items-center gap-2 pt-1">
        {none && (
          <button type="button" onClick={() => onPick(null)} className={cn('h-7 flex-1 rounded-md border border-line text-[12px] text-fg-2 hover:bg-white/8', value === null && 'border-accent text-fg')}>
            {noneLabel}
          </button>
        )}
        <button type="button" onClick={() => custom.current?.click()} className="h-7 flex-1 rounded-md border border-line text-[12px] text-fg-2 hover:bg-white/8">
          Custom…
        </button>
        <input
          ref={custom}
          type="color"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          defaultValue={value && !isSlot(value) ? value : '#2f7dff'}
          onChange={(event) => {
            const hex = normalHex(event.target.value)

            if (hex) {
              onPick(hex)
            }
          }}
        />
      </div>
    </div>
  )
}

/** A fill's look for a swatch: its gradient, or its colour (nothing for no fill). */
export const fillCss = (fill: Fill | null, theme: Theme): string => (fill?.gradient ? gradientCss(fill.gradient, theme) : fill ? resolveColor(fill.color, theme) : 'transparent')

const ANGLES = [0, 45, 90, 135, 180, 225, 270, 315]

interface GradientSettings {
  from: Color
  to: Color
  angle: number
  radial: boolean
}

function gradientOf(settings: GradientSettings): Fill {
  const fill = gradientFill(settings.from, settings.to, settings.angle)

  return settings.radial && fill.gradient ? { ...fill, gradient: { ...fill.gradient, radial: true } } : fill
}

/** Where a gradient panel starts: the fill's own gradient, else from its colour to the background (or the first accent). */
function startingGradient(value: Fill | null): GradientSettings {
  const stops = [...(value?.gradient?.stops ?? [])].sort((a, b) => a.at - b.at)
  const from = stops[0]?.color ?? value?.color ?? 'accent1'

  return { from, to: stops[stops.length - 1]?.color ?? (from === 'bg1' ? 'accent1' : 'bg1'), angle: value?.gradient?.angle ?? 90, radial: Boolean(value?.gradient?.radial) }
}

/**
 * A fill: a colour, or a gradient between two colours of the palette along an angle or out from
 * the middle. A colour is picked once; a gradient changes as it is tuned, from the moment Gradient
 * is chosen.
 */
export function FillPanel({ theme, value, onColor, onGradient, noneLabel }: { theme: Theme; value: Fill | null; onColor: (color: Color | null) => void; onGradient: (fill: Fill) => void; noneLabel: string }) {
  const [mode, setMode] = useState<'solid' | 'gradient'>(value?.gradient ? 'gradient' : 'solid')
  const [settings, setSettings] = useState(() => startingGradient(value))
  const [stop, setStop] = useState<'from' | 'to'>('from')
  const tune = (patch: Partial<GradientSettings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    onGradient(gradientOf(next))
  }
  const tab = (which: 'solid' | 'gradient', label: string) => (
    <button
      type="button"
      aria-pressed={mode === which}
      onClick={() => {
        setMode(which)

        if (which === 'gradient' && !value?.gradient) {
          onGradient(gradientOf(settings))
        }
      }}
      className={cn('h-6 flex-1 rounded-md text-[12px] text-fg-2 hover:text-fg', mode === which && 'bg-white/12 text-fg')}
    >
      {label}
    </button>
  )

  return (
    <div className="flex w-[232px] flex-col gap-2">
      <div className="flex gap-1 rounded-lg bg-white/5 p-0.5">
        {tab('solid', 'Solid')}
        {tab('gradient', 'Gradient')}
      </div>
      {mode === 'solid' ? (
        <ColorGrid theme={theme} value={value && !value.gradient ? value.color : null} none noneLabel={noneLabel} onPick={onColor} />
      ) : (
        <>
          <div className="h-6 rounded-md border border-black/10" style={{ background: fillCss(gradientOf(settings), theme) }} />
          <div className="flex gap-1.5 text-[12px] text-fg-2">
            {(['from', 'to'] as const).map((which) => (
              <button key={which} type="button" aria-pressed={stop === which} onClick={() => setStop(which)} className={cn('flex h-7 flex-1 items-center gap-2 rounded-md border border-line px-2 hover:bg-white/8', stop === which && 'border-accent text-fg')}>
                <span className="size-3.5 rounded-sm border border-black/10" style={{ background: resolveColor(settings[which], theme) }} />
                {which === 'from' ? 'From' : 'To'}
              </button>
            ))}
          </div>
          <ColorGrid theme={theme} value={settings[stop]} onPick={(color) => color && tune({ [stop]: color })} />
          <div className="flex items-center justify-between">
            {ANGLES.map((angle) => (
              <button
                key={angle}
                type="button"
                title={`${angle}°`}
                aria-label={`Along ${angle}°`}
                aria-pressed={!settings.radial && settings.angle === angle}
                disabled={settings.radial}
                onClick={() => tune({ angle })}
                className={cn('grid size-6 place-items-center rounded-md text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-40', !settings.radial && settings.angle === angle && 'bg-white/12 text-fg')}
              >
                <IconArrowRight size={14} style={{ transform: `rotate(${angle}deg)` }} />
              </button>
            ))}
            <button type="button" title="Radial" aria-label="Radial" aria-pressed={settings.radial} onClick={() => tune({ radial: !settings.radial })} className={cn('grid size-6 place-items-center rounded-md text-fg-2 hover:bg-white/8 hover:text-fg', settings.radial && 'bg-white/12 text-fg')}>
              <IconCircleDot size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}

let systemFonts: Promise<string[]> | null = null

const loadSystemFonts = (): Promise<string[]> => {
  systemFonts ??= window.heraldOS.fonts
    .list()
    .then((fonts) => [...new Set(fonts)].sort((a, b) => a.localeCompare(b)))
    .catch(() => [])

  return systemFonts
}

export function FontList({ theme, value, onPick }: { theme: Theme; value: FontRef; onPick: (font: FontRef) => void }) {
  const [fonts, setFonts] = useState<string[]>([])
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void loadSystemFonts().then(setFonts)
  }, [])

  const families = useMemo(() => {
    const all = [...new Set([...COMMON_FONTS, ...fonts])]
    const wanted = filter.trim().toLowerCase()

    return wanted ? all.filter((family) => family.toLowerCase().includes(wanted)) : all
  }, [fonts, filter])

  const row = (font: FontRef, label: string, family: string, hint?: string) => (
    <button key={font} type="button" onClick={() => onPick(font)} className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-fg-2 hover:bg-white/8 hover:text-fg">
      <span className="min-w-0 flex-1 truncate" style={{ fontFamily: fontStack(family) }}>
        {label}
      </span>
      {hint && <span className="text-[11px] text-fg-3">{hint}</span>}
      {value === font && <IconCheck size={14} className="text-accent-strong" />}
    </button>
  )

  return (
    <div className="flex w-64 flex-col gap-1">
      <input autoFocus value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Find a font" aria-label="Find a font" className="glass-input mb-1 h-7 rounded-md px-2 text-[12px] text-fg outline-none placeholder:text-fg-4" />
      {!filter && (
        <>
          {row('+heading', theme.fonts.heading, theme.fonts.heading, 'Headings')}
          {row('+body', theme.fonts.body, theme.fonts.body, 'Body')}
          <div className="my-1 h-px bg-line" />
        </>
      )}
      <div className="max-h-72 overflow-y-auto">{families.map((family) => row(family, family, family))}</div>
    </div>
  )
}

export const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72, 88, 96, 120]

export function SizeList({ value, onPick }: { value: number; onPick: (size: number) => void }) {
  return (
    <div className="grid w-44 grid-cols-4 gap-1">
      {SIZES.map((size) => (
        <button key={size} type="button" onClick={() => onPick(size)} className={cn('h-7 rounded-md text-[12px] tabular-nums text-fg-2 hover:bg-white/8 hover:text-fg', Math.abs(size - value) < 0.01 && 'bg-white/12 text-fg')}>
          {size}
        </button>
      ))}
    </div>
  )
}

const GRID_ROWS = 8
const GRID_COLUMNS = 10

/** Rows and columns for a new table, picked on a grid from its top left as in PowerPoint. */
export function TableGrid({ onPick }: { onPick: (rows: number, columns: number) => void }) {
  const [over, setOver] = useState({ rows: 0, columns: 0 })

  return (
    <div className="flex flex-col gap-2" onMouseLeave={() => setOver({ rows: 0, columns: 0 })}>
      <div className="grid grid-cols-10 gap-[3px]">
        {Array.from({ length: GRID_ROWS * GRID_COLUMNS }, (_, index) => {
          const rows = Math.floor(index / GRID_COLUMNS) + 1
          const columns = (index % GRID_COLUMNS) + 1
          const lit = rows <= over.rows && columns <= over.columns

          return (
            <button
              key={index}
              type="button"
              aria-label={`Table of ${rows} by ${columns}`}
              onMouseEnter={() => setOver({ rows, columns })}
              onFocus={() => setOver({ rows, columns })}
              onClick={() => onPick(rows, columns)}
              className={cn('size-4 rounded-[2px] border', lit ? 'border-accent bg-accent/30' : 'border-line bg-white/5')}
            />
          )
        })}
      </div>
      <span className="text-[11.5px] text-fg-3 tabular-nums">{over.rows ? `${over.rows} ${over.rows === 1 ? 'row' : 'rows'}, ${over.columns} ${over.columns === 1 ? 'column' : 'columns'}` : 'Rows and columns'}</span>
    </div>
  )
}

/** A slide's look in miniature, for choosers. */
function Miniature({ deck, slide, width }: { deck: Pick<Deck, 'size' | 'theme'>; slide: Slide; width: number }) {
  return <SlideView deck={deck} slide={slide} scale={width / deck.size.width} mode="edit" className="pointer-events-none rounded-[3px] ring-1 ring-black/10" />
}

export function LayoutGrid({ deck, onPick, current }: { deck: Pick<Deck, 'size' | 'theme'>; onPick: (layout: LayoutId) => void; current?: LayoutId }) {
  const slides = useMemo(() => LAYOUTS.map((layout) => newSlide(layout, deck.size)), [deck.size])

  return (
    <div className="grid w-[452px] grid-cols-4 gap-2">
      {LAYOUTS.map((layout, index) => (
        <button key={layout} type="button" onClick={() => onPick(layout)} className={cn('flex flex-col items-center gap-1 rounded-lg p-1.5 text-[11px] text-fg-2 hover:bg-white/8 hover:text-fg', current === layout && 'bg-white/10 text-fg')}>
          <Miniature deck={deck} slide={slides[index]} width={96} />
          <span className="w-24 truncate text-center">{LAYOUT_NAMES[layout]}</span>
        </button>
      ))}
    </div>
  )
}

/** A sample title slide in a theme: its name on its background, with its accents. */
function themeSample(theme: Theme, size: Deck['size']): Slide {
  const slide = newSlide('title', size)
  const title = placeholderFor(slide, 'title')
  const subtitle = placeholderFor(slide, 'subtitle')

  return {
    ...slide,
    elements: slide.elements.map((element) => {
      if ((element === title || element === subtitle) && (element.kind === 'text' || element.kind === 'shape')) {
        const text = element === title ? theme.name : `${theme.fonts.heading} · ${theme.fonts.body}`

        return { ...element, body: { ...element.body, paragraphs: [{ ...element.body.paragraphs[0], runs: [{ text }] }] } }
      }

      return element
    })
  }
}

export function ThemeGrid({ deck, onPick }: { deck: Pick<Deck, 'size' | 'theme'>; onPick: (theme: Theme) => void }) {
  const choices = useMemo(() => (THEMES.some((entry) => entry.id === deck.theme.id) ? THEMES : [deck.theme, ...THEMES]), [deck.theme])

  return (
    <div className="grid w-[436px] grid-cols-3 gap-2">
      {choices.map((theme) => (
        <button key={theme.id} type="button" onClick={() => onPick(theme)} className={cn('flex flex-col gap-1 rounded-lg p-1.5 text-left text-[11.5px] text-fg-2 hover:bg-white/8 hover:text-fg', deck.theme.id === theme.id && 'bg-white/10 text-fg')}>
          <Miniature deck={{ size: deck.size, theme }} slide={themeSample(theme, deck.size)} width={128} />
          <span className="flex items-center gap-1">
            {SLOTS.slice(4).map((slot) => (
              <span key={slot} className="size-2.5 rounded-full" style={{ background: theme.colors[slot] }} />
            ))}
            <span className="ml-1 truncate">{theme.id === 'imported' ? `${theme.name} (from the file)` : theme.name}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
