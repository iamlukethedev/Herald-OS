import { afterEach, describe, expect, it, vi } from 'vitest'
import { catchUncaught, describeError, logFailure } from './report.ts'

/** A window that only keeps its listeners, so that a test can hand them events. */
function fakeWindow() {
  const listeners = new Map<string, (event: Event) => void>()
  const added: string[] = []
  const target = {
    addEventListener(type: string, listener: (event: Event) => void) {
      added.push(type)
      listeners.set(type, listener)
    }
  }

  return { target: target as unknown as Window, added, fire: (type: string, event: Event) => listeners.get(type)?.(event) }
}

const uncaught = (fields: Partial<ErrorEvent>) => Object.assign(new Event('error', { cancelable: true }), { error: undefined, message: '', filename: '', lineno: 0, colno: 0, ...fields })
const rejection = (reason: unknown) => Object.assign(new Event('unhandledrejection', { cancelable: true }), { reason })
const reports = () => vi.spyOn(console, 'error').mockImplementation(() => undefined)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('describeError', () => {
  it('gives an error its name, its message and the frames of its stack', () => {
    const lines = describeError(new TypeError('x is not a function')).split('\n')

    expect(lines[0]).toBe('TypeError: x is not a function')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.slice(1).every(line => /^\s+at /.test(line))).toBe(true)
    expect(lines.join('\n')).toContain('report.test.ts')
  })

  it('reads a message changed after the error was made', () => {
    const error = new Error('Failed')
    error.message = 'Failed to read the system info'

    expect(describeError(error).split('\n')[0]).toBe('Error: Failed to read the system info')
  })

  it('reads an error from the preload bridge, which crosses without frames', () => {
    const error = new Error("Error invoking remote method 'herald-os:system:info': Error: boom")
    error.stack = `Error: ${error.message}`

    expect(describeError(error)).toBe("Error: Error invoking remote method 'herald-os:system:info': Error: boom")
  })

  it('prints any other value as it is', () => {
    expect(describeError('timed out')).toBe('timed out')
    expect(describeError({ code: -32000, message: 'busy' })).toBe('{"code":-32000,"message":"busy"}')
    expect(describeError(Object.create(null))).toBe('{}')
    expect(describeError(undefined)).toBe('undefined')
    expect(describeError(null)).toBe('null')
  })

  it('never throws, whatever it is handed', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const guarded = new Error('guarded')
    Object.defineProperty(guarded, 'stack', {
      get() {
        throw new Error('no stack here')
      }
    })

    expect(describeError(circular)).toBe('an error that could not be read')
    expect(describeError(guarded)).toBe('an error that could not be read')
  })
})

describe('logFailure', () => {
  it('names the call that failed, then says why', () => {
    const report = reports()

    logFailure('system.info')(new Error('boom'))

    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0][0]).toMatch(/^\[herald-os\] system\.info failed: Error: boom\n\s+at /)
  })
})

describe('catchUncaught', () => {
  it('reports an uncaught error with its stack, instead of the line Chromium writes', () => {
    const report = reports()
    const win = fakeWindow()
    catchUncaught(win.target)
    const event = uncaught({ error: new Error('probe'), message: 'Uncaught Error: probe', filename: 'http://127.0.0.1:5180/src/main.tsx', lineno: 9, colno: 30 })

    win.fire('error', event)

    expect(report).toHaveBeenCalledOnce()
    expect(report.mock.calls[0][0]).toMatch(/^\[herald-os\] uncaught exception: Error: probe\n\s+at /)
    expect(event.defaultPrevented).toBe(true)
  })

  it('says where a thrown value without a stack came from', () => {
    const report = reports()
    const win = fakeWindow()
    catchUncaught(win.target)

    win.fire('error', uncaught({ error: 'oops', message: 'Uncaught oops', filename: 'http://127.0.0.1:5180/src/shell/Dock.tsx', lineno: 4, colno: 2 }))
    win.fire('error', uncaught({ error: null, message: 'Script error.' }))

    expect(report.mock.calls.map(call => call[0])).toEqual(['[herald-os] uncaught exception: oops (http://127.0.0.1:5180/src/shell/Dock.tsx:4:2)', '[herald-os] uncaught exception: Script error.'])
  })

  it('silences the note Chromium raises when ResizeObserver holds notifications over to the next frame', () => {
    const report = reports()
    const win = fakeWindow()
    catchUncaught(win.target)
    const event = uncaught({ error: null, message: 'ResizeObserver loop completed with undelivered notifications.' })

    win.fire('error', event)

    expect(report).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('reports an unhandled rejection with its reason', () => {
    const report = reports()
    const win = fakeWindow()
    catchUncaught(win.target)
    const event = rejection(new Error("Error invoking remote method 'herald-os:system:info': Error: boom"))

    win.fire('unhandledrejection', event)

    expect(report.mock.calls[0][0]).toMatch(/^\[herald-os\] unhandled rejection: Error: Error invoking remote method 'herald-os:system:info': Error: boom/)
    expect(event.defaultPrevented).toBe(true)
  })

  it('listens once per window, however often it is installed', () => {
    const win = fakeWindow()

    catchUncaught(win.target)
    catchUncaught(win.target)

    expect(win.added).toEqual(['error', 'unhandledrejection'])
  })

  it('cannot throw, and leaves to Chromium what it cannot report', () => {
    const win = fakeWindow()
    catchUncaught(win.target)
    const unreadable = new Event('error', { cancelable: true })
    const report = reports()

    expect(() => win.fire('error', unreadable)).not.toThrow()
    expect(report).not.toHaveBeenCalled()
    expect(unreadable.defaultPrevented).toBe(false)

    report.mockImplementation(() => {
      throw new Error('no console')
    })
    const event = uncaught({ error: new Error('probe') })
    const refused = rejection('timed out')

    expect(() => win.fire('error', event)).not.toThrow()
    expect(() => win.fire('unhandledrejection', refused)).not.toThrow()
    expect(event.defaultPrevented).toBe(false)
    expect(refused.defaultPrevented).toBe(false)
  })
})
