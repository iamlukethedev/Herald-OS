import { IconEyeOff, IconPlus, IconTransitionRight } from '@tabler/icons-react'
import { memo, useMemo, useRef, useState } from 'react'
import { cn } from '../../../../lib/cn.ts'
import { Menu } from '../../../files/Menu.tsx'
import type { Deck, Slide } from '../deck.ts'
import type { SlidesDocument, ViewOptions } from '../document.ts'
import { layoutOf, masterOf } from '../layouts.ts'
import { slideLayoutId } from '../masters.ts'
import { TRANSITION_NAMES } from '../transitions.ts'
import { SlideView } from '../view/SlideView.tsx'
import * as commands from './commands.ts'
import { backgroundGraphicsHidden, showMasterView, toggleBackgroundGraphics } from './master-commands.ts'
import { useDeck } from './Stage.tsx'

/*
 * The slides down the side, each drawn by the slide view at a small scale. A click brings a slide
 * to the front (with ⇧ or ⌘ it is picked as well); dragging picked slides moves them; hidden slides
 * are dimmed and slides with a transition of their own are marked. Picked slides are what
 * Duplicate, Delete and Hide work on. In the master view the list is the master, then its layouts
 * under it.
 */

const THUMB = 152

const LAYOUT_THUMB = 124

type ThumbDeck = Pick<Deck, 'size' | 'theme'> & Partial<Pick<Deck, 'master' | 'headerFooter'>>

const AS_IS: ViewOptions = {}

/** The master view's thumbnails show placeholders with their prompts, as the master and its layouts are made of them. */
const Thumbnail = memo(function Thumbnail({ deck, slide, index, width = THUMB, options = AS_IS, prompts = false }: { deck: ThumbDeck; slide: Slide; index?: number; width?: number; options?: ViewOptions; prompts?: boolean }) {
  return <SlideView deck={deck} slide={slide} scale={width / deck.size.width} mode={prompts ? 'edit' : 'thumb'} index={index} {...options} className="pointer-events-none" />
})

/** The master view's list: the master's own slide, then each layout under it with its name. */
function MasterSlides({ doc, view }: { doc: SlidesDocument; view: ThumbDeck }) {
  const deck = doc.deck
  const list = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const master = masterOf(doc.presentation)
  const [own, ...layouts] = deck.slides
  const front = doc.slide.id
  const layoutInMenu = slideLayoutId(front)

  const row = (slide: Slide) => {
    const layout = slideLayoutId(slide.id)
    const name = layout ? layoutOf(master, layout).name : 'Slide Master'

    return (
      <button
        key={slide.id}
        type="button"
        role="option"
        aria-selected={slide.id === front}
        aria-label={layout ? `${name} layout` : name}
        onClick={() => doc.goTo(slide.id)}
        onContextMenu={(event) => {
          event.preventDefault()
          doc.goTo(slide.id)
          const rect = list.current?.getBoundingClientRect()
          setMenu({ x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) + (list.current?.scrollTop ?? 0) })
        }}
        className="flex w-full flex-col items-start gap-1 text-left"
      >
        <span className={cn('overflow-hidden rounded-[3px] ring-2 ring-offset-0', slide.id === front ? 'ring-accent' : 'ring-transparent hover:ring-line-strong')}>
          <Thumbnail deck={view} slide={slide} width={layout ? LAYOUT_THUMB : THUMB} options={doc.viewOptions(slide)} prompts />
        </span>
        <span className={cn('max-w-full truncate text-[11px]', slide.id === front ? 'text-fg' : 'text-fg-3')}>{name}</span>
      </button>
    )
  }

  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Slide master and layouts"
      tabIndex={0}
      className="relative flex w-[196px] shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-line p-3 outline-none"
      onKeyDown={(event) => {
        const index = doc.index
        const last = deck.slides.length - 1
        const to = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? last : null

        if (to === null) {
          return
        }

        doc.goTo(deck.slides[Math.max(0, Math.min(last, to))].id)
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {own && row(own)}
      <div className="ml-1.5 flex flex-col gap-2.5 border-l border-line pl-3">{layouts.map(row)}</div>
      {menu && (
        <div className="absolute z-40" style={{ left: Math.min(menu.x, 60), top: menu.y }}>
          <Menu
            align="left"
            onClose={() => setMenu(null)}
            items={[
              ...(layoutInMenu ? [{ id: 'graphics', label: 'Hide Background Graphics', checked: backgroundGraphicsHidden(doc), onSelect: () => toggleBackgroundGraphics(doc) }] : []),
              { id: 'close', label: 'Close Master View', onSelect: () => showMasterView(false, doc), dividerBefore: Boolean(layoutInMenu) }
            ]}
          />
        </div>
      )}
    </div>
  )
}

