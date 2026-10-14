import { atom, computed } from 'nanostores'
import { appById, appName, type FloatingAppId, type HermesAppId, type PageId } from '../shell/apps.ts'
import { afterExit, motion } from '../lib/motion.ts'
import { $prefs, updatePrefs } from './backend.ts'
import { $language } from './i18n.ts'
import { isMainSurface, isPanels, relayToMain } from './shell.ts'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export type WindowPhase = 'opening' | 'open' | 'minimizing' | 'minimized' | 'closing'

export interface OSWindow {
  id: string
  appId: HermesAppId
  title: string
  bounds: Bounds
  z: number
  phase: WindowPhase
  maximized: boolean
  /** Bounds to restore after un-maximizing. */
  restoreBounds?: Bounds
  /** App-specific payload (e.g. a session id for a popped-out chat). */
  payload?: Record<string, unknown>
}

export const MAIN_WINDOW_ID = 'main'

export const $windows = atom<Record<string, OSWindow>>({})
export const $focusedWindowId = atom<string | null>(null)
export const $page = atom<PageId>('overview')
/** Menu-bar title: the focused window's title, an app's own name in the language shown. */
export const $focusedTitle = computed([$windows, $focusedWindowId, $page, $language], (windows, id, page) => {
  if (!id || !windows[id]) {
    return 'Herald OS'
  }

  if (id === MAIN_WINDOW_ID) {
    return appName(appById(page))
  }

  const win = windows[id]

  return win.title === appById(win.appId).name ? appName(appById(win.appId)) : win.title
})

let zCounter = 10
let idCounter = 1

const MENUBAR = 30
const DOCK = 78
const MARGIN = 14

export function dockAutoHides(): boolean {
  return $prefs.get().dockAutoHide !== false
}

export function desktopArea(): Bounds {
  // An auto-hiding Dock gives its strip back to windows, like macOS.
  const dock = dockAutoHides() ? MARGIN : DOCK

  return { x: MARGIN, y: MENUBAR + MARGIN, width: window.innerWidth - MARGIN * 2, height: window.innerHeight - MENUBAR - dock - MARGIN }
}

function clamp(bounds: Bounds): Bounds {
  const area = desktopArea()
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))
  const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))

  return { x, y, width, height }
}

function nextBounds(appId: HermesAppId, preferred?: Bounds): Bounds {
  const saved = $prefs.get().windowBounds?.[appId]

  if (preferred) {
    return clamp(preferred)
  }

  if (saved) {
    return clamp(saved)
  }

  const size = appById(appId).defaultSize ?? { width: 900, height: 600 }
  const area = desktopArea()
  const offset = (Object.keys($windows.get()).length % 5) * 28

  return clamp({ x: area.x + (area.width - size.width) / 2 + offset, y: area.y + (area.height - size.height) / 2 + offset, ...size })
}

function update(id: string, patch: Partial<OSWindow>): void {
  const current = $windows.get()[id]

  if (!current) {
    return
  }

  $windows.set({ ...$windows.get(), [id]: { ...current, ...patch } })
}

export function focusWindow(id: string): void {
  const win = $windows.get()[id]

  if (!win) {
    return
  }

  if (win.phase === 'minimized' || win.phase === 'minimizing') {
    update(id, { phase: 'opening', z: ++zCounter })
    afterExit(() => update(id, { phase: 'open' }), motion.base)
  } else if (win.z !== zCounter) {
    update(id, { z: ++zCounter })
  }

  $focusedWindowId.set(id)
}

/** The main Hermes window is always present; opening it just focuses and optionally navigates. */
export function ensureMainWindow(): void {
  if ($windows.get()[MAIN_WINDOW_ID]) {
    return
  }

  const area = desktopArea()
  $windows.set({
    ...$windows.get(),
    [MAIN_WINDOW_ID]: { id: MAIN_WINDOW_ID, appId: 'overview', title: 'Hermes', bounds: area, z: ++zCounter, phase: 'opening', maximized: true, restoreBounds: area }
  })
  afterExit(() => update(MAIN_WINDOW_ID, { phase: 'open' }), motion.base)
  $focusedWindowId.set(MAIN_WINDOW_ID)
}

export function showPage(page: PageId): void {
  // Panels mode: only the Hermes window renders pages; other surfaces ask it (and the compositor focuses it).
  if (isPanels && !isMainSurface) {
    relayToMain({ type: 'show-page', args: [page] })
    window.heraldOS.shell.open('main').catch(() => undefined)

    return
  }

  ensureMainWindow()
  const current = $page.get()

  if (current !== page && !navigatingBack) {
    pageHistory.push(current)
    pageHistory.splice(0, Math.max(0, pageHistory.length - 30))
  }

  $page.set(page)
  focusWindow(MAIN_WINDOW_ID)
}

