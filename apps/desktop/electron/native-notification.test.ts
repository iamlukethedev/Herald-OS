import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ constructed: 0, shown: [] as Array<{ title: string; body: string; silent?: boolean }> }))

vi.mock('electron', () => {
  class Notification {
    static isSupported = () => true
    constructor(private readonly options: { title: string; body: string; silent?: boolean }) {
      electron.constructed += 1
    }
    on() {
      return this
    }
    show() {
      electron.shown.push(this.options)
    }
  }

  return { Notification, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() } }
})
vi.mock('./log.ts', () => ({ log: vi.fn() }))

const dbus = await import('dbus-next')
const wire = (await import('dbus-next/lib/message.js' as string)) as { marshall: (message: unknown) => [Buffer, number[]] }
const { desktopEntry, DesktopNotifyClient, nativeNotifier, notifyMessage, NOTIFY_TIMEOUT_MS } = await import('./native-notification.ts')

beforeEach(() => {
  electron.constructed = 0
  electron.shown = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('nativeNotifier on Linux', () => {
  it('never uses Electron notifications, whose libnotify calls block the main thread', async () => {
    const sendDesktop = vi.fn(async () => undefined)
    const notify = nativeNotifier({ platform: 'linux', shellServes: () => false, sendDesktop })

    await notify('Approval needed', 'Hermes is asking for permission')

    expect(electron.constructed).toBe(0)
    expect(sendDesktop).toHaveBeenCalledWith({ title: 'Approval needed', body: 'Hermes is asking for permission' })
  })

  it('sends nothing when Herald serves the notification bus itself, which would answer only once main is free', async () => {
    const sendDesktop = vi.fn(async () => undefined)
    const notify = nativeNotifier({ platform: 'linux', shellServes: () => true, sendDesktop })

    await notify('Approval needed', 'Hermes is asking for permission')

    expect(sendDesktop).not.toHaveBeenCalled()
    expect(electron.constructed).toBe(0)
  })

  it('returns to the event loop while the notification server has not answered', async () => {
    const notify = nativeNotifier({ platform: 'linux', shellServes: () => false, sendDesktop: () => new Promise<void>(() => undefined) })
    let ticked = false
    const timer = new Promise<void>(resolve =>
      setTimeout(() => {
        ticked = true
        resolve()
      }, 0)
    )

    const pending = notify('Approval needed', 'Hermes is asking for permission')
    await timer

    expect(ticked).toBe(true)
    expect(pending).toBeInstanceOf(Promise)
  })

  it('keeps a failed send to the log', async () => {
    const notify = nativeNotifier({ platform: 'linux', shellServes: () => false, sendDesktop: async () => Promise.reject(new Error('no server')) })

    await expect(notify('Approval needed', 'body')).resolves.toBeUndefined()
  })

  it('cuts the title and body as before', async () => {
    const sendDesktop = vi.fn(async () => undefined)

    await nativeNotifier({ platform: 'linux', shellServes: () => false, sendDesktop })('t'.repeat(200), 'b'.repeat(600))

    expect(sendDesktop).toHaveBeenCalledWith({ title: 't'.repeat(120), body: 'b'.repeat(400) })
  })
})

describe('nativeNotifier elsewhere', () => {
  it('shows an Electron notification on macOS, silent and cut to size', async () => {
    const sendDesktop = vi.fn(async () => undefined)

    await nativeNotifier({ platform: 'darwin', shellServes: () => false, sendDesktop })('Approval needed', 'b'.repeat(600))

    expect(sendDesktop).not.toHaveBeenCalled()
    expect(electron.shown).toEqual([{ title: 'Approval needed', body: 'b'.repeat(400), silent: true }])
  })
})

describe('notifyMessage', () => {
  it('is the Desktop Notifications spec Notify call, without sound', () => {
    const message = notifyMessage({ title: 'Approval needed', body: 'Hermes is asking for permission' })

    expect(message).toMatchObject({ destination: 'org.freedesktop.Notifications', path: '/org/freedesktop/Notifications', interface: 'org.freedesktop.Notifications', member: 'Notify', signature: 'susssasa{sv}i' })
    expect(message.body.slice(0, 6)).toEqual(['Herald OS', 0, '', 'Approval needed', 'Hermes is asking for permission', []])
    expect(message.body[6]['suppress-sound'].value).toBe(true)
    expect(message.body[7]).toBe(-1)
  })

  it('does not start a notification server that is not running', () => {
    expect(notifyMessage({ title: 't', body: 'b' }).flags & dbus.MessageFlag.NO_AUTO_START).toBe(dbus.MessageFlag.NO_AUTO_START)
  })

  it("carries the hints Electron's libnotify path sent, for the icon and grouping", () => {
    const hints = notifyMessage({ title: 't', body: 'b' }, { entry: 'herald-os', pid: 4242 }).body[6]

    expect(hints['desktop-entry']).toMatchObject({ signature: 's', value: 'herald-os' })
    expect(hints['sender-pid']).toMatchObject({ signature: 'x', value: 4242 })
  })

  it('names this process as the sender by default, and leaves out an unknown desktop entry', () => {
    const hints = notifyMessage({ title: 't', body: 'b' }, { entry: null }).body[6]

    expect(hints['sender-pid'].value).toBe(process.pid)
    expect(hints).not.toHaveProperty('desktop-entry')
  })

  it('marshals onto the wire with the flag in its header', () => {
    const message = notifyMessage({ title: 't', body: 'b' }, { entry: 'herald-os', pid: 4242 })
    message.serial = 1
    const [bytes] = wire.marshall(message)

    expect(bytes[2]).toBe(dbus.MessageFlag.NO_AUTO_START)
  })
})

describe('desktopEntry', () => {
  it('is CHROME_DESKTOP without .desktop, as Electron derives it', () => {
    expect(desktopEntry({ CHROME_DESKTOP: 'herald-os.desktop' })).toBe('herald-os')
    expect(desktopEntry({ CHROME_DESKTOP: 'Herald OS.desktop' })).toBe('Herald OS')
    expect(desktopEntry({})).toBeNull()
    expect(desktopEntry({ CHROME_DESKTOP: ' ' })).toBeNull()
  })
})

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)

    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : []
  })
}

