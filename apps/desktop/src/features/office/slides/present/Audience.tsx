import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
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

const SHEETS = 'style, link[rel~="stylesheet"]'

/** Keep copies of a page's style sheets, root attributes and base address in another page, until stopped. */
function mirrorStyles(from: Document, to: Document): () => void {
  addSlideStyles()
  const copies = new Map<Element, Element>()
  const base = to.createElement('base')
  base.href = from.baseURI
  to.head.prepend(base)
  to.body.style.cssText = 'margin: 0; background: #000; overflow: hidden;'

  const sync = () => {
    const root = from.documentElement

    for (const name of to.documentElement.getAttributeNames()) {
      if (!root.hasAttribute(name)) {
        to.documentElement.removeAttribute(name)
      }
    }

    for (const name of root.getAttributeNames()) {
      to.documentElement.setAttribute(name, root.getAttribute(name) ?? '')
    }

    for (const [original, copy] of copies) {
      if (!original.isConnected) {
        copy.remove()
        copies.delete(original)
      }
    }

    for (const original of from.head.querySelectorAll(SHEETS)) {
      const copy = copies.get(original)

      if (!copy) {
        const made = to.importNode(original, true)

        if (original instanceof HTMLLinkElement) {
          made.setAttribute('href', original.href)
        }

        to.head.append(made)
        copies.set(original, made)
      } else if (original.tagName === 'STYLE' && copy.textContent !== original.textContent) {
        copy.textContent = original.textContent
      }
    }
  }

  sync()
  const observer = new MutationObserver(sync)
  observer.observe(from.head, { childList: true, subtree: true, characterData: true })
  observer.observe(from.documentElement, { attributes: true })

  return () => {
    observer.disconnect()
    copies.forEach((copy) => copy.remove())
    base.remove()
  }
}

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
    const stop = mirrorStyles(document, page)
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