const pageHistory: PageId[] = []
let navigatingBack = false

/** Return to the previous page ("go back"); false when there is nowhere to go. */
export function goBackPage(): PageId | null {
  const previous = pageHistory.pop()

  if (!previous) {
    return null
  }

  navigatingBack = true

  try {
    showPage(previous)
  } finally {
    navigatingBack = false
  }

  return previous
}

export function openApp(appId: HermesAppId, options: { payload?: Record<string, unknown>; title?: string; bounds?: Bounds; singleton?: boolean } = {}): string {
  const def = appById(appId)

  if (def.kind === 'page') {
    showPage(appId as PageId)

    return MAIN_WINDOW_ID
  }

  // Panels mode: floating Hermes apps are real compositor windows, one Electron window each.
  if (isPanels) {
    window.heraldOS.shell.open(`window:${appId}`, options.payload ? { type: 'payload', payload: options.payload } : undefined).catch(() => undefined)

    return `window:${appId}`
  }

  const singleton = options.singleton ?? appId !== 'chat-popout'

  if (singleton) {
    const existing = Object.values($windows.get()).find(w => w.appId === appId)

    if (existing) {
      focusWindow(existing.id)

      return existing.id
    }
  }

  const id = `w${idCounter++}`
  const win: OSWindow = {
    id,
    appId,
    title: options.title ?? def.name,
    bounds: nextBounds(appId, options.bounds),
    z: ++zCounter,
    phase: 'opening',
    maximized: false,
    payload: options.payload
  }
  $windows.set({ ...$windows.get(), [id]: win })
  $focusedWindowId.set(id)
  afterExit(() => update(id, { phase: 'open' }), motion.base)

  return id
}

/** Rename a floating window (e.g. a web window following its page title). */
export function retitleWindow(id: string, title: string): void {
  if (id !== MAIN_WINDOW_ID && title.trim()) {
    update(id, { title: title.trim() })
  }
}

export function closeWindow(id: string): void {
  const win = $windows.get()[id]

  if (!win || id === MAIN_WINDOW_ID) {
    // The main window minimizes instead of closing: Hermes is always there.
    if (win) {
      minimizeWindow(id)
    }

    return
  }

  update(id, { phase: 'closing' })
  afterExit(() => {
    const next = { ...$windows.get() }
    delete next[id]
    $windows.set(next)

    if ($focusedWindowId.get() === id) {
      const top = Object.values(next).filter(w => w.phase !== 'minimized').sort((a, b) => b.z - a.z)[0]
      $focusedWindowId.set(top?.id ?? null)
    }
  }, motion.fast + 40)
}

export function minimizeWindow(id: string): void {
  const win = $windows.get()[id]

  if (!win || win.phase === 'minimized') {
    return
  }

  update(id, { phase: 'minimizing' })
  afterExit(() => {
    update(id, { phase: 'minimized' })

    if ($focusedWindowId.get() === id) {
      const top = Object.values($windows.get()).filter(w => w.id !== id && w.phase !== 'minimized' && w.phase !== 'minimizing').sort((a, b) => b.z - a.z)[0]
      $focusedWindowId.set(top?.id ?? null)
    }
  }, motion.slow - 80)
}

export function toggleMaximize(id: string): void {
  const win = $windows.get()[id]

  if (!win) {
    return
  }

  if (win.maximized) {
    update(id, { maximized: false, bounds: clamp(win.restoreBounds ?? nextBounds(win.appId)) })
  } else {
    update(id, { maximized: true, restoreBounds: win.bounds, bounds: desktopArea() })
  }
}

export function setBounds(id: string, bounds: Bounds, persist = false): void {
  const win = $windows.get()[id]

  if (!win) {
    return
  }

  const clamped = clamp({ ...bounds, width: Math.max(360, bounds.width), height: Math.max(240, bounds.height) })
  update(id, { bounds: clamped, maximized: false })

  if (persist && id !== MAIN_WINDOW_ID) {
    void updatePrefs({ windowBounds: { ...($prefs.get().windowBounds ?? {}), [win.appId]: clamped } })
  }
}

/** Keep maximized windows (and the main window) glued to the desktop area on resize. */
export function relayoutOnResize(): void {
  const area = desktopArea()
  const next: Record<string, OSWindow> = {}

  for (const [id, win] of Object.entries($windows.get())) {
    next[id] = win.maximized ? { ...win, bounds: area } : { ...win, bounds: clamp(win.bounds) }
  }

  $windows.set(next)
}

export function openFloating(appId: FloatingAppId, payload?: Record<string, unknown>, title?: string): string {
  return openApp(appId, { payload, title })
}

export const $runningAppIds = computed($windows, windows => new Set(Object.values(windows).map(w => w.appId)))