describe('the main process and preload', () => {
  const root = path.dirname(fileURLToPath(import.meta.url))

  it('create Electron notifications only in native-notification.ts', () => {
    const offenders = sources(root).filter(file => path.basename(file) !== 'native-notification.ts' && /new Notification\(|\bNotification\b[^'\n]*\} from 'electron'/.test(fs.readFileSync(file, 'utf8')))

    expect(offenders.map(file => path.relative(root, file))).toEqual([])
  })

  it('never wait on main with synchronous IPC', () => {
    const offenders = sources(path.join(root, '..', 'preload')).filter(file => /\bsendSync\(/.test(fs.readFileSync(file, 'utf8')))

    expect(offenders).toEqual([])
  })
})

function fakeBus(call: () => Promise<unknown>) {
  return { call: vi.fn(call), on: vi.fn(), disconnect: vi.fn() }
}

describe('DesktopNotifyClient', () => {
  it('sends one Notify over one connection', async () => {
    const bus = fakeBus(async () => null)
    const connect = vi.fn(() => bus as never)
    const client = new DesktopNotifyClient(connect)

    await client.notify({ title: 'a', body: 'b' })
    await client.notify({ title: 'c', body: 'd' })

    expect(connect).toHaveBeenCalledTimes(1)
    expect(bus.call).toHaveBeenCalledTimes(2)
    expect(bus.on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('gives up on a server that does not answer, and connects again next time', async () => {
    vi.useFakeTimers()
    const silent = fakeBus(() => new Promise(() => undefined))
    const answering = fakeBus(async () => null)
    const connect = vi.fn().mockReturnValueOnce(silent).mockReturnValueOnce(answering)
    const client = new DesktopNotifyClient(connect)

    const first = client.notify({ title: 'a', body: 'b' })
    const failed = expect(first).rejects.toThrow(/no answer/)
    await vi.advanceTimersByTimeAsync(NOTIFY_TIMEOUT_MS)
    await failed

    expect(silent.disconnect).toHaveBeenCalled()
    await client.notify({ title: 'c', body: 'd' })
    expect(connect).toHaveBeenCalledTimes(2)
    expect(answering.call).toHaveBeenCalledTimes(1)
  })
})
