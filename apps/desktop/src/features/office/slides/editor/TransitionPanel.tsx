import { IconArrowBarRight, IconArrowsHorizontal, IconBan, IconBlur, IconLayersDifference, IconLayersSubtract, IconPlayerPlay, IconSquareHalf, IconZoomIn } from '@tabler/icons-react'
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../../../lib/cn.ts'
import { type SlideTransition, type Transition, TRANSITIONS } from '../deck.ts'
import type { SlidesDocument } from '../document.ts'
import { choreograph } from '../present/effects.ts'
import { DIRECTION_NAMES, DIRECTIONS, TRANSITION_NAMES } from '../transitions.ts'
import { SlideView } from '../view/SlideView.tsx'
import { ofKind, setPickedTransition, transitionInFront, transitionToAll } from './master-commands.ts'
import { useDeck } from './Stage.tsx'

/*
 * How the picked slides come in when presenting: the kind of transition, the way it goes and how
 * long it takes, played in miniature from the slide before to the slide in front; or the same
 * transition for every slide.
 */

const ICONS: Record<Transition, ReactNode> = {
  none: <IconBan size={18} />,
  fade: <IconBlur size={18} />,
  push: <IconArrowBarRight size={18} />,
  wipe: <IconSquareHalf size={18} />,
  cover: <IconLayersSubtract size={18} />,
  uncover: <IconLayersDifference size={18} />,
  split: <IconArrowsHorizontal size={18} />,
  zoom: <IconZoomIn size={18} />
}

/** Seconds offered as they are. */
const DURATIONS = [0.25, 0.5, 0.75, 1, 1.5, 2]

const PREVIEW = 180

