import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WmState, WmWindow } from '../../shared/ipc.ts'
import { dockMenuBounds, dockMenuWindow, freshWindow } from './dock-menu.ts'
import { DOCK_MENU_TITLE } from './mode.ts'

interface MadeWindow extends EventEmitter {
  options: unknown
  menuRemoved: boolean
  webContents: EventEmitter & { handler?: () => unknown }
}

const fake = vi.hoisted(() => ({ windows: [] as unknown[] }))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')

  class FakeWindow extends Emitter {
    menuRemoved = false
    webContents = Object.assign(new Emitter(), {
      handler: undefined as (() => unknown) | undefined,
      setWindowOpenHandler(handler: () => unknown) {
        this.handler = handler
      }
    })

    constructor(readonly options: unknown) {
      super()
      fake.windows.push(this)
    }

    removeMenu() {
      this.menuRemoved = true
    }
  }

  return { BrowserWindow: FakeWindow }
})

const asked = { url: 'about:blank', frameName: 'herald-dock-menu-3', features: 'popup,left=724,top=905,width=264,height=107' }

describe('where a Dock menu’s window goes', () => {
  it('reads its place and size from the features, in whole pixels', () => {
    expect(dockMenuBounds(asked.features)).toEqual({ x: 724, y: 905, width: 264, height: 107 })
    expect(dockMenuBounds(' left = 10.4 , top=-6.6,width=264,height=147.5 ')).toEqual({ x: 10, y: -7, width: 264, height: 148 })
  })

  it('refuses features that do not give all four, or a size no menu has', () => {
    expect(dockMenuBounds('popup,left=1,top=2,width=264')).toBeNull()
    expect(dockMenuBounds('popup,left=,top=2,width=264,height=107')).toBeNull()
    expect(dockMenuBounds('popup,left=a,top=2,width=264,height=107')).toBeNull()
    expect(dockMenuBounds('popup,left=1,top=2,width=0,height=107')).toBeNull()
    expect(dockMenuBounds('popup,left=1,top=2,width=264,height=99999')).toBeNull()
  })
})

describe('the Dock menu’s window', () => {
  beforeEach(() => {
    fake.windows = []
  })

  it('leaves every other window to the caller', () => {
    expect(dockMenuWindow({ ...asked, url: 'https://example.com/' }, () => undefined)).toBeNull()
    expect(dockMenuWindow({ ...asked, frameName: 'herald-slides-audience' }, () => undefined)).toBeNull()
    expect(dockMenuWindow({ ...asked, frameName: 'herald-dock-menu' }, () => undefined)).toBeNull()
    expect(dockMenuWindow({ ...asked, frameName: 'herald-dock-menu-3x' }, () => undefined)).toBeNull()
  })

  it('is refused without a place and size', () => {
    expect(dockMenuWindow({ ...asked, features: 'popup' }, () => undefined)).toEqual({ action: 'deny' })
  })

  it('opens at the size asked, transparent and frameless, under the title niri’s rule matches, with safe preferences and no preload', () => {
    const answer = dockMenuWindow(asked, () => undefined)

    expect(answer).toMatchObject({ action: 'allow', outlivesOpener: false })
    expect(answer?.overrideBrowserWindowOptions).toMatchObject({ width: 264, height: 107, title: DOCK_MENU_TITLE, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, skipTaskbar: true })
    expect(answer?.overrideBrowserWindowOptions?.webPreferences).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false })
  })

  it('opens nothing more, goes nowhere, keeps its title, and is handed over with where it goes', () => {
    const opened = vi.fn()
    const answer = dockMenuWindow(asked, opened)
    const contents = answer?.createWindow?.({ ...answer.overrideBrowserWindowOptions })
    const win = fake.windows[0] as MadeWindow
    const navigation = { preventDefault: vi.fn() }
    const title = { preventDefault: vi.fn() }

    expect(contents).toBe(win.webContents)
    expect(win.menuRemoved).toBe(true)
    expect(win.webContents.handler?.()).toEqual({ action: 'deny' })
    win.webContents.emit('will-navigate', navigation, 'https://example.com/')
    win.emit('page-title-updated', title, 'about:blank')
    expect(navigation.preventDefault).toHaveBeenCalled()
    expect(title.preventDefault).toHaveBeenCalled()
    expect(opened).toHaveBeenCalledWith(win, { x: 724, y: 905, width: 264, height: 107 })
  })
})

describe('the niri window a new menu became', () => {
  const win = (id: number, title: string, ours = true): WmWindow => ({ id, title, appId: 'herald-os', pid: 1, workspaceId: 1, focused: false, floating: true, urgent: false, ours })
  const state = (windows: WmWindow[]): WmState => ({ available: true, windows, workspaces: [], focusedWindowId: null })

  it('is the newest of ours with its title that was not there before', () => {
    const windows = [win(3, DOCK_MENU_TITLE), win(8, DOCK_MENU_TITLE), win(6, DOCK_MENU_TITLE), win(9, 'Herald OS · Dock'), win(12, DOCK_MENU_TITLE, false)]

    expect(freshWindow(state(windows), DOCK_MENU_TITLE, new Set([3]))?.id).toBe(8)
    expect(freshWindow(state(windows), DOCK_MENU_TITLE, new Set([3, 6, 8]))).toBeNull()
  })
})
