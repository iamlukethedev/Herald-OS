import { useStore } from '@nanostores/react'
import { IconCheck, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { cn } from '../../../../lib/cn.ts'
import { messageOf } from '../../../canvas/errors.ts'
import { type PlaceholderRole, type Slide, type SlideSize, SLOTS, type Theme } from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { shapeElement } from '../elements.ts'
import { newSlide, placeholderFor } from '../layouts.ts'
import { $customThemes, deleteCustomTheme } from '../theme-store.ts'
import { THEMES } from '../themes.ts'
import { SlideView } from '../view/SlideView.tsx'
import * as commands from './commands.ts'
import { applyThemeTo, openThemeEditor, readCustomThemes, themeInUse, type ThemeScope } from './master-commands.ts'
import { useDeck } from './Stage.tsx'

/*
 * The themes to pick from, each drawn as a sample slide: the deck's own when it came with the file,
 * Herald's, then the custom ones (which can be edited and deleted). A theme goes on every slide or
 * on the picked ones; New Theme… starts the theme editor from the theme in use.
 */

/** A sample slide's placeholder of `role` saying `lines`, a paragraph each. */
function saying(slide: Slide, role: PlaceholderRole, lines: readonly string[]): Slide {
  const target = placeholderFor(slide, role)

  if (target?.kind !== 'text' && target?.kind !== 'shape') {
    return slide
  }

  const first = target.body.paragraphs[0]
  const filled = { ...target, body: { ...target.body, paragraphs: lines.map((text) => ({ ...first, runs: [{ text }] })) } }

  return { ...slide, elements: slide.elements.map((element) => (element === target ? filled : element)) }
}

/** A theme's sample title slide: a title in its heading font over its fonts' names, on its background. */
export function titleSample(theme: Theme, size: SlideSize, title = theme.name): Slide {
  const slide = saying(saying(newSlide('title', size), 'title', [title]), 'subtitle', [`${theme.fonts.heading} · ${theme.fonts.body}`])

  return { ...slide, background: theme.background ?? null }
}

/** A theme's sample content slide: a heading, a few points in its body font and its six accents. */
export function contentSample(theme: Theme, size: SlideSize): Slide {
  const slide = saying(saying(newSlide('title-content', size), 'title', ['Heading']), 'body', [`Body text in ${theme.fonts.body}`, 'A second point', 'And a third'])
  const side = size.height * 0.09
  const gap = side * 0.4
  const accents = SLOTS.slice(4).map((slot, index) => shapeElement('roundRect', { x: size.width - (6 - index) * (side + gap), y: size.height - side - gap * 2, width: side, height: side }, { name: `Accent ${index + 1}`, fill: { color: slot } }))

  return { ...slide, elements: [...slide.elements, ...accents], background: theme.background ?? null }
}

function ThemeCard({ theme, size, current, label, onPick, children }: { theme: Theme; size: SlideSize; current: boolean; label: string; onPick: (theme: Theme) => void; children?: ReactNode }) {
  const deck = useMemo(() => ({ size, theme }), [size, theme])
  const slide = useMemo(() => titleSample(theme, size), [theme, size])

  return (
    <div className="group relative">
      <button
        type="button"
        aria-pressed={current}
        onClick={() => onPick(theme)}
        className={cn('flex w-full flex-col gap-1 rounded-lg p-1.5 text-left text-[11.5px] text-fg-2 hover:bg-white/8 hover:text-fg', current && 'bg-white/10 text-fg')}
      >
        <span className={cn('relative overflow-hidden rounded-[3px]', current ? 'ring-2 ring-accent' : 'ring-1 ring-black/10')}>
          <SlideView deck={deck} slide={slide} scale={128 / size.width} mode="thumb" className="pointer-events-none" />
          {current && (
            <span className="absolute right-1 bottom-1 grid size-4 place-items-center rounded-full bg-accent text-accent-fg">
              <IconCheck size={11} />
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1">
          {SLOTS.slice(4).map((slot) => (
            <span key={slot} className="size-2.5 shrink-0 rounded-full" style={{ background: theme.colors[slot] }} />
          ))}
          <span className="ml-1 truncate">{label}</span>
        </span>
      </button>
      {children}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <div className="px-1.5 pt-1 text-[11px] font-medium tracking-wide text-fg-3 uppercase">{title}</div>
      <div className="grid grid-cols-3 gap-1">{children}</div>
    </>
  )
}

const CORNER_BUTTON = 'grid size-6 place-items-center rounded-md bg-black/60 text-white hover:bg-black/80'

export function ThemePanel({ doc, onDone }: { doc: SlidesDocument; onDone: () => void }) {
  useDeck(doc)
  const custom = useStore($customThemes)
  const [scope, setScope] = useState<ThemeScope>('all')
  const [doomed, setDoomed] = useState<Theme | null>(null)
  const master = doc.mode === 'master'
  const using: ThemeScope = master ? 'all' : scope
  const deck = doc.presentation
  const current = themeInUse(using, doc) ?? deck.theme
  const picked = doc.pickedSlides.length
  const known = (theme: Theme) => THEMES.some((entry) => entry.id === theme.id) || custom.some((entry) => entry.id === theme.id)
  const own = [deck.theme, current].filter((theme, index, all) => !known(theme) && all.findIndex((entry) => entry.id === theme.id) === index)
  const isCustom = custom.some((entry) => entry.id === current.id)

  useEffect(() => readCustomThemes(), [])

  const pick = (theme: Theme) => {
    applyThemeTo(theme, using, doc)
    onDone()
  }
  const edit = (theme: Theme, fresh: boolean) => {
    openThemeEditor({ theme, fresh, scope: using }, doc)
    onDone()
  }
  const card = (theme: Theme, label = theme.name, actions?: ReactNode) => (
    <ThemeCard key={theme.id} theme={theme} size={deck.size} current={theme.id === current.id} label={label} onPick={pick}>
      {actions}
    </ThemeCard>
  )

  return (
    <div className="flex w-[436px] flex-col gap-2 text-[12px] text-fg-2">
      <div className="flex items-center gap-2 px-1.5">
        <span className="text-fg-3">Apply to</span>
        <div className="flex rounded-md border border-line p-0.5">
          {(['all', 'selected'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={using === value}
              disabled={value === 'selected' && master}
              onClick={() => setScope(value)}
              className={cn('h-6 rounded px-2 text-fg-2 hover:text-fg disabled:opacity-40', using === value && 'bg-white/12 text-fg')}
            >
              {value === 'all' ? 'All slides' : picked > 1 ? `${picked} selected slides` : 'Selected slide'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex max-h-[392px] flex-col gap-1 overflow-y-auto">
        {own.length > 0 && <Section title="In this deck">{own.map((theme) => card(theme, theme.id === 'imported' ? `${theme.name} (from the file)` : theme.name))}</Section>}
        <Section title="Built-in">{THEMES.map((theme) => card(theme))}</Section>
        {custom.length > 0 && (
          <Section title="Custom">
            {custom.map((theme) =>
              card(
                theme,
                theme.name,
                <div className="absolute top-2.5 right-2.5 flex gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                  <button type="button" aria-label={`Edit the ${theme.name} theme`} title="Edit Theme…" onClick={() => edit(theme, false)} className={CORNER_BUTTON}>
                    <IconPencil size={13} />
                  </button>
                  <button type="button" aria-label={`Delete the ${theme.name} theme`} title="Delete" onClick={() => setDoomed(theme)} className={cn(CORNER_BUTTON, 'hover:bg-danger')}>
                    <IconTrash size={13} />
                  </button>
                </div>
              )
            )}
          </Section>
        )}
      </div>
      {doomed ? (
        <div className="flex items-center gap-2 border-t border-line px-1.5 pt-2">
          <span className="min-w-0 flex-1">Delete the “{doomed.name}” theme? Decks that use it keep its colours.</span>
          <button type="button" onClick={() => setDoomed(null)} className="h-7 rounded-md px-2 hover:bg-white/8 hover:text-fg">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setDoomed(null)
              deleteCustomTheme(doomed.id).catch((error: unknown) => commands.notify(`Herald Slides could not delete the theme: ${messageOf(error)}`))
            }}
            className="h-7 rounded-md bg-danger/15 px-2 text-danger hover:bg-danger/25"
          >
            Delete
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1 border-t border-line pt-2">
          <button type="button" onClick={() => edit(current, true)} className="flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-white/8 hover:text-fg">
            <IconPlus size={14} /> New Theme…
          </button>
          {isCustom && (
            <button type="button" onClick={() => edit(current, false)} className="flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-white/8 hover:text-fg">
              <IconPencil size={14} /> Edit Theme…
            </button>
          )}
        </div>
      )}
    </div>
  )
}
