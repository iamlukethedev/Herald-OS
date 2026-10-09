/*
 * Where the keyboard goes when typing in a slide ends. The window's shortcuts (⌘S and the rest) and
 * the deck's own keys (⌘Z, the arrows, Delete) hear only keys pressed inside the window, so focus
 * left on the editor as it goes, or on a menu as it closes, would fall out to the page.
 */

/** The slide area's own focus target, which takes the keyboard when typing ends. */
export const STAGE = '[data-slides-stage]'

/** Whether focus is nowhere, or in `leaving` and about to go with it. */
function lost(leaving: Element): boolean {
  const active = document.activeElement

  return !active || active === document.body || leaving.contains(active)
}

/**
 * Give `home` the keyboard as `leaving` goes: now when focus is in it or nowhere, else after the
 * frame if it has fallen out by then, as it does when a menu that ended the typing closes. Focus the
 * person moved somewhere else (the slide list, the notes) stays there.
 */
export function keepFocusHome(home: HTMLElement | null, leaving: Element): void {
  if (!home) {
    return
  }

  if (lost(leaving)) {
    home.focus({ preventScroll: true })

    return
  }

  requestAnimationFrame(() => {
    if (home.isConnected && lost(leaving)) {
      home.focus({ preventScroll: true })
    }
  })
}
