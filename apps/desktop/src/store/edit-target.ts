import type { EditAction } from '../../shared/ipc.ts'
import { reducedMotion } from '../lib/motion.ts'
import { $webWindows } from './web-windows.ts'
import { $focusedWindowId, $windows, focusWindow } from './windows.ts'

/*
 * Where voice typing and editing land. Speaking usually starts with a click on the mic or the orb,
 * which moves focus off the text field the user meant, so the last focused editable element is
 * remembered and focused again before typing. When the frontmost Hermes window is a web page, the
 * action goes to that page instead.
 */

let lastEditable: HTMLElement | null = null
let bound = false

/** A field's own paste: resolves with why nothing was pasted, or null when it was. */
export type OwnPaste = () => Promise<string | null>

const ownPastes = new WeakMap<Element, OwnPaste>()

/**
 * Let a field paste by itself rather than take the browser's paste: the Terminal reads the
 * clipboard through main, filters it and may refuse, which a paste event cannot report back.
 */
export function setOwnPaste(element: Element, paste: OwnPaste): () => void {
  ownPastes.set(element, paste)

  return () => {
    if (ownPastes.get(element) === paste) {
      ownPastes.delete(element)
    }
  }
}

export function isEditable(element: Element | null): element is HTMLElement {
  if (!element || !(element instanceof HTMLElement)) {
    return false
  }

  if (element.isContentEditable) {
    return true
  }

  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly
  }

  if (element instanceof HTMLInputElement) {
    return !element.disabled && !element.readOnly && /^(text|search|url|email|password|tel|number|)$/.test(element.type)
  }

  return false
}

/** Remember the focused field now (a conversation is starting and may move focus to the orb/mic). */
export function rememberFocusedEditable(): void {
  if (isEditable(document.activeElement)) {
    lastEditable = document.activeElement
  }
}

export function bindEditTarget(): () => void {
  if (bound) {
    return () => undefined
  }

  bound = true
  // Pickers that type into the field the person was in (the emoji picker) opt out with data-edit-ignore.
  const remember = (element: Element | null) => {
    if (isEditable(element) && !element.closest('[data-edit-ignore]')) {
      lastEditable = element
    }
  }
  const onFocus = (event: FocusEvent) => remember(event.target as Element)
  // A press on a field also counts: focus events do not fire while the window is in the background.
  const onPointer = (event: PointerEvent) => remember((event.target as Element | null)?.closest?.('textarea, input, [contenteditable="true"]') ?? null)
  document.addEventListener('focusin', onFocus, true)
  document.addEventListener('pointerdown', onPointer, true)

  return () => {
    document.removeEventListener('focusin', onFocus, true)
    document.removeEventListener('pointerdown', onPointer, true)
    bound = false
  }
}

/** The OS window that contains an element (by the window manager's data attribute), if any. */
function windowIdOf(element: HTMLElement): string | null {
  return element.closest<HTMLElement>('[data-window-id]')?.dataset.windowId ?? null
}

/** Describe the target for captions: "the terminal", "the Hermes composer", "the web page". */
export function describeTarget(): string {
  const web = frontWebView()

  if (web) {
    return 'the web page'
  }

  const element = currentEditable()

  if (!element) {
    return 'nothing'
  }

  if (element.classList.contains('xterm-helper-textarea')) {
    return 'the terminal'
  }

  const label = element.getAttribute('aria-label') || element.getAttribute('placeholder') || ''

  return label ? `"${label.slice(0, 40)}"` : 'the text field'
}

function frontWebView(): string | null {
  const focused = $focusedWindowId.get()

  if (!focused) {
    return null
  }

  const entry = Object.values($webWindows.get()).find(w => w.windowId === focused)

  return entry?.id ?? null
}

function currentEditable(): HTMLElement | null {
  const active = document.activeElement

  if (isEditable(active) && !active.closest('[data-edit-ignore]')) {
    return active
  }

  return lastEditable?.isConnected ? lastEditable : null
}

/** The character before the caret in the target text field (null for the terminal and web pages). */
export function charBeforeCaret(): string | null {
  if (frontWebView()) {
    return null
  }

  const element = currentEditable()

  if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) || element.classList.contains('xterm-helper-textarea')) {
    return null
  }

  const caret = element.selectionStart ?? element.value.length

  return caret > 0 ? element.value[caret - 1] : ''
}

export class NoEditTargetError extends Error {
  constructor() {
    super('Nothing to type into. Click a text field (or the terminal) first, then say it again.')
    this.name = 'NoEditTargetError'
  }
}

/**
 * Perform an edit on the right target. `needsField`: typing and key presses need a text field (or a
 * web page); clipboard actions also work on a plain selection.
 */
export async function performEdit(action: EditAction, options: { needsField?: boolean } = {}): Promise<{ target: string }> {
  const web = frontWebView()

  if (web) {
    await window.heraldOS.edit.perform(action, web)

    return { target: 'the web page' }
  }

  const element = currentEditable()

  if (!element && options.needsField) {
    throw new NoEditTargetError()
  }

  if (element && document.activeElement !== element) {
    const windowId = windowIdOf(element)

    if (windowId && $windows.get()[windowId]) {
      focusWindow(windowId)
    }

    element.focus({ preventScroll: true })
  }

  const target = describeTarget()
  const own = action.kind === 'paste' && element ? ownPastes.get(element) : undefined

  if (own) {
    // A field that could not take the focus, such as a hidden Terminal tab, is not where the
    // person is pasting.
    if (document.activeElement !== element) {
      throw new NoEditTargetError()
    }

    const problem = await own()

    if (problem) {
      throw new Error(problem)
    }

    return { target }
  }

  await window.heraldOS.edit.perform(action)

  return { target }
}

/** Scroll the main content of the frontmost window. */
export function scrollFront(direction: 'up' | 'down' | 'top' | 'bottom'): boolean {
  const focused = $focusedWindowId.get()
  const win = focused ? $windows.get()[focused] : null
  const x = win ? win.bounds.x + win.bounds.width / 2 : window.innerWidth / 2
  const y = win ? win.bounds.y + win.bounds.height / 2 : window.innerHeight / 2
  let element = document.elementFromPoint(x, y) as HTMLElement | null

  while (element && element !== document.body) {
    const style = getComputedStyle(element)

    if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 4) {
      break
    }

    element = element.parentElement
  }

  if (!element || element === document.body) {
    return false
  }

  const behavior: ScrollBehavior = reducedMotion() ? 'auto' : 'smooth'

  if (direction === 'top') {
    element.scrollTo({ top: 0, behavior })
  } else if (direction === 'bottom') {
    element.scrollTo({ top: element.scrollHeight, behavior })
  } else {
    element.scrollBy({ top: (direction === 'down' ? 1 : -1) * element.clientHeight * 0.8, behavior })
  }

  return true
}