function Heading({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">{children}</div>
}

function Chip({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={active} disabled={disabled} onClick={onClick} className={cn('h-7 rounded-md border border-line px-2 tabular-nums hover:bg-white/8 hover:text-fg disabled:opacity-40', active && 'border-accent bg-accent/12 text-fg')}>
      {children}
    </button>
  )
}

/** The slide before (black before the first) giving way to the slide in front, played again on asking. */
function Preview({ doc, transition }: { doc: SlidesDocument; transition: SlideTransition }) {
  const deck = doc.presentation
  const index = doc.index
  const slide = deck.slides[index]
  const before = index > 0 ? deck.slides[index - 1] : undefined
  const arriving = useRef<HTMLDivElement>(null)
  const leaving = useRef<HTMLDivElement>(null)
  const [run, setRun] = useState(0)
  const { kind, duration, direction, orientation } = transition
  const plan = useMemo(
    () => choreograph({ kind, duration, ...(direction ? { direction } : {}), ...(orientation ? { orientation } : {}) }, false, window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    [kind, duration, direction, orientation]
  )
  const scale = PREVIEW / deck.size.width

  useLayoutEffect(() => {
    if (!plan) {
      return
    }

    const animations = [plan.arriving && arriving.current?.animate(plan.arriving.keyframes, plan.arriving.options), plan.leaving && leaving.current?.animate(plan.leaving.keyframes, plan.leaving.options)].filter(
      (animation): animation is Animation => Boolean(animation)
    )

    return () => animations.forEach((animation) => animation.cancel())
  }, [plan, run])

  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      <div className="relative overflow-hidden rounded-[3px] bg-black ring-1 ring-black/10" style={{ width: PREVIEW, height: deck.size.height * scale }}>
        {before && (
          <div ref={leaving} className="absolute inset-0" style={{ zIndex: plan?.top === 'leaving' ? 2 : 1 }}>
            <SlideView deck={deck} slide={before} scale={scale} mode="thumb" index={index - 1} />
          </div>
        )}
        {slide && (
          <div ref={arriving} className="absolute inset-0" style={{ zIndex: plan?.top === 'leaving' ? 1 : 2 }}>
            <SlideView deck={deck} slide={slide} scale={scale} mode="thumb" index={index} />
          </div>
        )}
      </div>
      <button type="button" disabled={!plan} onClick={() => setRun(run + 1)} className="flex h-7 items-center justify-center gap-1.5 rounded-md hover:bg-white/8 hover:text-fg disabled:opacity-40">
        <IconPlayerPlay size={13} /> Preview
      </button>
    </div>
  )
}

export function TransitionPanel({ doc, onDone }: { doc: SlidesDocument; onDone?: () => void }) {
  useDeck(doc)
  const [typed, setTyped] = useState<string | null>(null)
  const now = transitionInFront(doc)

  if (!now) {
    return <div className="w-[280px] px-1.5 py-1 text-[12px] text-fg-3">Transitions belong to slides: close the master view to set one.</div>
  }

  const set = (transition: SlideTransition, join?: string) => setPickedTransition(transition, doc, join)
  const still = now.kind === 'none'
  const picked = doc.pickedSlides.length

  return (
    <div className="flex w-[400px] flex-col gap-3 text-[12px] text-fg-2">
      <div className="grid grid-cols-4 gap-1">
        {TRANSITIONS.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={now.kind === kind}
            onClick={() => set(ofKind(kind, now))}
            className={cn('flex h-14 flex-col items-center justify-center gap-1 rounded-lg text-[11.5px] hover:bg-white/8 hover:text-fg', now.kind === kind && 'bg-white/12 text-fg ring-1 ring-accent')}
          >
            {ICONS[kind]}
            {TRANSITION_NAMES[kind]}
          </button>
        ))}
      </div>
      {DIRECTIONS[now.kind].length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Heading>Effect options</Heading>
          <div className="flex flex-wrap gap-1">
            {DIRECTIONS[now.kind].map((direction) => (
              <Chip key={direction} active={now.direction === direction} onClick={() => set({ ...now, direction })}>
                {DIRECTION_NAMES[direction]}
              </Chip>
            ))}
            {now.kind === 'split' &&
              (['horizontal', 'vertical'] as const).map((orientation) => (
                <Chip key={orientation} active={(now.orientation ?? 'horizontal') === orientation} onClick={() => set({ ...now, orientation })}>
                  {orientation === 'horizontal' ? 'Horizontal' : 'Vertical'}
                </Chip>
              ))}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Heading>Duration</Heading>
        <div className="flex flex-wrap items-center gap-1">
          {DURATIONS.map((seconds) => (
            <Chip key={seconds} active={Math.abs(now.duration - seconds * 1000) < 1} disabled={still} onClick={() => set({ ...now, duration: seconds * 1000 })}>
              {seconds} s
            </Chip>
          ))}
          <input
            type="number"
            min={0.01}
            max={60}
            step={0.05}
            disabled={still}
            value={typed ?? String(Math.round(now.duration / 10) / 100)}
            onChange={(event) => {
              const seconds = event.target.valueAsNumber
              setTyped(event.target.value)

              if (Number.isFinite(seconds) && seconds > 0) {
                set({ ...now, duration: Math.max(10, Math.round(Math.min(60, seconds) * 1000)) }, 'transition-duration')
              }
            }}
            onBlur={() => setTyped(null)}
            aria-label="Duration in seconds"
            className="glass-input ml-1 h-7 w-16 rounded-md px-1.5 text-[12px] text-fg tabular-nums outline-none disabled:opacity-40"
          />
          <span className="text-fg-3">seconds</span>
        </div>
      </div>
      <div className="flex items-end gap-3 border-t border-line pt-3">
        <Preview doc={doc} transition={now} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="text-[11.5px] text-fg-3">{picked > 1 ? `Set on the ${picked} picked slides.` : 'Set on the slide in front.'}</span>
          <button
            type="button"
            onClick={() => {
              transitionToAll(now, doc)
              onDone?.()
            }}
            className="h-8 rounded-md border border-line hover:bg-white/8 hover:text-fg"
          >
            Apply to All Slides
          </button>
        </div>
      </div>
    </div>
  )
}