export function Rail({ doc }: { doc: SlidesDocument }) {
  useDeck(doc)
  const deck = doc.deck
  const view = useMemo(() => ({ size: deck.size, theme: deck.theme, master: deck.master, headerFooter: deck.headerFooter }), [deck.size, deck.theme, deck.master, deck.headerFooter])
  const list = useRef<HTMLDivElement>(null)
  const press = useRef<{ id: string; y: number; dragging: boolean } | null>(null)
  const [drop, setDrop] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const picked = new Set(doc.picked)

  if (doc.mode === 'master') {
    return <MasterSlides doc={doc} view={view} />
  }

  /** Where dragged slides would go for a pointer at `y`: before the slide whose middle is below it. */
  const dropIndex = (y: number): number => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[data-rail-slide]') ?? [])]
    const index = items.findIndex((item) => {
      const rect = item.getBoundingClientRect()

      return y < rect.top + rect.height / 2
    })

    return index < 0 ? items.length : index
  }

  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Slides"
      aria-multiselectable="true"
      tabIndex={0}
      className="relative flex w-[196px] shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-line p-3 outline-none"
      onKeyDown={(event) => {
        const index = doc.index

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const next = deck.slides[Math.max(0, Math.min(deck.slides.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
          doc.goTo(next.id, event.shiftKey)
        } else if (event.key === 'Backspace' || event.key === 'Delete') {
          commands.deleteSlides()
        } else if (event.key === 'Home' || event.key === 'End') {
          doc.goTo(deck.slides[event.key === 'Home' ? 0 : deck.slides.length - 1].id)
        } else {
          return
        }

        event.preventDefault()
        event.stopPropagation()
      }}
      onPointerMove={(event) => {
        const now = press.current

        if (!now) {
          return
        }

        if (!now.dragging && Math.abs(event.clientY - now.y) > 5) {
          now.dragging = true

          if (!doc.picked.includes(now.id)) {
            doc.goTo(now.id)
          }
        }

        if (now.dragging) {
          setDrop(dropIndex(event.clientY))
        }
      }}
      onPointerUp={(event) => {
        const now = press.current
        press.current = null

        if (now?.dragging && drop !== null) {
          const moving = doc.pickedSlides
          const before = deck.slides.slice(0, drop).filter((slide) => !moving.includes(slide.id)).length
          commands.moveSlidesTo(moving, before)
        } else if (now && !now.dragging) {
          doc.goTo(now.id, event.shiftKey || event.metaKey)
        }

        setDrop(null)
      }}
      onPointerCancel={() => {
        press.current = null
        setDrop(null)
      }}
    >
      {deck.slides.map((slide, index) => {
        const transition = slide.transition?.kind ?? 'none'

        return (
          <div key={slide.id} data-rail-slide="" className="relative">
            {drop === index && <span className="absolute -top-[7px] right-0 left-5 h-[3px] rounded-full bg-accent" />}
            <button
              type="button"
              role="option"
              aria-selected={picked.has(slide.id)}
              aria-label={`Slide ${index + 1}${slide.hidden ? ', hidden' : ''}${transition === 'none' ? '' : `, ${TRANSITION_NAMES[transition]} transition`}`}
              onPointerDown={(event) => {
                if (event.button === 0) {
                  press.current = { id: slide.id, y: event.clientY, dragging: false }
                  list.current?.setPointerCapture(event.pointerId)
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault()

                if (!picked.has(slide.id)) {
                  doc.goTo(slide.id)
                }

                const rect = list.current?.getBoundingClientRect()
                setMenu({ x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) + (list.current?.scrollTop ?? 0) })
              }}
              className="flex w-full items-start gap-2 text-left"
            >
              <span className="flex w-4 shrink-0 flex-col items-end gap-1 pt-0.5 text-[11px] text-fg-3 tabular-nums">
                {index + 1}
                {slide.hidden && <IconEyeOff size={11} />}
                {transition !== 'none' && (
                  <span title={`${TRANSITION_NAMES[transition]} transition`}>
                    <IconTransitionRight size={11} />
                  </span>
                )}
              </span>
              <span className={cn('overflow-hidden rounded-[3px] ring-2 ring-offset-0', slide.id === doc.slide.id ? 'ring-accent' : picked.has(slide.id) ? 'ring-accent/50' : 'ring-transparent hover:ring-line-strong', slide.hidden && 'opacity-45')}>
                <Thumbnail deck={view} slide={slide} index={index} />
              </span>
            </button>
          </div>
        )
      })}
      {drop === deck.slides.length && <span className="-mt-[7px] ml-5 h-[3px] shrink-0 rounded-full bg-accent" />}
      <button
        type="button"
        onClick={() => commands.newSlide(doc.slide.layout === 'title' ? 'title-content' : doc.slide.layout)}
        className="ml-6 flex shrink-0 items-center justify-center rounded-[3px] border border-dashed border-line text-fg-3 hover:border-line-strong hover:text-fg"
        style={{ width: THUMB, height: (THUMB * deck.size.height) / deck.size.width }}
        aria-label="New slide"
      >
        <IconPlus size={18} />
      </button>
      {menu && (
        <div className="absolute z-40" style={{ left: Math.min(menu.x, 60), top: menu.y }}>
          <Menu
            align="left"
            onClose={() => setMenu(null)}
            items={[
              { id: 'new', label: 'New Slide', onSelect: () => commands.newSlide() },
              { id: 'duplicate', label: doc.picked.length > 1 ? 'Duplicate Slides' : 'Duplicate Slide', onSelect: commands.duplicateSlides },
              { id: 'hide', label: doc.pickedSlides.every((id) => deck.slides.find((slide) => slide.id === id)?.hidden) ? 'Show Slide' : 'Hide Slide', onSelect: commands.toggleHidden },
              { id: 'up', label: 'Move Up', disabled: doc.index === 0, onSelect: () => commands.moveSlidesBy(-1), dividerBefore: true },
              { id: 'down', label: 'Move Down', disabled: doc.index >= deck.slides.length - 1, onSelect: () => commands.moveSlidesBy(1) },
              { id: 'delete', label: doc.picked.length > 1 ? 'Delete Slides' : 'Delete Slide', danger: true, onSelect: commands.deleteSlides, dividerBefore: true }
            ]}
          />
        </div>
      )}
    </div>
  )
}
