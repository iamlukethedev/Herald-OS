import { IconChevronLeft, IconChevronRight, IconDeviceDesktopOff, IconLayoutGrid, IconPlayerPause, IconPlayerPlay, IconRefresh, IconTextDecrease, IconTextIncrease, IconX } from '@tabler/icons-react'
import { type ReactNode, useState } from 'react'
import { cn } from '../../../../lib/cn.ts'
import type { Deck, Slide } from '../deck.ts'
import { SlideView } from '../view/SlideView.tsx'
import { act, stopPresenting, usePresentationKeys } from './control.ts'
import { fitIn, useNow, useSize } from './hooks.ts'
import { Show } from './Show.tsx'
import { blank, counterText, durationText, elapsed, frameOf, goTo, next, type Presentation, previous, resetTimer, type Timer, toggleTimer } from './state.ts'

/*
 * The presenter view: the slide in front, large, and the next one; the speaker notes, as big as the
 * presenter wants them; the time taken, the clock and the slide counter; and the controls. With one
 * display the slide in front is the audience's own; with two it is the presenter's copy of it.
 */

const NOTE_SIZES = [14, 16, 18, 20, 24, 28, 32, 40]
const NOTE_SIZE_KEY = 'herald-slides.notes-size'

function savedNoteSize(): number {
  try {
    const saved = Number(localStorage.getItem(NOTE_SIZE_KEY))

    return NOTE_SIZES.includes(saved) ? saved : 20
  } catch {
    return 20
  }
}

function saveNoteSize(size: number): void {
  try {
    localStorage.setItem(NOTE_SIZE_KEY, String(size))
  } catch {
    // Notes keep their size for this presentation only.
  }
}

/** A label over one of the view's panes. */
function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('text-[11px] font-semibold tracking-[0.08em] text-fg-3 uppercase', className)}>{children}</div>
}

function ControlButton({ label, onClick, pressed, children, className }: { label: string; onClick: () => void; pressed?: boolean; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn('flex h-10 items-center gap-2 rounded-lg px-3.5 text-[14px] text-fg-2 hover:bg-white/10 hover:text-fg', pressed && 'bg-white/15 text-fg', className)}
    >
      {children}
    </button>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onMouseDown={(event) => event.preventDefault()} onClick={onClick} className="grid size-8 place-items-center rounded-md text-fg-3 hover:bg-white/10 hover:text-fg">
      {children}
    </button>
  )
}

/** A slide drawn fitted in the room its box has, centred. */
function Fitted({ deck, slide }: { deck: Deck; slide: Slide }) {
  const [box, size] = useSize<HTMLDivElement>()
  const fitted = fitIn(size, deck.size)

  return (
    <div ref={box} className="grid size-full place-items-center">
      {size.width > 0 && <SlideView deck={deck} slide={slide} scale={fitted.scale} mode="thumb" className="rounded-md ring-1 ring-white/10" />}
    </div>
  )
}

/** The time taken, with its pause and reset, and the time of day: the only part of the view drawn again each second. */
function Times({ timer }: { timer: Timer }) {
  const now = useNow()
  const running = timer.since !== null

  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className={cn('min-w-[5ch] text-[28px] font-medium tabular-nums', !running && 'text-fg-3')} aria-label="Time taken">
          {durationText(elapsed(timer, now))}
        </span>
        <IconButton label={running ? 'Pause the timer' : 'Resume the timer'} onClick={() => act((presentation) => ({ ...presentation, timer: toggleTimer(presentation.timer, Date.now()) }))}>
          {running ? <IconPlayerPause size={18} /> : <IconPlayerPlay size={18} />}
        </IconButton>
        <IconButton label="Reset the timer" onClick={() => act((presentation) => ({ ...presentation, timer: resetTimer(presentation.timer, Date.now()) }))}>
          <IconRefresh size={18} />
        </IconButton>
      </div>
      <div className="flex-1 text-center text-[22px] text-fg-2 tabular-nums" aria-label="Time of day">
        {new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </div>
    </>
  )
}

