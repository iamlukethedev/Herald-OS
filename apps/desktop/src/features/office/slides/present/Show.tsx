import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../../../../lib/cn.ts'
import { reducedMotion } from '../../../../lib/motion.ts'
import type { Deck } from '../deck.ts'
import { SlideView } from '../view/SlideView.tsx'
import { type Choreography, choreograph } from './effects.ts'
import { fitIn } from './hooks.ts'
import { type Move, moveTransition, type Presentation } from './state.ts'

/*
 * The slides as the audience sees them: the slide in front fitted in the room given and centred,
 * the transition into it played over the slide before, the end screen after the last slide, and
 * the screen blanked to black or white. Each view plays a move once, when it comes.
 */

export interface ShowProps {
  deck: Deck
  state: Presentation
  /** The room it fills, in CSS pixels. */
  width: number
  height: number
  /** A blanked screen covering everything (what the audience sees), or laid over the slide, dimmed and named (the presenter's copy). */
  blankAs?: 'cover' | 'label'
  className?: string
}

// Structure is styled inline: the audience window's copies of the style sheets may still be loading.
const fill: CSSProperties = { position: 'absolute', inset: 0 }

function planOf(deck: Deck, move: Move): Choreography | null {
  const { transition, reverse } = moveTransition(deck, move)

  return choreograph(transition, reverse, reducedMotion())
}

/** The end of the presentation, after its last slide. */
function EndScreen() {
  return (
    <div className="grid place-items-center bg-black text-center" style={fill}>
      <div className="text-[15px] text-white/70">
        End of the presentation
        <div className="mt-1 text-[12px] text-white/40">Click or press Escape to go back</div>
      </div>
    </div>
  )
}

export function Show({ deck, state, width, height, blankAs = 'cover', className }: ShowProps) {
  const arriving = useRef<HTMLDivElement>(null)
  const leaving = useRef<HTMLDivElement>(null)
  const { move } = state
  const [played, setPlayed] = useState(() => move?.serial ?? 0)
  const playing = move && move.serial !== played ? move : null
  const plan = playing ? planOf(deck, playing) : null
  const current = state.shown[state.at] ?? null
  const fitted = fitIn({ width, height }, deck.size)

  useLayoutEffect(() => {
    if (!playing) {
      return
    }

    if (!plan) {
      setPlayed(playing.serial)

      return
    }

    const animations = [plan.arriving && arriving.current?.animate(plan.arriving.keyframes, plan.arriving.options), plan.leaving && leaving.current?.animate(plan.leaving.keyframes, plan.leaving.options)].filter(
      (animation): animation is Animation => Boolean(animation)
    )
    let live = true
    const done = () => {
      if (live) {
        setPlayed(playing.serial)
      }
    }
    const late = setTimeout(done, plan.duration + 100)
    void Promise.all(animations.map((animation) => animation.finished)).then(done, () => {})

    return () => {
      live = false
      clearTimeout(late)
      animations.forEach((animation) => animation.cancel())
    }
  }, [playing?.serial])

  const layer = (id: string | null, role: 'arriving' | 'leaving') => {
    const slide = id === null ? undefined : deck.slides.find((entry) => entry.id === id)

    return (
      <div key={id ?? 'end'} ref={role === 'arriving' ? arriving : leaving} style={{ ...fill, zIndex: plan?.top === role ? 2 : 1 }}>
        {id === null ? <EndScreen /> : slide ? <SlideView deck={deck} slide={slide} scale={fitted.scale} mode="present" /> : null}
      </div>
    )
  }

  return (
    <div className={className} style={{ position: 'relative', overflow: 'hidden', width, height }}>
      <div style={{ position: 'absolute', overflow: 'hidden', left: (width - fitted.width) / 2, top: (height - fitted.height) / 2, width: fitted.width, height: fitted.height }}>
        {plan && playing && playing.from !== current && layer(playing.from, 'leaving')}
        {layer(current, 'arriving')}
      </div>
      {state.blank &&
        (blankAs === 'cover' ? (
          <div style={{ ...fill, zIndex: 3, background: state.blank }} />
        ) : (
          <div className={cn('grid place-items-center text-[14px] font-medium', state.blank === 'black' ? 'bg-black/80 text-white/80' : 'bg-white/80 text-black/70')} style={{ ...fill, zIndex: 3 }}>
            {state.blank === 'black' ? 'The screen is black' : 'The screen is white'}
          </div>
        ))}
    </div>
  )
}
