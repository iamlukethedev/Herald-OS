import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { mirrorStyles } from '../../../../lib/mirror-styles.ts'
import type { Deck } from '../deck.ts'
import { addSlideStyles } from '../view/slide-css.ts'
import { $audience, act, closeAudienceWindow, stopPresenting, usePresentationKeys } from './control.ts'
import { useIdle, useWindowSize } from './hooks.ts'
import { Show } from './Show.tsx'
import { next, type Presentation, previous } from './state.ts'

/*
 * The audience window: an empty page of Herald's own that the main process puts full screen on
 * another display, drawn from this page. Its head holds copies of this page's style sheets (and of
 * those that come later, as chunks load); its keys and its size are its own.
 */

function AudienceView({ win, deck, state }: { win: Window; deck: Deck; state: Presentation }) {
  const size = useWindowSize(win)
  const { idle, wake } = useIdle()
  usePresentationKeys(win)

  return (
    <div
      role="dialog"
      aria-label="Presentation"
      className="select-none"
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#000', cursor: idle ? 'none' : 'default' }}
      onMouseMove={wake}
      onClick={() => act(next)}
      onContextMenu={(event) => {
        event.preventDefault()
        act(previous)
      }}
    >
      <Show deck={deck} state={state} width={size.width} height={size.height} />
    </div>
  )
}

/** The slides in the audience window, drawn from here; closing that window ends the presentation. */
export function Audience({ win, deck, state }: { win: Window; deck: Deck; state: Presentation }) {
  const [page, setPage] = useState(() => win.document)
  const [root, setRoot] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    addSlideStyles()
    const stop = mirrorStyles(document, page)
    page.body.style.cssText = 'margin: 0; background: #000; overflow: hidden;'
    const element = page.createElement('div')
    page.body.append(element)
    setRoot(element)

    return () => {
      stop()
      element.remove()
      setRoot(null)
    }
  }, [page])

  useEffect(() => {
    const check = () => {
      if (win.closed) {
        if ($audience.get() === win) {
          stopPresenting()
        }
      } else if (win.document !== page) {
        setPage(win.document)
      }
    }
    const poll = setInterval(check, 400)
    const onHide = () => setTimeout(check, 50)
    win.addEventListener('pagehide', onHide)
    window.addEventListener('pagehide', closeAudienceWindow)

    return () => {
      clearInterval(poll)
      win.removeEventListener('pagehide', onHide)
      window.removeEventListener('pagehide', closeAudienceWindow)
    }
  }, [win, page])

  return root ? createPortal(<AudienceView win={win} deck={deck} state={state} />, root) : null
}