/** Every slide shown, to go to one. */
function SlideGrid({ deck, state, onClose }: { deck: Deck; state: Presentation; onClose: () => void }) {
  const width = 208
  const scale = width / deck.size.width

  return (
    <div role="dialog" aria-label="All slides" className="absolute inset-0 z-10 flex flex-col bg-[#0b0c0f]/95 backdrop-blur-sm">
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/8 px-6">
        <span className="text-[16px] text-fg-2">All slides</span>
        <IconButton label="Close" onClick={onClose}>
          <IconX size={18} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid justify-center gap-5" style={{ gridTemplateColumns: `repeat(auto-fill, ${width}px)` }}>
          {state.shown.map((id, index) => {
            const slide = deck.slides.find((entry) => entry.id === id)

            return (
              slide && (
                <button
                  key={id}
                  type="button"
                  aria-label={`Go to slide ${index + 1}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    act((presentation) => goTo(presentation, index))
                    onClose()
                  }}
                  className="flex flex-col gap-1.5 text-left"
                >
                  <SlideView deck={deck} slide={slide} scale={scale} mode="thumb" className={cn('rounded-[4px] ring-1', index === state.at ? 'ring-2 ring-accent' : 'ring-white/10 hover:ring-white/40')} />
                  <span className={cn('text-[12px] tabular-nums', index === state.at ? 'text-fg' : 'text-fg-3')}>{index + 1}</span>
                </button>
              )
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** The presenter view, over everything in Herald's window. */
export function PresenterView({ deck, state }: { deck: Deck; state: Presentation }) {
  const [grid, setGrid] = useState(false)
  const [noteSize, setNoteSize] = useState(savedNoteSize)
  const [pane, paneSize] = useSize<HTMLDivElement>()
  const frame = frameOf(state)
  const slideOf = (id: string | null) => (id === null ? undefined : deck.slides.find((slide) => slide.id === id))
  const current = slideOf(frame.current)
  const upcoming = slideOf(frame.next)
  const fitted = fitIn(paneSize, deck.size)
  const notes = current?.notes ?? ''

  usePresentationKeys(window, (event) => {
    if (grid && event.key === 'Escape') {
      setGrid(false)

      return true
    }

    return false
  })

  const resize = (by: number) => {
    const size = NOTE_SIZES[Math.max(0, Math.min(NOTE_SIZES.length - 1, NOTE_SIZES.indexOf(noteSize) + by))]
    setNoteSize(size)
    saveNoteSize(size)
  }

  return (
    <div role="dialog" aria-label="Presenter view" className="fixed inset-0 z-[2147483000] flex flex-col overflow-hidden bg-[#0b0c0f] text-fg select-none">
      <header className="flex h-16 shrink-0 items-center gap-6 border-b border-white/8 px-6">
        <Times timer={state.timer} />
        <div className="text-[20px] text-fg-2 tabular-nums">{counterText(frame)}</div>
      </header>
      <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.75fr)_minmax(300px,1fr)] gap-6 p-6">
        <section className="flex min-h-0 min-w-0 flex-col gap-2.5">
          <Label>{state.mode === 'split' ? 'Showing now' : 'Current slide'}</Label>
          <div ref={pane} className="grid min-h-0 flex-1 place-items-center">
            {paneSize.width > 0 && (
              <div className="cursor-pointer" onClick={() => act(next)}>
                <Show deck={deck} state={state} width={fitted.width} height={fitted.height} blankAs={state.mode === 'displays' ? 'label' : 'cover'} className="rounded-md ring-1 ring-white/10" />
              </div>
            )}
          </div>
        </section>
        <aside className="flex min-h-0 min-w-0 flex-col gap-5">
          <div className="flex h-[36%] shrink-0 flex-col gap-2.5">
            <Label>Next</Label>
            <div className="min-h-0 flex-1">
              {upcoming ? (
                <Fitted deck={deck} slide={upcoming} />
              ) : (
                <div className="grid size-full place-items-center rounded-md border border-dashed border-white/12 text-[15px] text-fg-3">End of the presentation</div>
              )}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <Label>Notes</Label>
              <div className="flex items-center gap-0.5">
                <IconButton label="Smaller notes" onClick={() => resize(-1)}>
                  <IconTextDecrease size={17} />
                </IconButton>
                <IconButton label="Larger notes" onClick={() => resize(1)}>
                  <IconTextIncrease size={17} />
                </IconButton>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md bg-white/[0.035] px-5 py-4 select-text">
              {notes.trim() ? (
                <p className="leading-[1.45] break-words whitespace-pre-wrap text-fg" style={{ fontSize: noteSize }}>
                  {notes}
                </p>
              ) : (
                <p className="text-[15px] text-fg-4">{frame.ended ? 'The presentation is over.' : 'No notes for this slide.'}</p>
              )}
            </div>
          </div>
        </aside>
      </main>
      <footer className="relative flex h-16 shrink-0 items-center justify-center gap-2 border-t border-white/8 px-6">
        <ControlButton label="Previous slide" onClick={() => act(previous)}>
          <IconChevronLeft size={20} /> Previous
        </ControlButton>
        <ControlButton label="Next slide" onClick={() => act(next)} className="bg-white/[0.07]">
          Next <IconChevronRight size={20} />
        </ControlButton>
        <div className="mx-2 h-6 w-px bg-white/10" />
        <ControlButton label="Black screen" pressed={state.blank === 'black'} onClick={() => act((presentation) => blank(presentation, 'black'))}>
          <IconDeviceDesktopOff size={18} /> Black screen
        </ControlButton>
        <ControlButton label="All slides" pressed={grid} onClick={() => setGrid((open) => !open)}>
          <IconLayoutGrid size={18} /> Slides
        </ControlButton>
        <div className="mx-2 h-6 w-px bg-white/10" />
        <ControlButton label="End the presentation" onClick={stopPresenting}>
          <IconX size={18} /> End
        </ControlButton>
        {state.typed && <div className="absolute right-6 rounded-md bg-white/10 px-3 py-1.5 text-[14px] text-fg tabular-nums">Go to slide {state.typed}: press Enter</div>}
      </footer>
      {grid && <SlideGrid deck={deck} state={state} onClose={() => setGrid(false)} />}
    </div>
  )
}
