import type { BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIENCE_WINDOW_NAME, audienceWindow } from './presenter.ts'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface MadeWindow extends EventEmitter {
  options: unknown
  destroyed: boolean
  menuRemoved: boolean
  webContents: EventEmitter & { handler?: () => unknown }
}

const fake = vi.hoisted(() => ({ displays: [] as { id: number; bounds: Rect }[], windows: [] as unknown[] }))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const inside = (rect: Rect, { bounds }: { bounds: Rect }) => rect.x >= bounds.x && rect.x < bounds.x + bounds.width && rect.y >= bounds.y && rect.y < bounds.y + bounds.height

  class FakeWindow extends Emitter {
    destroyed = false
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

    isDestroyed() {
      return this.destroyed
    }

    close() {
      this.destroyed = true
      this.emit('closed')
    }
  }

  return {
    BrowserWindow: FakeWindow,
    screen: {
      getAllDisplays: () => fake.displays,
      getDisplayMatching: (rect: Rect) => fake.displays.find(display => inside(rect, display)) ?? fake.displays[0]
    }
  }
})

const LAPTOP = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } }
const PROJECTOR = { id: 2, bounds: { x: 1512, y: 0, width: 1920, height: 1080 } }

function openerOn(bounds: Rect) {
  return Object.assign(new EventEmitter(), { getBounds: () => bounds })
}

const asked = { url: 'about:blank', frameName: AUDIENCE_WINDOW_NAME }

describe('the audience window', () => {
  beforeEach(() => {
    fake.displays = [LAPTOP, PROJECTOR]
    fake.windows = []
  })

  it('leaves every other window to the caller', () => {
    const opener = openerOn(LAPTOP.bounds) as unknown as BrowserWindow

    expect(audienceWindow(opener, { url: 'https://example.com/', frameName: '' })).toBe(null)
    expect(audienceWindow(opener, { url: 'about:blank', frameName: 'other' })).toBe(null)
    expect(audienceWindow(opener, { url: 'https://example.com/', frameName: AUDIENCE_WINDOW_NAME })).toBe(null)
  })

  it('is refused when there is no other display', () => {
    fake.displays = [LAPTOP]

    expect(audienceWindow(openerOn(LAPTOP.bounds) as unknown as BrowserWindow, asked)).toEqual({ action: 'deny' })
  })

  it('opens full screen on a display other than the opener, frameless and black, with safe preferences and no preload', () => {
    const answer = audienceWindow(openerOn({ x: 1600, y: 40, width: 1200, height: 800 }) as unknown as BrowserWindow, asked)

    expect(answer).toMatchObject({ action: 'allow', outlivesOpener: false })
    expect(answer?.overrideBrowserWindowOptions).toMatchObject({ ...LAPTOP.bounds, frame: false, fullscreen: true, backgroundColor: '#000000' })
    expect(answer?.overrideBrowserWindowOptions?.webPreferences).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false })
  })

  it('opens nothing more, goes nowhere, keeps its title and closes with its opener', () => {
    const opener = openerOn(LAPTOP.bounds)
    const answer = audienceWindow(opener as unknown as BrowserWindow, asked)
    const contents = answer?.createWindow?.({ ...answer.overrideBrowserWindowOptions })
    const win = fake.windows[0] as MadeWindow
    const navigation = { preventDefault: vi.fn() }
    const title = { preventDefault: vi.fn() }

    expect(answer?.overrideBrowserWindowOptions).toMatchObject(PROJECTOR.bounds)
    expect(contents).toBe(win.webContents)
    expect(win.menuRemoved).toBe(true)
    expect(win.webContents.handler?.()).toEqual({ action: 'deny' })

    win.webContents.emit('will-navigate', navigation, 'https://example.com/')
    win.emit('page-title-updated', title, 'Other')
    expect(navigation.preventDefault).toHaveBeenCalled()
    expect(title.preventDefault).toHaveBeenCalled()

    opener.emit('closed')
    expect(win.destroyed).toBe(true)
    expect(opener.listenerCount('closed')).toBe(0)
  })
})
