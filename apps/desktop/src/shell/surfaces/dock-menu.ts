import type { WmState } from '../../../shared/ipc.ts'

/*
 * Panels mode: the Dock's menu for a running app (its windows, Close, Close all). The Dock's window is
 * 84 px tall, too short to hold it, so the menu opens in a window of its own above the Dock, which the
 * Dock opens on an empty page and draws into (DockMenu.tsx). Main sizes that window as asked and moves
 * it over the icon through niri (electron/shell/dock-menu.ts) before anything is drawn in it.
 * Lengths are CSS pixels, which are niri's logical pixels here: the session zooms no page under niri.
 */

/** The titles main gives the Dock's window and its menu's (electron/shell/mode.ts). */
export const DOCK_TITLE = 'Herald OS · Dock'
export const DOCK_MENU_TITLE = 'Herald OS · Dock Menu'
/** Each menu's window opens under this name and a number of its own; main lets only those open. */
export const DOCK_MENU_NAME = 'herald-dock-menu'
/** Room around the menu in its window for its shadow. */
export const DOCK_MENU_PAD = 12

/** The menu is w-60. */
const MENU_WIDTH = 240
/** Between the menu and the Dock's bar: the window's bottom pad reaches over the bar's top padding. */
const GAP = 6
/** A row (h-8); the menu's padding and border, top and bottom (p-1, 1 px); the divider (my-1, 1 px). */
const ROW = 32
const FRAME = 10
const DIVIDER = 9
/** The menu stays under the menu bar's 30 px strip, with a margin. */
const TOP = 38

export interface Size {
  width: number
  height: number
}

export interface Rect extends Size {
  x: number
  y: number
}

export interface DockMenuPlacement {
  /** The menu's window on the output. */
  window: Rect
  /** The most the list of windows may take; it scrolls past that. */
  listHeight: number
}

/** How tall the menu is for `count` windows: a row each, a divider, Close, and Close all for more than one. */
export function dockMenuHeight(count: number): number {
  return FRAME + count * ROW + DIVIDER + ROW + (count > 1 ? ROW : 0)
}

/** Where the Dock's window is on its output: as niri reports it, else where its window rule puts it, bottom centre. */
export function dockRect(wm: WmState, size: Size, screen: Size): Rect {
  const layout = wm.windows.find(win => win.ours && win.title === DOCK_TITLE)?.layout

  if (layout && layout.x !== null && layout.y !== null) {
    return { x: layout.x, y: layout.y, width: layout.width, height: layout.height }
  }

  return { x: (screen.width - size.width) / 2, y: screen.height - size.height, ...size }
}

/**
 * Where the menu for a Dock icon opens: centred over the icon (`iconX` across the Dock's window), just
 * above the bar (`barTop` down it), on screen and under the menu bar. On a screen too short for every
 * window, the list is cut to the room there is and scrolls.
 */
export function dockMenuPlacement({ iconX, barTop, dock, screen, count }: { iconX: number; barTop: number; dock: Rect; screen: Size; count: number }): DockMenuPlacement {
  const fixed = dockMenuHeight(count) - count * ROW
  const menuBottom = Math.round(dock.y + barTop) - GAP
  const listHeight = Math.max(ROW, Math.min(count * ROW, menuBottom - TOP - fixed))
  const width = MENU_WIDTH + 2 * DOCK_MENU_PAD
  const height = fixed + listHeight + 2 * DOCK_MENU_PAD
  const x = Math.round(dock.x + iconX - width / 2)

  return {
    window: { x: Math.min(Math.max(x, 0), Math.max(0, screen.width - width)), y: menuBottom + DOCK_MENU_PAD - height, width, height },
    listHeight
  }
}

/** What `window.open` asks for the menu's window with: where it goes and its size. */
export function dockMenuFeatures({ x, y, width, height }: Rect): string {
  return `popup,left=${x},top=${y},width=${width},height=${height}`
}

/** Whether the keys are with a window other than the Dock and its menu, or with none. */
export function keysLeftDock(wm: WmState): boolean {
  const focused = wm.windows.find(win => win.id === wm.focusedWindowId)

  return !focused?.ours || (focused.title !== DOCK_TITLE && focused.title !== DOCK_MENU_TITLE)
}

/**
 * Whether the menu closes as niri reports `wm`, the keys having last been with `previous`: they went
 * somewhere new that is neither the Dock nor the menu, as a menu closes when its app loses the keys.
 */
export function menuLosesKeys(previous: number | null, wm: WmState): boolean {
  return wm.focusedWindowId !== previous && keysLeftDock(wm)
}

/** The item a key moves the highlight to among `count` (from `index`, -1 for none); null for a key that does not move it. */
export function nextItem(index: number, count: number, key: string): number | null {
  if (count === 0) {
    return null
  }

  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : (index + 1) % count
    case 'ArrowUp':
      return index < 0 ? count - 1 : (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
