import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { WmState, WmWindow } from '../../../shared/ipc.ts'
import { DOCK_MENU_TITLE, DOCK_TITLE, dockMenuFeatures, dockMenuHeight, dockMenuPlacement, dockRect, keysLeftDock, menuLosesKeys, nextItem, type Rect } from './dock-menu.ts'

const SCREEN = { width: 1920, height: 1080 }
/** Where niri puts the 720 x 84 Dock on that screen (from the issue's `niri msg -j windows`). */
const DOCK: Rect = { x: 600, y: 996, width: 720, height: 84 }
/** The bar's top in the Dock's window: 84 - 4 (pb-1) - 70 (py-2, a 52 px item, the glass border). */
const BAR_TOP = 10
const MIDDLE = DOCK.width / 2

const win = (id: number, title: string, ours = true, overrides: Partial<WmWindow> = {}): WmWindow => ({ id, title, appId: ours ? 'herald-os' : 'firefox', pid: 1, workspaceId: 1, focused: false, floating: true, urgent: false, ours, ...overrides })
const DOCK_WINDOW = win(2, DOCK_TITLE, true, { layout: { width: 720, height: 84, x: 600, y: 996, column: null, tile: null, tileWidth: 720, tileHeight: 84 } })
const MENU_WINDOW = win(9, DOCK_MENU_TITLE)
const FIREFOX = win(4, 'Mozilla Firefox', false)

function state(focusedWindowId: number | null, windows: WmWindow[] = [DOCK_WINDOW, MENU_WINDOW, FIREFOX]): WmState {
  return { available: true, windows, workspaces: [], focusedWindowId }
}

const place = (iconX: number, count: number, dock = DOCK, screen = SCREEN) => dockMenuPlacement({ iconX, barTop: BAR_TOP, dock, screen, count })

describe('the Dock menu’s height', () => {
  it('has a row for each window, a divider, Close, and Close all for more than one', () => {
    expect(dockMenuHeight(1)).toBe(83)
    expect(dockMenuHeight(2)).toBe(147)
    expect(dockMenuHeight(5)).toBe(243)
  })
})

describe('where the Dock is', () => {
  it('is where niri reports its window', () => {
    expect(dockRect(state(null), { width: 720, height: 84 }, SCREEN)).toEqual(DOCK)
  })

  it('is at the bottom in the middle, where its rule puts it, when niri gives no position', () => {
    const unplaced = state(null, [win(2, DOCK_TITLE), win(3, DOCK_TITLE, false, { layout: DOCK_WINDOW.layout })])

    expect(dockRect(unplaced, { width: 720, height: 84 }, { width: 2560, height: 1440 })).toEqual({ x: 920, y: 1356, width: 720, height: 84 })
  })
})

