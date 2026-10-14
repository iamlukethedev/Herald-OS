import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ lines: [] as string[], shell: 'file:///herald/dist/renderer/index.html' }))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')

  return { app: new Emitter() }
})
// The real log writes under HERMES_HOME; these tests only keep what would have been written.
vi.mock('./log.ts', () => ({ log: (scope: string, message: string) => fake.lines.push(`[${scope}] ${message}`) }))
vi.mock('./paths.ts', () => ({ isShellPage: (url: string) => url.startsWith(fake.shell) }))

import { app } from 'electron'
import { consoleLine, forwardRendererConsole, LineBudget, MAX_MESSAGE, PER_MINUTE, surfaceOf } from './renderer-console.ts'

const SHELL = fake.shell
const message = (fields: Record<string, unknown> = {}) => ({ level: 'error', message: '[herald-os] system.info failed: Error: boom', lineNumber: 41, sourceId: 'file:///herald/dist/renderer/assets/index-abc.js', ...fields })

/** A web contents as main sees it, announced the way Electron announces a new one. */
function contentsAt(page: string): EventEmitter {
  const contents = Object.assign(new EventEmitter(), { getURL: () => page })
  app.emit('web-contents-created', {}, contents)

  return contents
}

forwardRendererConsole()

beforeEach(() => {
  fake.lines.length = 0
})

describe('forwardRendererConsole', () => {
  it('copies the warnings and errors of a shell window, and nothing quieter', () => {
    const page = `${SHELL}?surface=dock`
    const contents = contentsAt(page)

    for (const level of ['debug', 'info', 'warning', 'error']) {
      contents.emit('console-message', { ...message({ level, message: `a line at ${level}` }), frame: { url: page } })
    }

    expect(fake.lines).toEqual(['[renderer] dock warning: a line at warning (index-abc.js:41)', '[renderer] dock error: a line at error (index-abc.js:41)'])
  })

  it('leaves out pages that are not the shell, and frames inside it', () => {
    contentsAt('https://accounts.example.com/login').emit('console-message', { ...message(), frame: { url: 'https://accounts.example.com/login' } })
    contentsAt(SHELL).emit('console-message', { ...message(), frame: { url: 'herald-plugin://weather/index.html' } })

    expect(fake.lines).toEqual([])
  })

  it('takes the page from the contents when the frame is not known', () => {
    contentsAt(SHELL).emit('console-message', { ...message(), frame: null })

    expect(fake.lines).toEqual(['[renderer] desktop error: [herald-os] system.info failed: Error: boom (index-abc.js:41)'])
  })

  it('says so once a minute when a window fails in a loop', () => {
    const contents = contentsAt(SHELL)

    for (let count = 0; count < PER_MINUTE + 5; count++) {
      contents.emit('console-message', { ...message({ message: `failure ${count}` }), frame: { url: SHELL } })
    }

    expect(fake.lines).toHaveLength(PER_MINUTE + 1)
    expect(fake.lines.at(-1)).toBe(`[renderer] desktop: more than ${PER_MINUTE} warnings and errors in a minute; the others from this minute are left out`)
  })

  it('cannot throw for a frame that went away as it logged', () => {
    const contents = contentsAt(SHELL)
    const details = {
      ...message(),
      get frame(): never {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
    }

    expect(() => contents.emit('console-message', details)).not.toThrow()
    expect(fake.lines).toEqual([])
  })
})

describe('surfaceOf', () => {
  it('names the window by the surface it draws', () => {
    expect(surfaceOf(`${SHELL}?surface=menubar`)).toBe('menubar')
    expect(surfaceOf('http://127.0.0.1:5180/?surface=window%3Asystem')).toBe('window:system')
    expect(surfaceOf(SHELL)).toBe('desktop')
    expect(surfaceOf('not an address')).toBe('desktop')
  })
})

describe('consoleLine', () => {
  it('says where a one-line message came from; a stack says it already', () => {
    expect(consoleLine('main', message({ sourceId: 'http://127.0.0.1:5180/src/lib/report.ts?t=1760400000000', lineNumber: 36 }))).toBe('main error: [herald-os] system.info failed: Error: boom (report.ts:36)')
    expect(consoleLine('main', message({ message: 'Error: boom\n    at load (index-abc.js:1:2)\n' }))).toBe('main error: Error: boom\n    at load (index-abc.js:1:2)')
    expect(consoleLine('main', message({ sourceId: '' }))).toBe('main error: [herald-os] system.info failed: Error: boom')
  })

  it('cuts a long message', () => {
    const line = consoleLine('main', message({ message: 'x'.repeat(MAX_MESSAGE * 3) }))

    expect(line.length).toBeLessThan(MAX_MESSAGE + 100)
    expect(line).toContain('x…')
  })
})

describe('LineBudget', () => {
  it('lets a window through until the budget for the minute is spent, says so once, and starts again the next minute', () => {
    let now = 0
    const budget = new LineBudget(3, () => now)

    expect(Array.from({ length: 6 }, () => budget.take())).toEqual(['log', 'log', 'log', 'full', 'drop', 'drop'])

    now = 59_999
    expect(budget.take()).toBe('drop')

    now = 60_000
    expect(budget.take()).toBe('log')
  })
})
