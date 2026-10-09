import { useStore } from '@nanostores/react'
import { IconChevronLeft, IconChevronRight, IconPresentation, IconX } from '@tabler/icons-react'
import { type ReactNode, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { $env } from '../../../store/backend.ts'
import { isPanels } from '../../../store/shell.ts'
import type { Deck } from './deck.ts'
import { useDeck } from './editor/Stage.tsx'
import { Audience } from './present/Audience.tsx'
import { $audience, act, canUseTwoDisplays, closeAudienceWindow, enterFullScreen, openAudienceWindow, stopPresenting, useFullScreenEnd, usePresentationKeys } from './present/control.ts'
import { useIdle, useWindowSize } from './present/hooks.ts'
import { PresenterView } from './present/PresenterView.tsx'
import { Show } from './present/Show.tsx'
import { begin, follow, frameOf, next, type Presentation, type PresentMode, previous, withMode } from './present/state.ts'
import { $presentation, decks } from './store.ts'

/*
 * Presenting: the deck's shown slides one at a time over everything, fitted to the window, each
 * coming in by its transition, with an end screen after the last; or the presenter view, the
 * slides beside it in Herald's window or on another display. Arrows, Space, Enter, Page keys and
 * clicks move on; typing a number and Enter jumps; B and W blank the screen; Escape ends.
 */

/** Whether the slides can go on a display of their own while the presenter view stays on this one. */
export { canUseTwoDisplays }

/** End the presentation in every view. */
export { stopPresenting }

/** How to present. */
export interface PresentOptions {
  /** Show the presenter view: the slides go on another display when there is one, else beside it in Herald's window. */
  presenter?: boolean
  /** With the presenter view, keep the slides beside it in Herald's window even when another display is there. */
  oneDisplay?: boolean
}

/** Where the presenter view puts the slides: on another display when a window opens there, else beside it. */
function presenterMode(oneDisplay = false): PresentMode {
  return !oneDisplay && canUseTwoDisplays() && openAudienceWindow() ? 'displays' : 'split'
}

/**
 * Start presenting a deck from its slide at `index` (the next one shown when that one is hidden):
 * called from the click or key that asks, since the system grants full screen and a window on
 * another display only then.
 */
export function startPresenting(key: string, index: number, options: PresentOptions = {}): void {
  const doc = decks.get(key)

  if (!doc) {
    return
  }

  // Herald's own window fills the screen already, and the developer's window is presented in;
  // a window of its own (panels) goes full screen.
  const own = isPanels || (!$env.get()?.isDev && (window.outerWidth < screen.width || window.outerHeight < screen.height))

  if (own) {
    enterFullScreen()
  }

  const mode = options.presenter ? presenterMode(options.oneDisplay) : 'slides'

  if (mode !== 'displays') {
    closeAudienceWindow()
  }

  $presentation.set(begin(doc.history.present, key, index, Date.now(), mode))
}

/** Show or hide the presenter view while presenting; shown, it puts the slides on another display when there is one. */
export function showPresenterView(shown: boolean, options: Pick<PresentOptions, 'oneDisplay'> = {}): void {
  if (!$presentation.get()) {
    return
  }

  const mode = shown ? presenterMode(options.oneDisplay) : 'slides'

  if (mode !== 'displays') {
    closeAudienceWindow()
  }

  act((state) => withMode(state, mode))
}

/** Whether a deck is being presented. */
export const isPresenting = (): boolean => $presentation.get() !== null

function PillButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onMouseDown={(event) => event.preventDefault()} onClick={onClick} className="grid size-7 place-items-center rounded-full hover:bg-white/15">
      {children}
    </button>
  )
}

/** The slides alone over everything, with a few controls that hide while the mouse rests. */
function SlidesAlone({ deck, state }: { deck: Deck; state: Presentation }) {
  const size = useWindowSize(window)
  const { idle, wake } = useIdle()
  const frame = frameOf(state)
  usePresentationKeys(window)

  return (
    <div
      role="dialog"
      aria-label={frame.ended ? 'End of the presentation' : `Presenting slide ${frame.number} of ${frame.count}`}
      className="fixed inset-0 z-[2147483000] overflow-hidden bg-black select-none"
      style={{ cursor: idle ? 'none' : 'default' }}
      onMouseMove={wake}
      onClick={() => act(next)}
      onContextMenu={(event) => {
        event.preventDefault()
        act(previous)
      }}
    >
      <Show deck={deck} state={state} width={size.width} height={size.height} />
      <div
        className="absolute bottom-5 left-5 z-10 flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-1 text-[12px] text-white/80 backdrop-blur transition-opacity duration-300"
        style={{ opacity: idle ? 0 : 1, pointerEvents: idle ? 'none' : 'auto' }}
        onClick={(event) => event.stopPropagation()}
      >
        <PillButton label="Previous slide" onClick={() => act(previous)}>
          <IconChevronLeft size={16} />
        </PillButton>
        <span className="min-w-14 text-center tabular-nums">{frame.ended ? 'End' : `${frame.number} / ${frame.count}`}</span>
        <PillButton label="Next slide" onClick={() => act(next)}>
          <IconChevronRight size={16} />
        </PillButton>
        <PillButton label="Presenter view" onClick={() => showPresenterView(true)}>
          <IconPresentation size={15} />
        </PillButton>
        <PillButton label="End the presentation" onClick={stopPresenting}>
          <IconX size={15} />
        </PillButton>
      </div>
    </div>
  )
}

/**
 * The presentation under way, drawn on the page itself rather than in the window, whose frame would
 * hold it to its own size; and in the audience window, when the slides are on another display.
 */
export function Present() {
  const state = useStore($presentation)
  const audience = useStore($audience)
  const doc = state ? decks.get(state.key) : undefined
  useDeck(doc)
  const deck = doc?.history.present
  useFullScreenEnd()

  useEffect(
    () => () => {
      if ($presentation.get()) {
        stopPresenting()
      }
    },
    []
  )

  useEffect(() => {
    if (state && !doc) {
      stopPresenting()
    }
  }, [state, doc])

  useEffect(() => {
    if (deck) {
      act((current) => follow(current, deck))
    }
  }, [deck])

  if (!state || !deck) {
    return null
  }

  const run = `${state.key}:${state.started}`

  if (state.mode === 'slides') {
    return createPortal(<SlidesAlone key={run} deck={deck} state={state} />, document.body)
  }

  return (
    <>
      {createPortal(<PresenterView key={run} deck={deck} state={state} />, document.body)}
      {state.mode === 'displays' && audience && <Audience key={run} win={audience} deck={deck} state={state} />}
    </>
  )
}