describe('where the Dock menu opens', () => {
  it('stands over the icon with its shadow room around it, just above the bar', () => {
    const { window, listHeight } = place(MIDDLE - 104, 1)

    expect(window).toEqual({ x: 724, y: 905, width: 264, height: 107 })
    // The menu itself (12 px in from the window's edges) ends 6 px above the bar.
    expect(window.y + window.height - 12).toBe(DOCK.y + BAR_TOP - 6)
    expect(listHeight).toBe(32)
  })

  it('opens over the middle icon exactly where niri’s rule puts the window, so it need not move', () => {
    const config = fs.readFileSync(new URL('../../../../../linux/niri/config.kdl', import.meta.url), 'utf8')
    const rule = config.slice(config.indexOf(`title="^${DOCK_MENU_TITLE}$"`))
    const [, x, y] = /default-floating-position x=(\d+) y=(\d+) relative-to="bottom"/.exec(rule) ?? []

    for (const count of [1, 2, 7]) {
      const { window } = place(MIDDLE, count)

      expect(window.x).toBe((SCREEN.width - window.width) / 2 + Number(x))
      expect(SCREEN.height - window.y - window.height).toBe(Number(y))
    }
  })

  it('grows upwards with the windows it lists', () => {
    const one = place(MIDDLE, 1).window
    const three = place(MIDDLE, 3).window

    expect(three.y + three.height).toBe(one.y + one.height)
    expect(three.height - one.height).toBe(dockMenuHeight(3) - dockMenuHeight(1))
  })

  it('stays on a screen narrower than the Dock', () => {
    const narrow = { width: 800, height: 600 }
    const dock = { x: 40, y: 516, width: 720, height: 84 }

    expect(place(40, 1, dock, narrow).window.x).toBe(0)
    expect(place(680, 1, dock, narrow).window.x).toBe(800 - 264)
  })

  it('cuts a long list of windows to the room under the menu bar, which then scrolls', () => {
    const laptop = { width: 1366, height: 768 }
    const dock = { x: 323, y: 684, width: 720, height: 84 }
    const { window, listHeight } = place(MIDDLE, 30, dock, laptop)

    expect(listHeight).toBe(567)
    // The menu's top is 8 px under the menu bar's 30, and its bottom still just above the bar.
    expect(window.y + 12).toBe(38)
    expect(window.y + window.height - 12).toBe(dock.y + BAR_TOP - 6)
  })

  it('keeps one window’s row on a screen too short for even that', () => {
    expect(place(MIDDLE, 4, { x: 0, y: 116, width: 720, height: 84 }, { width: 720, height: 200 }).listHeight).toBe(32)
  })

  it('lands on whole pixels on a scaled output, whose positions niri gives as fractions', () => {
    const { window } = place(MIDDLE - 52.4, 2, { x: 600.2, y: 995.6, width: 720, height: 84 })

    for (const value of Object.values(window)) {
      expect(Number.isInteger(value)).toBe(true)
    }
  })

  it('asks window.open for that place and size', () => {
    expect(dockMenuFeatures({ x: 724, y: 905, width: 264, height: 107 })).toBe('popup,left=724,top=905,width=264,height=107')
  })
})

describe('when the Dock menu closes', () => {
  it('stays while the keys are with the Dock or move to the menu', () => {
    expect(keysLeftDock(state(DOCK_WINDOW.id))).toBe(false)
    expect(menuLosesKeys(DOCK_WINDOW.id, state(MENU_WINDOW.id))).toBe(false)
    expect(menuLosesKeys(MENU_WINDOW.id, state(DOCK_WINDOW.id))).toBe(false)
  })

  it('closes once the keys go to another window, to none, or to someone else’s window with the Dock’s title', () => {
    expect(menuLosesKeys(DOCK_WINDOW.id, state(FIREFOX.id))).toBe(true)
    expect(menuLosesKeys(MENU_WINDOW.id, state(null))).toBe(true)
    expect(menuLosesKeys(DOCK_WINDOW.id, state(5, [DOCK_WINDOW, win(5, DOCK_TITLE, false)]))).toBe(true)
  })

  it('waits for the keys to move: they may not have reached the Dock as the right-click opened it', () => {
    expect(menuLosesKeys(FIREFOX.id, state(FIREFOX.id))).toBe(false)
    expect(menuLosesKeys(FIREFOX.id, state(DOCK_WINDOW.id))).toBe(false)
  })
})

describe('the highlight', () => {
  it('starts at the first item going down and the last going up, and wraps', () => {
    expect(nextItem(-1, 3, 'ArrowDown')).toBe(0)
    expect(nextItem(-1, 3, 'ArrowUp')).toBe(2)
    expect(nextItem(2, 3, 'ArrowDown')).toBe(0)
    expect(nextItem(0, 3, 'ArrowUp')).toBe(2)
    expect(nextItem(1, 3, 'Home')).toBe(0)
    expect(nextItem(1, 3, 'End')).toBe(2)
  })

  it('leaves other keys, and an empty menu, alone', () => {
    expect(nextItem(1, 3, 'a')).toBeNull()
    expect(nextItem(-1, 0, 'ArrowDown')).toBeNull()
  })
})

describe('the titles', () => {
  it('are the ones main gives the Dock and its menu, which niri’s rules match', () => {
    const mode = fs.readFileSync(new URL('../../../electron/shell/mode.ts', import.meta.url), 'utf8')

    expect(mode).toContain(`dock: '${DOCK_TITLE}'`)
    expect(mode).toContain(`DOCK_MENU_TITLE = '${DOCK_MENU_TITLE}'`)
  })
})
