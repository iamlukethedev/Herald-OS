/*
 * A window opened on an empty page and drawn from its opener (Herald Slides' audience window, the
 * Dock's menu) has no style sheets of its own: its head holds copies of the opener's, and of those
 * that come later, as chunks load.
 */

const SHEETS = 'style, link[rel~="stylesheet"]'

/** Keep copies of a page's style sheets, root attributes and base address in another page, until stopped. */
export function mirrorStyles(from: Document, to: Document): () => void {
  const copies = new Map<Element, Element>()
  const base = to.createElement('base')
  base.href = from.baseURI
  to.head.prepend(base)

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
    copies.forEach(copy => copy.remove())
    base.remove()
  }
}
